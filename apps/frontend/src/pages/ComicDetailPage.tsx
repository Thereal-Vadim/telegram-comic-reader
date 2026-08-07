import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { Chapter, ComicDetail } from '@comic/shared';
import { api } from '../api/client';
import { CoverImage } from '../components/CoverImage';
import { ErrorState, Spinner } from '../components/states';
import { db, type DownloadTask } from '../db/schema';
import { StorageQuotaError, deleteChapterPages } from '../db/storage';
import { downloads } from '../workers/downloadManager';
import { useLibrary } from '../store/library';
import { useBackButton, useHaptics, useMainButton } from '../telegram/hooks';
import { getWebApp } from '../telegram/webapp';

/**
 * Comic detail: metadata, chapter list, per-chapter download state.
 *
 * The native MainButton is bound to the primary action, which changes with
 * context: "Start reading" for a comic never opened, "Continue chapter N" once
 * there is progress. Telegram users expect that button to do the obvious
 * thing, so it tracks the same action the list would.
 */
export function ComicDetailPage(): React.JSX.Element {
  const { id } = useParams<{ id: string }>();
  const comicId = id ? decodeURIComponent(id) : '';
  const navigate = useNavigate();
  const { impact, notify } = useHaptics();

  const [comic, setComic] = useState<ComicDetail | null>(null);
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [tasks, setTasks] = useState<DownloadTask[]>([]);
  const [downloadedIds, setDownloadedIds] = useState<Set<string>>(new Set());

  const toggleFavorite = useLibrary((s) => s.toggleFavorite);
  const isFavorite = useLibrary((s) => s.favorites.has(comicId));
  const touchHistory = useLibrary((s) => s.touchHistory);
  // Subscribing to the whole map rather than calling getProgress per row keeps
  // the list reactive: reading a chapter and coming back updates its percentage.
  const progressByChapter = useLibrary((s) => s.progress);
  const lastRead = useLibrary((s) => s.lastReadChapter(comicId));

  useBackButton(useCallback(() => void navigate(-1), [navigate]));

  const load = useCallback(async () => {
    if (!comicId) return;
    setLoading(true);
    setError(null);

    try {
      const response = await api.comic(comicId);
      setComic(response.comic);
      setChapters(response.chapters);

      await db.comics.put({ ...response.comic, cachedAt: Date.now() }).catch(() => undefined);
      await db.chapters.bulkPut(response.chapters).catch(() => undefined);
      await touchHistory(comicId);
    } catch (err) {
      // Fall back to whatever was cached from a previous online visit.
      const [cachedComic, cachedChapters] = await Promise.all([
        db.comics.get(comicId),
        db.chapters.where('comicId').equals(comicId).sortBy('number'),
      ]);

      if (cachedComic && cachedChapters.length > 0) {
        setComic({ ...cachedComic, description: '', updatedAt: null });
        setChapters(cachedChapters);
      } else {
        setError(err);
      }
    } finally {
      setLoading(false);
    }
  }, [comicId, touchHistory]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => downloads.subscribe(setTasks), []);

  // Recompute which chapters are fully downloaded whenever the queue changes.
  useEffect(() => {
    void (async () => {
      const stored = await db.chapters
        .where('comicId')
        .equals(comicId)
        .filter((c) => c.downloadedAt !== undefined)
        .toArray();
      setDownloadedIds(new Set(stored.map((c) => c.id)));
    })();
  }, [comicId, tasks]);

  const taskByChapter = useMemo(
    () => new Map(tasks.map((t) => [t.chapterId, t])),
    [tasks],
  );

  const resumeTarget = useMemo(() => {
    if (lastRead) {
      const chapter = chapters.find((c) => c.id === lastRead.chapterId);
      if (chapter) return { chapter, page: lastRead.pageIndex };
    }
    return chapters[0] ? { chapter: chapters[0], page: 0 } : null;
  }, [lastRead, chapters]);

  const openChapter = useCallback(
    (chapterId: string, page = 0) => {
      impact('medium');
      void navigate(`/read/${encodeURIComponent(chapterId)}?page=${page}`);
    },
    [navigate, impact],
  );

  useMainButton(
    resumeTarget
      ? {
          text: lastRead
            ? `Continue ${resumeTarget.chapter.title}`.slice(0, 64)
            : 'Start reading',
          onClick: () => openChapter(resumeTarget.chapter.id, resumeTarget.page),
        }
      : null,
  );

  const download = useCallback(
    async (chapter: Chapter) => {
      if (!comic) return;
      try {
        await downloads.enqueueChapter({
          chapterId: chapter.id,
          comicId: comic.id,
          comicTitle: comic.title,
          chapterTitle: chapter.title,
          pageCount: chapter.pageCount,
        });
        impact('light');
      } catch (err) {
        notify('error');
        if (err instanceof StorageQuotaError) {
          getWebApp().showAlert(
            `Not enough space to download this chapter. ${err.message}. ` +
              'Remove a downloaded chapter and try again.',
          );
        } else {
          getWebApp().showAlert(
            err instanceof Error ? err.message : 'Could not start the download.',
          );
        }
      }
    },
    [comic, impact, notify],
  );

  const removeDownload = useCallback(
    async (chapterId: string) => {
      await deleteChapterPages(chapterId);
      setDownloadedIds((prev) => {
        const next = new Set(prev);
        next.delete(chapterId);
        return next;
      });
      impact('light');
    },
    [impact],
  );

  if (loading && !comic) return <Spinner label="Loading" />;
  if (error && !comic) return <ErrorState error={error} onRetry={load} />;
  if (!comic) return <ErrorState error={new Error('Comic not found')} />;

  return (
    <div className="pb-32">
      <header className="flex gap-4 px-4 pt-4">
        <CoverImage src={comic.coverUrl} alt={comic.title} eager className="w-28 shrink-0" />

        <div className="min-w-0 flex-1">
          <h1 className="text-lg font-bold leading-tight text-tg-text">{comic.title}</h1>
          {comic.authors.length > 0 && (
            <p className="mt-1 text-sm text-tg-hint">{comic.authors.join(', ')}</p>
          )}
          <p className="mt-1 text-xs text-tg-hint">
            {chapters.length} {chapters.length === 1 ? 'chapter' : 'chapters'}
            {comic.status !== 'unknown' && ` · ${comic.status}`}
          </p>

          <button
            type="button"
            onClick={() => {
              impact('light');
              void toggleFavorite(comic.id);
            }}
            aria-pressed={isFavorite}
            className={`mt-3 rounded-lg px-4 py-1.5 text-sm font-medium ${
              isFavorite
                ? 'bg-tg-button text-tg-button-text'
                : 'bg-tg-secondary-bg text-tg-text'
            }`}
          >
            {isFavorite ? 'In favourites' : 'Add to favourites'}
          </button>
        </div>
      </header>

      {comic.description && (
        <p className="mt-4 px-4 text-sm leading-relaxed text-tg-hint">{comic.description}</p>
      )}

      <section className="mt-6">
        <h2 className="px-4 pb-2 text-sm font-semibold uppercase tracking-wide text-tg-subtitle">
          Chapters
        </h2>

        <ul className="divide-y divide-white/5">
          {chapters.map((chapter) => {
            const task = taskByChapter.get(chapter.id);
            const isDownloaded = downloadedIds.has(chapter.id);
            const progress = progressByChapter.get(chapter.id);

            return (
              <li key={chapter.id} className="flex items-center gap-3 px-4 py-3">
                <button
                  type="button"
                  onClick={() => openChapter(chapter.id, progress?.pageIndex ?? 0)}
                  className="min-w-0 flex-1 text-left"
                >
                  <p className="truncate text-sm text-tg-text">{chapter.title}</p>
                  <p className="text-xs text-tg-hint">
                    {chapter.pageCount > 0 ? `${chapter.pageCount} pages` : 'Tap to load'}
                    {progress &&
                      progress.pageCount > 0 &&
                      ` · ${Math.round(((progress.pageIndex + 1) / progress.pageCount) * 100)}% read`}
                  </p>
                </button>

                <ChapterDownloadButton
                  task={task}
                  downloaded={isDownloaded}
                  onDownload={() => void download(chapter)}
                  onRemove={() => void removeDownload(chapter.id)}
                  onPause={() => task?.id !== undefined && void downloads.pause(task.id)}
                  onResume={() => task?.id !== undefined && void downloads.resume(task.id)}
                />
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}

function ChapterDownloadButton({
  task,
  downloaded,
  onDownload,
  onRemove,
  onPause,
  onResume,
}: {
  task: DownloadTask | undefined;
  downloaded: boolean;
  onDownload: () => void;
  onRemove: () => void;
  onPause: () => void;
  onResume: () => void;
}): React.JSX.Element {
  if (downloaded && (!task || task.status === 'done')) {
    return (
      <button
        type="button"
        onClick={onRemove}
        aria-label="Remove download"
        className="shrink-0 rounded-lg bg-tg-secondary-bg px-3 py-1.5 text-xs text-tg-hint"
      >
        Saved
      </button>
    );
  }

  if (task?.status === 'running' || task?.status === 'queued') {
    const pct = task.total > 0 ? Math.round((task.completed / task.total) * 100) : 0;
    return (
      <button
        type="button"
        onClick={onPause}
        aria-label={`Pause download, ${pct} percent complete`}
        className="shrink-0 rounded-lg bg-tg-secondary-bg px-3 py-1.5 text-xs tabular-nums text-tg-text"
      >
        {pct}%
      </button>
    );
  }

  if (task?.status === 'paused') {
    return (
      <button
        type="button"
        onClick={onResume}
        className="shrink-0 rounded-lg bg-tg-secondary-bg px-3 py-1.5 text-xs text-tg-text"
      >
        Resume
      </button>
    );
  }

  if (task?.status === 'failed') {
    return (
      <button
        type="button"
        onClick={onResume}
        title={task.error}
        className="shrink-0 rounded-lg bg-tg-secondary-bg px-3 py-1.5 text-xs text-tg-destructive"
      >
        Retry
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={onDownload}
      aria-label="Download chapter"
      className="shrink-0 rounded-lg bg-tg-secondary-bg px-3 py-1.5 text-xs text-tg-link"
    >
      Save
    </button>
  );
}
