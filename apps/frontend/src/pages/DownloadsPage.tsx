import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { EmptyState } from '../components/states';
import type { DownloadTask } from '../db/schema';
import {
  deleteComic,
  getStorageStatus,
  requestPersistence,
  type StorageStatus,
} from '../db/storage';
import { db } from '../db/schema';
import { downloads } from '../workers/downloadManager';
import { useClosingConfirmation, useHaptics } from '../telegram/hooks';
import { getWebApp } from '../telegram/webapp';

/**
 * Download queue and storage management.
 *
 * The foreground-only caveat is stated plainly here rather than buried. A
 * reader that appears to download in the background and silently stops when
 * the user switches chats is worse than one that says what it does, and
 * Telegram gives no way to keep a Mini App's JavaScript alive once it is
 * backgrounded.
 */
export function DownloadsPage(): React.JSX.Element {
  const [tasks, setTasks] = useState<DownloadTask[]>([]);
  const [storage, setStorage] = useState<StorageStatus | null>(null);
  const [comics, setComics] = useState<{ id: string; title: string; bytes: number }[]>([]);
  const { impact, notify } = useHaptics();
  const prevStatuses = useRef(new Map<number, DownloadTask['status']>());

  const active = tasks.some((t) => t.status === 'running' || t.status === 'queued');
  // Warn before closing while a transfer is live, since closing suspends it.
  useClosingConfirmation(active);

  // Buzz when a live transfer finishes — only on a status transition, so
  // remounting the page over already-done tasks does not vibrate.
  useEffect(() => {
    for (const task of tasks) {
      if (task.id === undefined) continue;
      const prev = prevStatuses.current.get(task.id);
      prevStatuses.current.set(task.id, task.status);
      if (prev && prev !== 'done' && task.status === 'done') notify('success');
      if (prev && prev !== 'failed' && task.status === 'failed') notify('error');
    }
  }, [tasks, notify]);

  const refresh = useCallback(async () => {
    setStorage(await getStorageStatus());

    // Group downloaded bytes by comic for the storage breakdown.
    const chapters = await db.chapters.filter((c) => c.downloadedAt !== undefined).toArray();
    const byComic = new Map<string, number>();
    for (const c of chapters) {
      byComic.set(c.comicId, (byComic.get(c.comicId) ?? 0) + (c.bytes ?? 0));
    }

    const rows = await Promise.all(
      [...byComic.entries()].map(async ([comicId, bytes]) => ({
        id: comicId,
        title: (await db.comics.get(comicId))?.title ?? comicId,
        bytes,
      })),
    );
    setComics(rows.sort((a, b) => b.bytes - a.bytes));
  }, []);

  useEffect(() => downloads.subscribe(setTasks), []);
  useEffect(() => {
    void refresh();
  }, [refresh, tasks]);

  const enablePersistence = useCallback(async () => {
    const granted = await requestPersistence();
    getWebApp().showAlert(
      granted
        ? 'Downloads are now protected from automatic cleanup.'
        : 'The browser declined. Downloads may be cleared if the device runs low on space. ' +
            'Using the app more often usually makes the browser grant this.',
    );
    await refresh();
  }, [refresh]);

  const removeComic = useCallback(
    async (comicId: string, title: string) => {
      getWebApp().showConfirm(`Remove all downloaded chapters of "${title}"?`, (ok) => {
        if (!ok) return;
        void deleteComic(comicId).then(() => {
          impact('medium');
          void refresh();
        });
      });
    },
    [impact, refresh],
  );

  const activeTasks = tasks.filter((t) => t.status !== 'done');

  return (
    <div className="px-4 pb-24 pt-4">
      <h1 className="text-lg font-bold text-tg-text">Downloads</h1>

      {storage && <StorageSummary storage={storage} onEnablePersistence={enablePersistence} />}

      <section className="mt-6">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-tg-subtitle">Queue</h2>

        {activeTasks.length === 0 ? (
          <EmptyState
            title="Nothing downloading"
            description="Save a chapter from a comic's page to read it without a connection."
          />
        ) : (
          <>
            <p className="mt-2 rounded-lg bg-tg-secondary-bg px-3 py-2 text-xs text-tg-hint">
              Downloads only run while this app is open. Telegram pauses it when you switch
              away, and it resumes from where it stopped when you come back.
            </p>

            <ul className="mt-3 space-y-3">
              {activeTasks.map((task) => (
                <QueueRow key={task.id} task={task} />
              ))}
            </ul>
          </>
        )}
      </section>

      {comics.length > 0 && (
        <section className="mt-8">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-tg-subtitle">
            Stored on this device
          </h2>
          <ul className="mt-2 divide-y divide-white/5">
            {comics.map((comic) => (
              <li key={comic.id} className="flex items-center gap-3 py-3">
                <Link
                  to={`/comic/${encodeURIComponent(comic.id)}`}
                  className="min-w-0 flex-1 truncate text-sm text-tg-text"
                >
                  {comic.title}
                </Link>
                <span className="shrink-0 text-xs tabular-nums text-tg-hint">
                  {formatBytes(comic.bytes)}
                </span>
                <button
                  type="button"
                  onClick={() => void removeComic(comic.id, comic.title)}
                  className="shrink-0 rounded-lg bg-tg-secondary-bg px-3 py-1.5 text-xs text-tg-destructive"
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function StorageSummary({
  storage,
  onEnablePersistence,
}: {
  storage: StorageStatus;
  onEnablePersistence: () => void;
}): React.JSX.Element {
  const pct = storage.quota > 0 ? Math.min(100, (storage.usage / storage.quota) * 100) : 0;

  return (
    <div className="mt-4 rounded-xl bg-tg-secondary-bg p-4">
      <div className="flex items-baseline justify-between text-sm">
        <span className="text-tg-text">Storage used</span>
        <span className="tabular-nums text-tg-hint">
          {formatBytes(storage.usage)}
          {storage.quota > 0 && ` of ${formatBytes(storage.quota)}`}
        </span>
      </div>

      {storage.quota > 0 && (
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-black/30">
          <div
            className={`h-full rounded-full ${pct > 90 ? 'bg-tg-destructive' : 'bg-tg-button'}`}
            style={{ width: `${pct}%` }}
          />
        </div>
      )}

      <p className="mt-2 text-xs text-tg-hint">
        {formatBytes(storage.pageBytes)} of that is downloaded comic pages.
      </p>

      {!storage.persisted && (
        <button
          type="button"
          onClick={onEnablePersistence}
          className="mt-3 w-full rounded-lg bg-tg-button px-4 py-2 text-sm font-medium text-tg-button-text"
        >
          Protect downloads from cleanup
        </button>
      )}
    </div>
  );
}

function QueueRow({ task }: { task: DownloadTask }): React.JSX.Element {
  const pct = task.total > 0 ? Math.round((task.completed / task.total) * 100) : 0;

  return (
    <li className="rounded-xl bg-tg-secondary-bg p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm text-tg-text">{task.comicTitle}</p>
          <p className="truncate text-xs text-tg-hint">{task.chapterTitle}</p>
        </div>

        <div className="flex shrink-0 gap-2">
          {task.status === 'running' || task.status === 'queued' ? (
            <button
              type="button"
              onClick={() => task.id !== undefined && void downloads.pause(task.id)}
              className="rounded-lg bg-black/25 px-2.5 py-1 text-xs text-tg-text"
            >
              Pause
            </button>
          ) : (
            <button
              type="button"
              onClick={() => task.id !== undefined && void downloads.resume(task.id)}
              className="rounded-lg bg-black/25 px-2.5 py-1 text-xs text-tg-text"
            >
              Resume
            </button>
          )}
          <button
            type="button"
            onClick={() => task.id !== undefined && void downloads.cancel(task.id)}
            className="rounded-lg bg-black/25 px-2.5 py-1 text-xs text-tg-destructive"
          >
            Cancel
          </button>
        </div>
      </div>

      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-black/30">
        <div className="h-full rounded-full bg-tg-button transition-all" style={{ width: `${pct}%` }} />
      </div>

      <div className="mt-1 flex justify-between text-xs text-tg-hint">
        <span className="tabular-nums">
          {task.completed} / {task.total} pages
        </span>
        <span>{task.status === 'failed' ? task.error : formatBytes(task.bytes)}</span>
      </div>
    </li>
  );
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
