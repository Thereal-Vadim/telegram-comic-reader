import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { CoverImage } from '../components/CoverImage';
import { EmptyState } from '../components/states';
import type { DownloadTask, StoredChapter } from '../db/schema';
import {
  deleteChapterPages,
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
 * Downloaded files on this device — the offline library.
 *
 * Only chapters that finished downloading appear here. Opening one always
 * reads from IndexedDB blobs (no network). The active queue sits above the
 * list while transfers run (they only progress while the Mini App is open).
 */

interface DownloadedIssue {
  chapter: StoredChapter;
  comicTitle: string;
  coverUrl: string | null;
}

export function DownloadsPage(): React.JSX.Element {
  const navigate = useNavigate();
  const [tasks, setTasks] = useState<DownloadTask[]>([]);
  const [storage, setStorage] = useState<StorageStatus | null>(null);
  const [issues, setIssues] = useState<DownloadedIssue[]>([]);
  const { impact, notify } = useHaptics();
  const prevStatuses = useRef(new Map<number, DownloadTask['status']>());

  const active = tasks.some((t) => t.status === 'running' || t.status === 'queued');
  useClosingConfirmation(active);

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

    const chapters = await db.chapters
      .filter((c) => c.downloadedAt !== undefined)
      .toArray();

    // Newest downloads first.
    chapters.sort((a, b) => (b.downloadedAt ?? 0) - (a.downloadedAt ?? 0));

    const rows = await Promise.all(
      chapters.map(async (chapter) => {
        const comic = await db.comics.get(chapter.comicId);
        return {
          chapter,
          comicTitle: comic?.title ?? chapter.comicId,
          coverUrl: chapter.coverUrl ?? comic?.coverUrl ?? null,
        };
      }),
    );
    setIssues(rows);
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
        : 'The browser declined. Downloads may be cleared if the device runs low on space.',
    );
    await refresh();
  }, [refresh]);

  const openOffline = useCallback(
    (chapter: StoredChapter) => {
      impact('medium');
      // Reader prefers IndexedDB blobs when downloadedAt is set.
      void navigate(`/read/${encodeURIComponent(chapter.id)}?page=0`);
    },
    [impact, navigate],
  );

  const removeIssue = useCallback(
    async (chapter: StoredChapter) => {
      getWebApp().showConfirm(`Remove offline copy of "${chapter.title}"?`, (ok) => {
        if (!ok) return;
        void deleteChapterPages(chapter.id).then(() => {
          impact('medium');
          void refresh();
        });
      });
    },
    [impact, refresh],
  );

  const removeAllForComic = useCallback(
    async (comicId: string, title: string) => {
      getWebApp().showConfirm(`Remove all downloaded issues of "${title}"?`, (ok) => {
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
      <header className="mb-2">
        <h1 className="text-lg font-bold text-tg-text">Downloaded</h1>
        <p className="mt-1 text-sm text-tg-hint">
          Issues saved on this phone. They open without the internet.
        </p>
      </header>

      {storage && <StorageSummary storage={storage} onEnablePersistence={enablePersistence} />}

      {activeTasks.length > 0 && (
        <section className="mt-6">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-tg-subtitle">
            Downloading now
          </h2>
          <p className="mt-2 rounded-lg bg-tg-secondary-bg px-3 py-2 text-xs text-tg-hint">
            Keep the Mini App open — Telegram pauses downloads when you switch away.
          </p>
          <ul className="mt-3 space-y-3">
            {activeTasks.map((task) => (
              <QueueRow key={task.id} task={task} />
            ))}
          </ul>
        </section>
      )}

      <section className="mt-6">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-tg-subtitle">
          On this device
          {issues.length > 0 ? ` · ${issues.length}` : ''}
        </h2>

        {issues.length === 0 ? (
          <EmptyState
            title="Nothing downloaded yet"
            description="Open a comic, pick an issue, tap Download. Finished issues appear here and work offline."
          />
        ) : (
          <ul className="mt-3 space-y-3">
            {issues.map(({ chapter, comicTitle, coverUrl }) => (
              <li
                key={chapter.id}
                className="flex gap-3 rounded-xl bg-tg-secondary-bg p-3"
              >
                <button
                  type="button"
                  onClick={() => openOffline(chapter)}
                  className="w-16 shrink-0 text-left"
                >
                  <CoverImage src={coverUrl} alt={chapter.title} className="w-full" />
                </button>
                <div className="min-w-0 flex-1">
                  <button
                    type="button"
                    onClick={() => openOffline(chapter)}
                    className="w-full text-left"
                  >
                    <p className="truncate text-sm font-medium text-tg-text">{chapter.title}</p>
                    <p className="mt-0.5 truncate text-xs text-tg-hint">{comicTitle}</p>
                    <p className="mt-1 text-[11px] text-tg-subtitle">
                      {chapter.pageCount > 0 ? `${chapter.pageCount} pages` : 'Offline'}
                      {chapter.bytes ? ` · ${formatBytes(chapter.bytes)}` : ''}
                      {' · Offline'}
                    </p>
                  </button>
                  <div className="mt-2 flex gap-2">
                    <button
                      type="button"
                      onClick={() => openOffline(chapter)}
                      className="rounded-lg bg-tg-button px-3 py-1.5 text-xs font-semibold text-tg-button-text"
                    >
                      Read offline
                    </button>
                    <Link
                      to={`/chapter/${encodeURIComponent(chapter.id)}?comic=${encodeURIComponent(chapter.comicId)}`}
                      className="rounded-lg bg-black/25 px-3 py-1.5 text-xs text-tg-text"
                    >
                      Details
                    </Link>
                    <button
                      type="button"
                      onClick={() => void removeIssue(chapter)}
                      className="rounded-lg bg-black/25 px-3 py-1.5 text-xs text-tg-destructive"
                    >
                      Remove
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {issues.length > 0 && (
        <section className="mt-8">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-tg-subtitle">
            Remove by series
          </h2>
          <ComicBulkRemove issues={issues} onRemove={removeAllForComic} />
        </section>
      )}
    </div>
  );
}

function ComicBulkRemove({
  issues,
  onRemove,
}: {
  issues: DownloadedIssue[];
  onRemove: (comicId: string, title: string) => void;
}): React.JSX.Element {
  const byComic = new Map<string, { title: string; count: number; bytes: number }>();
  for (const { chapter, comicTitle } of issues) {
    const row = byComic.get(chapter.comicId) ?? {
      title: comicTitle,
      count: 0,
      bytes: 0,
    };
    row.count += 1;
    row.bytes += chapter.bytes ?? 0;
    byComic.set(chapter.comicId, row);
  }

  return (
    <ul className="mt-2 divide-y divide-white/5">
      {[...byComic.entries()].map(([comicId, row]) => (
        <li key={comicId} className="flex items-center gap-3 py-3">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm text-tg-text">{row.title}</p>
            <p className="text-xs text-tg-hint">
              {row.count} {row.count === 1 ? 'issue' : 'issues'} · {formatBytes(row.bytes)}
            </p>
          </div>
          <button
            type="button"
            onClick={() => onRemove(comicId, row.title)}
            className="shrink-0 rounded-lg bg-tg-secondary-bg px-3 py-1.5 text-xs text-tg-destructive"
          >
            Remove all
          </button>
        </li>
      ))}
    </ul>
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
        {formatBytes(storage.pageBytes)} is offline comic pages on this device.
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
          {task.completed} / {task.total > 0 ? task.total : '…'} pages
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
