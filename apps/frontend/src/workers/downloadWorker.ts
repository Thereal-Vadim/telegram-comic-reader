/// <reference lib="webworker" />

import { ComicDatabase, type DownloadTask } from '../db/schema';

/**
 * Chapter download worker.
 *
 * Runs off the main thread so that writing a few hundred blobs into IndexedDB
 * never competes with the reader's render loop. IndexedDB is available in
 * workers, so the worker owns its own Dexie connection rather than shuttling
 * blobs back across `postMessage`, which would copy every byte twice.
 *
 * Scope note: this is a plain worker, not a Service Worker. Telegram suspends
 * a Mini App's JavaScript when it is backgrounded, so downloads only progress
 * while the app is in the foreground. A Service Worker would not change that
 * (Telegram's WebView gives no Background Sync guarantee), so rather than
 * implying durability we cannot deliver, the UI states the limitation and the
 * queue is built to resume cleanly instead.
 */

export interface PageDescriptor {
  id: string;
  index: number;
  url: string;
  width: number | null;
  height: number | null;
}

export type WorkerCommand =
  | { type: 'start'; taskId: number; pages: PageDescriptor[] }
  | { type: 'pause'; taskId: number }
  | { type: 'resume'; taskId: number; pages: PageDescriptor[] }
  | { type: 'cancel'; taskId: number }
  | { type: 'pauseAll' };

export type WorkerEvent =
  | { type: 'progress'; taskId: number; completed: number; total: number; bytes: number }
  | { type: 'done'; taskId: number; bytes: number }
  | { type: 'failed'; taskId: number; error: string; retryable: boolean }
  | { type: 'paused'; taskId: number };

/** Pages fetched in parallel. Three keeps a phone's connection busy without
 *  starving the image requests the reader itself is making. */
const CONCURRENCY = 3;
/** Give up on a page after this many attempts and fail the whole chapter. */
const MAX_ATTEMPTS = 4;
/** Refuse absurd images rather than filling storage with one bad page. */
const MAX_PAGE_BYTES = 32 * 1024 * 1024;

const db = new ComicDatabase();

/** Tasks the main thread has asked us to stop. Checked between pages. */
const cancelled = new Set<number>();
const paused = new Set<number>();

const backoffMs = (attempt: number): number =>
  // Exponential with jitter: a flaky connection recovering should not have
  // every in-flight page retry in lockstep.
  Math.min(15_000, 2 ** attempt * 400) + Math.random() * 250;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function fetchPage(page: PageDescriptor, signal: AbortSignal): Promise<Blob> {
  const res = await fetch(page.url, { signal, cache: 'no-store' });
  if (!res.ok) {
    const err = new Error(`page request failed with status ${res.status}`);
    // 4xx other than 429 will not fix themselves, so do not burn retries.
    (err as Error & { retryable?: boolean }).retryable = res.status === 429 || res.status >= 500;
    throw err;
  }

  const blob = await res.blob();
  if (blob.size === 0) throw new Error('page came back empty');
  if (blob.size > MAX_PAGE_BYTES) throw new Error('page exceeds the size limit');
  return blob;
}

/** Download one page with retries. Returns bytes written, or 0 if skipped. */
async function downloadPage(
  page: PageDescriptor,
  chapterId: string,
  signal: AbortSignal,
): Promise<number> {
  // Already stored from an earlier run: this is what makes resume cheap.
  const existing = await db.pages.get(page.id);
  if (existing) return 0;

  let lastError: unknown = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (signal.aborted) throw new Error('cancelled');
    try {
      const blob = await fetchPage(page, signal);
      await db.pages.put({
        id: page.id,
        chapterId,
        index: page.index,
        blob,
        width: page.width,
        height: page.height,
        bytes: blob.size,
      });
      return blob.size;
    } catch (err) {
      lastError = err;
      const retryable = (err as Error & { retryable?: boolean }).retryable ?? true;
      const isQuota =
        (err as { name?: string }).name === 'QuotaExceededError' ||
        (err as { inner?: { name?: string } }).inner?.name === 'QuotaExceededError';

      // Storage exhaustion will not resolve by retrying; surface it at once so
      // the UI can offer to free space.
      if (isQuota) throw new Error('QUOTA_EXCEEDED', { cause: err });
      if (!retryable || signal.aborted) break;
      if (attempt < MAX_ATTEMPTS - 1) await sleep(backoffMs(attempt));
    }
  }

  if (lastError instanceof Error) throw lastError;
  throw new Error('page download failed', { cause: lastError });
}

async function runTask(taskId: number, pages: PageDescriptor[]): Promise<void> {
  const task = await db.queue.get(taskId);
  if (!task) return;

  const controller = new AbortController();
  let completed = 0;
  let bytes = task.bytes ?? 0;

  await db.queue.update(taskId, { status: 'running', total: pages.length, updatedAt: Date.now() });

  // A simple worker pool: three consumers pulling from a shared cursor. Using
  // a cursor rather than chunking keeps all three busy even when page sizes
  // vary wildly, which they do between splash pages and text pages.
  let cursor = 0;

  const consume = async (): Promise<void> => {
    for (;;) {
      if (cancelled.has(taskId) || paused.has(taskId)) {
        controller.abort();
        return;
      }
      const i = cursor++;
      const page = pages[i];
      if (!page) return;

      bytes += await downloadPage(page, task.chapterId, controller.signal);
      completed++;

      // Throttle progress writes: one IndexedDB update per page on a 400-page
      // chapter is 400 transactions competing with the blob writes.
      if (completed % 5 === 0 || completed === pages.length) {
        await db.queue.update(taskId, { completed, bytes, updatedAt: Date.now() });
        post({ type: 'progress', taskId, completed, total: pages.length, bytes });
      }
    }
  };

  try {
    await Promise.all(Array.from({ length: CONCURRENCY }, consume));

    if (cancelled.has(taskId)) {
      await db.queue.delete(taskId);
      cancelled.delete(taskId);
      return;
    }
    if (paused.has(taskId)) {
      await db.queue.update(taskId, { status: 'paused', completed, bytes, updatedAt: Date.now() });
      post({ type: 'paused', taskId });
      return;
    }

    // Only now is the chapter genuinely readable offline. Setting the marker
    // any earlier would let the reader open a chapter with holes in it.
    await db.chapters.update(task.chapterId, { downloadedAt: Date.now(), bytes });
    await db.queue.update(taskId, {
      status: 'done',
      completed: pages.length,
      bytes,
      updatedAt: Date.now(),
    });
    post({ type: 'done', taskId, bytes });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const retryable = message !== 'QUOTA_EXCEEDED' && message !== 'cancelled';

    await db.queue.update(taskId, {
      status: 'failed',
      error: message,
      completed,
      bytes,
      attempts: (task.attempts ?? 0) + 1,
      updatedAt: Date.now(),
    });
    post({ type: 'failed', taskId, error: message, retryable });
  }
}

function post(event: WorkerEvent): void {
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(event);
}

/**
 * Chapters run strictly one at a time.
 *
 * Parallelising across chapters would multiply peak memory and make progress
 * reporting meaningless, and the user is only ever waiting for the first one.
 */
let chain: Promise<void> = Promise.resolve();

function enqueue(taskId: number, pages: PageDescriptor[]): void {
  chain = chain.then(() => runTask(taskId, pages)).catch(() => undefined);
}

self.onmessage = (event: MessageEvent<WorkerCommand>): void => {
  const command = event.data;

  switch (command.type) {
    case 'start':
      paused.delete(command.taskId);
      enqueue(command.taskId, command.pages);
      break;

    case 'resume':
      paused.delete(command.taskId);
      enqueue(command.taskId, command.pages);
      break;

    case 'pause':
      paused.add(command.taskId);
      break;

    case 'cancel':
      cancelled.add(command.taskId);
      break;

    case 'pauseAll':
      // Sent when the document is hidden. Telegram suspends us shortly after,
      // and a fetch cut off mid-flight would otherwise be recorded as a failure.
      void db.queue
        .where('status')
        .equals('running')
        .toArray()
        .then((tasks: DownloadTask[]) => {
          for (const t of tasks) if (t.id !== undefined) paused.add(t.id);
        });
      break;
  }
};
