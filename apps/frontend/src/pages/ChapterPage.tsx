import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { Chapter, ComicDetail } from '@comic/shared';
import { api } from '../api/client';
import { CoverImage } from '../components/CoverImage';
import { ErrorState, Spinner } from '../components/states';
import { db, type DownloadTask } from '../db/schema';
import { StorageQuotaError, deleteChapterPages } from '../db/storage';
import { downloads } from '../workers/downloadManager';
import { useLibrary } from '../store/library';
import { useBackButton, useHaptics } from '../telegram/hooks';
import { getWebApp } from '../telegram/webapp';

/**
 * Issue hub between the chapter grid and the 3D reader.
 * Choose Read (online / offline) or Download for offline.
 */
export function ChapterPage(): React.JSX.Element {
  const { chapterId: rawId } = useParams<{ chapterId: string }>();
  const chapterId = rawId ? decodeURIComponent(rawId) : '';
  const navigate = useNavigate();
  const { impact, notify } = useHaptics();

  const [chapter, setChapter] = useState<Chapter | null>(null);
  const [comic, setComic] = useState<ComicDetail | null>(null);
  const [coverUrl, setCoverUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [task, setTask] = useState<DownloadTask | undefined>(undefined);
  const [downloaded, setDownloaded] = useState(false);

  const progress = useLibrary((s) => s.progress.get(chapterId));

  useBackButton(useCallback(() => void navigate(-1), [navigate]));

  useEffect(() => {
    if (!chapterId) return;
    let cancelled = false;

    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const stored = await db.chapters.get(chapterId);
        if (!cancelled && stored) setChapter(stored);

        const comicId = stored?.comicId;
        if (comicId) {
          const cachedComic = await db.comics.get(comicId);
          if (!cancelled && cachedComic) {
            setComic({ ...cachedComic, description: '', updatedAt: null });
          }
          try {
            const response = await api.comic(comicId);
            if (cancelled) return;
            setComic(response.comic);
            const live = response.chapters.find((c) => c.id === chapterId);
            if (live) {
              setChapter(live);
              await db.chapters.put(live).catch(() => undefined);
            }
          } catch {
            // Keep cached chapter/comic if online fetch fails.
          }
        }

        try {
          const preview = await api.chapterPreview(chapterId);
          if (cancelled) return;
          setCoverUrl(preview.coverUrl);
          if (preview.pageCount > 0) {
            setChapter((prev) =>
              prev ? { ...prev, pageCount: preview.pageCount, coverUrl: preview.coverUrl } : prev,
            );
          }
        } catch {
          // Preview is optional; Read still works.
        }
      } catch (err) {
        if (!cancelled) setError(err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [chapterId]);

  useEffect(() => {
    return downloads.subscribe((tasks) => {
      setTask(tasks.find((t) => t.chapterId === chapterId));
    });
  }, [chapterId]);

  useEffect(() => {
    void db.chapters.get(chapterId).then((row) => {
      setDownloaded(row?.downloadedAt !== undefined);
    });
  }, [chapterId, task]);

  const openReader = useCallback(() => {
    impact('medium');
    const page = progress?.pageIndex ?? 0;
    void navigate(`/read/${encodeURIComponent(chapterId)}?page=${page}`);
  }, [chapterId, impact, navigate, progress?.pageIndex]);

  const startDownload = useCallback(async () => {
    if (!chapter || !comic) return;
    try {
      await downloads.enqueueChapter({
        chapterId: chapter.id,
        comicId: comic.id,
        comicTitle: comic.title,
        chapterTitle: chapter.title,
        pageCount: chapter.pageCount,
      });
      impact('light');
      notify('success');
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
  }, [chapter, comic, impact, notify]);

  const removeDownload = useCallback(async () => {
    await deleteChapterPages(chapterId);
    setDownloaded(false);
    impact('light');
  }, [chapterId, impact]);

  if (loading && !chapter) return <Spinner label="Loading issue" />;
  if (error && !chapter) return <ErrorState error={error} onRetry={() => window.location.reload()} />;
  if (!chapter) return <ErrorState error={new Error('Issue not found')} />;

  const preview = coverUrl ?? chapter.coverUrl ?? comic?.coverUrl ?? null;
  const downloading = task?.status === 'running' || task?.status === 'queued';
  const pct = task && task.total > 0 ? Math.round((task.completed / task.total) * 100) : 0;
  const readLabel = progress ? 'Continue reading' : downloaded ? 'Read offline' : 'Read online';

  return (
    <div className="flex min-h-full flex-col px-4 pb-28 pt-4">
      <div className="mx-auto w-full max-w-sm">
        <CoverImage src={preview} alt={chapter.title} eager className="mx-auto w-48 shadow-lg" />

        <h1 className="mt-4 text-center text-lg font-bold leading-tight text-tg-text">
          {chapter.title}
        </h1>
        {comic && (
          <p className="mt-1 text-center text-sm text-tg-hint line-clamp-2">{comic.title}</p>
        )}
        <p className="mt-2 text-center text-xs text-tg-subtitle">
          {chapter.pageCount > 0 ? `${chapter.pageCount} pages` : 'Pages load when you read'}
          {downloaded ? ' · Downloaded' : ''}
          {progress && progress.pageCount > 0
            ? ` · ${Math.round(((progress.pageIndex + 1) / progress.pageCount) * 100)}% read`
            : ''}
        </p>
      </div>

      <div className="fixed inset-x-0 bottom-16 z-20 border-t border-white/10 bg-tg-bg/95 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-tg-bg/80">
        <div className="mx-auto flex max-w-lg gap-3">
          <button
            type="button"
            onClick={openReader}
            className="flex-1 rounded-xl bg-tg-button px-4 py-3 text-sm font-semibold text-tg-button-text"
          >
            {readLabel}
          </button>
          <button
            type="button"
            disabled={downloading}
            onClick={() => {
              if (downloaded) {
                void removeDownload();
                return;
              }
              if (task?.status === 'paused' || task?.status === 'failed') {
                void downloads.resume(task.id!);
                return;
              }
              void startDownload();
            }}
            className="flex-1 rounded-xl bg-tg-secondary-bg px-4 py-3 text-sm font-semibold text-tg-text disabled:opacity-50"
          >
            {downloaded
              ? 'Remove download'
              : downloading
                ? `Downloading… ${pct}%`
                : task?.status === 'paused'
                  ? 'Resume download'
                  : task?.status === 'failed'
                    ? 'Retry download'
                    : 'Download'}
          </button>
        </div>
      </div>
    </div>
  );
}
