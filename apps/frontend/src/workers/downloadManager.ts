import { db, type DownloadTask } from '../db/schema';
import { ensureHeadroom, StorageQuotaError } from '../db/storage';
import { api } from '../api/client';
import type { PageDescriptor, WorkerCommand, WorkerEvent } from './downloadWorker';

/**
 * Main-thread side of the download queue.
 *
 * Auth lives here rather than in the worker. Page listings need a bearer token
 * and the token is refreshed on the main thread, so the manager resolves the
 * page URLs and hands the worker a plain list to fetch. Image requests
 * themselves are unauthenticated by design, which is what lets the worker do
 * the heavy lifting without ever seeing a credential.
 */

export type DownloadListener = (tasks: DownloadTask[]) => void;

/** Rough per-page estimate for the pre-flight storage check. */
const ESTIMATED_PAGE_BYTES = 420 * 1024;

export class DownloadManager {
  #worker: Worker | null = null;
  readonly #listeners = new Set<DownloadListener>();
  /** Page lists, kept so a resume does not have to re-hit the API. */
  readonly #pageCache = new Map<number, PageDescriptor[]>();
  #started = false;

  /** Lazily created: a reader who never downloads never pays for the worker. */
  #ensureWorker(): Worker {
    if (this.#worker) return this.#worker;

    this.#worker = new Worker(new URL('./downloadWorker.ts', import.meta.url), {
      type: 'module',
      name: 'comic-downloads',
    });

    this.#worker.onmessage = (event: MessageEvent<WorkerEvent>) => {
      void this.#handleEvent(event.data);
    };
    this.#worker.onerror = (event) => {
      console.error('[downloads] worker crashed:', event.message);
      // A crashed worker leaves running tasks stranded; mark them failed so
      // the UI offers a retry rather than showing a permanent spinner.
      void db.queue
        .where('status')
        .equals('running')
        .modify({ status: 'failed', error: 'download worker stopped unexpectedly' })
        .then(() => this.#notify());
    };

    return this.#worker;
  }

  #send(command: WorkerCommand): void {
    this.#ensureWorker().postMessage(command);
  }

  async #handleEvent(event: WorkerEvent): Promise<void> {
    if (event.type === 'failed' && event.error === 'QUOTA_EXCEEDED') {
      console.warn('[downloads] storage exhausted; pausing the queue');
      this.pauseAll();
    }
    await this.#notify();
  }

  subscribe(listener: DownloadListener): () => void {
    this.#listeners.add(listener);
    void this.#notify();
    return () => this.#listeners.delete(listener);
  }

  async #notify(): Promise<void> {
    const tasks = await db.queue.orderBy('queuedAt').toArray();
    for (const listener of this.#listeners) listener(tasks);
  }

  /**
   * Resume anything left over from a previous session.
   *
   * Called once at startup. Tasks recorded as `running` were interrupted by
   * the app closing, so they are demoted to `queued` and re-driven.
   */
  async restore(): Promise<void> {
    if (this.#started) return;
    this.#started = true;

    await db.queue.where('status').equals('running').modify({ status: 'queued' });

    const pending = await db.queue
      .filter((t) => t.status === 'queued' || t.status === 'paused')
      .toArray();

    for (const task of pending) {
      if (task.status === 'queued' && task.id !== undefined) {
        await this.#dispatch(task.id, task.chapterId).catch((err: unknown) => {
          console.warn('[downloads] could not resume task', task.id, err);
        });
      }
    }

    // Telegram suspends the WebView's JavaScript on background, which cuts any
    // in-flight fetch. Pausing first turns that into a clean pause rather than
    // a spurious failure the user has to retry.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.pauseAll();
    });

    await this.#notify();
  }

  /** Resolve a chapter's pages and hand them to the worker. */
  async #dispatch(taskId: number, chapterId: string): Promise<void> {
    let pages = this.#pageCache.get(taskId);

    if (!pages) {
      const response = await api.pages(chapterId);
      pages = response.pages.map((p) => ({
        id: p.id,
        index: p.index,
        // Downloads always take the screen variant: zoom is four times the
        // bytes for detail only visible while actively pinching, and it can be
        // fetched on demand when online.
        url: api.imageUrl(p.url, 'screen'),
        width: p.width,
        height: p.height,
      }));
      this.#pageCache.set(taskId, pages);
    }

    this.#send({ type: 'start', taskId, pages });
  }

  /**
   * Queue a chapter for offline reading.
   * Throws {@link StorageQuotaError} when there is not enough room.
   */
  async enqueueChapter(args: {
    chapterId: string;
    comicId: string;
    comicTitle: string;
    chapterTitle: string;
    pageCount: number;
  }): Promise<number> {
    const existing = await db.queue.where('chapterId').equals(args.chapterId).first();
    if (existing?.id !== undefined) {
      // Already queued. Restart it if it had failed; otherwise leave it be.
      if (existing.status === 'failed' || existing.status === 'paused') {
        await this.resume(existing.id);
      }
      return existing.id;
    }

    // Check before writing anything, so a doomed download never starts and
    // partially fills storage on its way to failing.
    const estimate = Math.max(1, args.pageCount) * ESTIMATED_PAGE_BYTES;
    await ensureHeadroom(estimate);

    const task: DownloadTask = {
      chapterId: args.chapterId,
      comicId: args.comicId,
      comicTitle: args.comicTitle,
      chapterTitle: args.chapterTitle,
      status: 'queued',
      completed: 0,
      total: args.pageCount,
      bytes: 0,
      attempts: 0,
      queuedAt: Date.now(),
      updatedAt: Date.now(),
    };

    const taskId = (await db.queue.add(task)) as number;
    await this.#dispatch(taskId, args.chapterId);
    await this.#notify();
    return taskId;
  }

  async pause(taskId: number): Promise<void> {
    this.#send({ type: 'pause', taskId });
    await db.queue.update(taskId, { status: 'paused', updatedAt: Date.now() });
    await this.#notify();
  }

  pauseAll(): void {
    this.#send({ type: 'pauseAll' });
  }

  async resume(taskId: number): Promise<void> {
    const task = await db.queue.get(taskId);
    if (!task) return;
    // `modify` so the previous error is deleted outright; assigning undefined
    // through `update` leaves the key in place with an undefined value.
    await db.queue.where('id').equals(taskId).modify((t) => {
      t.status = 'queued';
      t.updatedAt = Date.now();
      delete t.error;
    });
    await this.#dispatch(taskId, task.chapterId);
    await this.#notify();
  }

  async cancel(taskId: number): Promise<void> {
    this.#send({ type: 'cancel', taskId });
    this.#pageCache.delete(taskId);
    await db.queue.delete(taskId);
    await this.#notify();
  }

  /** Tear the worker down. Used by tests and on full app teardown. */
  dispose(): void {
    this.#worker?.terminate();
    this.#worker = null;
    this.#listeners.clear();
    this.#pageCache.clear();
    this.#started = false;
  }
}

export const downloads = new DownloadManager();
export { StorageQuotaError };
