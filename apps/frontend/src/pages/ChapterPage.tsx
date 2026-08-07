import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { Chapter, ComicDetail } from '@comic/shared';
import { api, ApiClientError } from '../api/client';
import { CoverImage } from '../components/CoverImage';
import { ErrorState, Spinner } from '../components/states';
import { db, type DownloadTask } from '../db/schema';
import { StorageQuotaError, deleteChapterPages } from '../db/storage';
import { displayChapterTitle } from '../lib/chapterTitle';
import { downloads } from '../workers/downloadManager';
import { useLibrary } from '../store/library';
import { useBackButton, useHaptics } from '../telegram/hooks';
import { getWebApp } from '../telegram/webapp';

/**
 * Issue hub between the chapter grid and the 3D reader.
 * Read streams pages online (or offline if downloaded); Download saves every
 * page into IndexedDB for offline reading.
 */
export function ChapterPage(): React.JSX.Element {
  const { chapterId: rawId } = useParams<{ chapterId: string }>();
  const chapterId = rawId ? decodeURIComponent(rawId) : '';
  const [searchParams] = useSearchParams();
  const comicIdParam = searchParams.get('comic');
  const navigate = useNavigate();
  const { impact, notify } = useHaptics();

  const [chapter, setChapter] = useState<Chapter | null>(null);
  const [comic, setComic] = useState<ComicDetail | null>(null);
  const [coverUrl, setCoverUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [task, setTask] = useState<DownloadTask | undefined>(undefined);
  const [downloaded, setDownloaded] = useState(false);
  const [readBusy, setReadBusy] = useState(false);
  const [downloadBusy, setDownloadBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const progress = useLibrary((s) => s.progress.get(chapterId));

  useBackButton(useCallback(() => void navigate(-1), [navigate]));

  const load = useCallback(async () => {
    if (!chapterId) return;
    setLoading(true);
    setError(null);
    setActionError(null);

    try {
      const stored = await db.chapters.get(chapterId);
      if (stored) setChapter(stored);

      const comicId = comicIdParam || stored?.comicId || undefined;

      if (comicId) {
        const cachedComic = await db.comics.get(comicId);
        if (cachedComic) {
          setComic({ ...cachedComic, description: '', updatedAt: null });
        }

        try {
          const response = await api.comic(comicId);
          setComic(response.comic);
          await db.comics.put({ ...response.comic, cachedAt: Date.now() }).catch(() => undefined);

          const live = response.chapters.find((c) => c.id === chapterId);
          if (live) {
            setChapter(live);
            await db.chapters.put(live).catch(() => undefined);
          } else if (stored) {
            // Keep stored chapter but ensure comicId is attached for downloads.
            const withComic = { ...stored, comicId };
            setChapter(withComic);
            await db.chapters.put(withComic).catch(() => undefined);
          }
        } catch {
          if (stored && !stored.comicId && comicId) {
            const withComic = { ...stored, comicId };
            setChapter(withComic);
            await db.chapters.put(withComic).catch(() => undefined);
          }
        }
      }

      try {
        const preview = await api.chapterPreview(chapterId);
        setCoverUrl(preview.coverUrl);
        setChapter((prev) => {
          if (!prev) {
            // Minimal chapter so Read/Download are still usable from a deep link.
            const minimal = {
              id: chapterId,
              comicId: comicId || chapterId,
              number: 0,
              title: displayChapterTitle(preview.title || 'Выпуск'),
              volume: null,
              pageCount: preview.pageCount,
              publishedAt: null,
              coverUrl: preview.coverUrl,
            };
            void db.chapters.put(minimal).catch(() => undefined);
            return minimal;
          }
          const nextTitle = preview.title
            ? displayChapterTitle(preview.title, prev.number)
            : displayChapterTitle(prev.title, prev.number);
          const next = {
            ...prev,
            title: nextTitle,
            ...(preview.pageCount > 0 ? { pageCount: preview.pageCount } : {}),
            ...(preview.coverUrl ? { coverUrl: preview.coverUrl } : {}),
            ...(comicId && !prev.comicId ? { comicId } : {}),
          };
          void db.chapters.put(next).catch(() => undefined);
          return next;
        });
      } catch (err) {
        // Preview is optional; Read can still resolve pages itself.
        if (!stored && !comicId) throw err;
      }
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [chapterId, comicIdParam]);

  useEffect(() => {
    void load();
  }, [load]);

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

  const title = useMemo(
    () => (chapter ? displayChapterTitle(chapter.title, chapter.number) : ''),
    [chapter],
  );

  const openReader = useCallback(async () => {
    if (!chapterId || readBusy) return;
    setReadBusy(true);
    setActionError(null);
    impact('medium');
    try {
      // Warm the page list so a broken chapter fails here with a clear message
      // instead of a blank reader.
      if (!(await db.chapters.get(chapterId))?.downloadedAt) {
        await api.pages(chapterId);
      }
      const page = progress?.pageIndex ?? 0;
      void navigate(`/read/${encodeURIComponent(chapterId)}?page=${page}`);
    } catch (err) {
      notify('error');
      const message =
        err instanceof ApiClientError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Could not open this issue';
      setActionError(message);
      getWebApp().showAlert(message);
    } finally {
      setReadBusy(false);
    }
  }, [chapterId, impact, navigate, notify, progress?.pageIndex, readBusy]);

  const startDownload = useCallback(async () => {
    if (!chapter || downloadBusy) return;

    const comicId = comic?.id || chapter.comicId || comicIdParam;
    if (!comicId) {
      const message = 'Missing comic id — open this issue from the comic page again.';
      setActionError(message);
      getWebApp().showAlert(message);
      return;
    }

    setDownloadBusy(true);
    setActionError(null);
    try {
      let pageCount = chapter.pageCount;
      if (pageCount <= 0) {
        const preview = await api.chapterPreview(chapterId);
        pageCount = preview.pageCount;
        if (preview.coverUrl) setCoverUrl(preview.coverUrl);
        setChapter((prev) =>
          prev
            ? {
                ...prev,
                pageCount,
                ...(preview.coverUrl ? { coverUrl: preview.coverUrl } : {}),
                comicId,
              }
            : prev,
        );
      }

      await downloads.enqueueChapter({
        chapterId: chapter.id,
        comicId,
        comicTitle: comic?.title || 'Comic',
        chapterTitle: title || chapter.title,
        pageCount,
      });
      impact('light');
      notify('success');
    } catch (err) {
      notify('error');
      if (err instanceof StorageQuotaError) {
        const message =
          `Not enough space to download this chapter. ${err.message}. ` +
          'Remove a downloaded chapter and try again.';
        setActionError(message);
        getWebApp().showAlert(message);
      } else {
        const message =
          err instanceof Error ? err.message : 'Could not start the download.';
        setActionError(message);
        getWebApp().showAlert(message);
      }
    } finally {
      setDownloadBusy(false);
    }
  }, [
    chapter,
    chapterId,
    comic,
    comicIdParam,
    downloadBusy,
    impact,
    notify,
    title,
  ]);

  const removeDownload = useCallback(async () => {
    await deleteChapterPages(chapterId);
    setDownloaded(false);
    impact('light');
  }, [chapterId, impact]);

  if (loading && !chapter) return <Spinner label="Loading issue" />;
  if (error && !chapter) return <ErrorState error={error} onRetry={() => void load()} />;
  if (!chapter) return <ErrorState error={new Error('Issue not found')} onRetry={() => void load()} />;

  const preview = coverUrl ?? chapter.coverUrl ?? comic?.coverUrl ?? null;
  const downloading =
    downloadBusy || task?.status === 'running' || task?.status === 'queued';
  const pct = task && task.total > 0 ? Math.round((task.completed / task.total) * 100) : 0;
  const readLabel = readBusy
    ? 'Opening…'
    : progress
      ? 'Continue reading'
      : downloaded
        ? 'Read offline'
        : 'Read online';

  let downloadLabel = 'Download';
  if (downloaded) downloadLabel = 'Remove download';
  else if (downloading) downloadLabel = pct > 0 ? `Downloading… ${pct}%` : 'Downloading…';
  else if (task?.status === 'paused') downloadLabel = 'Resume download';
  else if (task?.status === 'failed') downloadLabel = 'Retry download';

  return (
    <div className="flex min-h-full flex-col px-4 pb-36 pt-4">
      <div className="mx-auto w-full max-w-sm">
        <CoverImage src={preview} alt={title} eager className="mx-auto w-48 shadow-lg" />

        <h1 className="mt-4 text-center text-lg font-bold leading-tight text-tg-text">{title}</h1>
        {comic && (
          <p className="mt-1 line-clamp-2 text-center text-sm text-tg-hint">{comic.title}</p>
        )}
        <p className="mt-2 text-center text-xs text-tg-subtitle">
          {chapter.pageCount > 0 ? `${chapter.pageCount} pages` : 'Pages load when you read'}
          {downloaded ? ' · Downloaded' : ''}
          {progress && progress.pageCount > 0
            ? ` · ${Math.round(((progress.pageIndex + 1) / progress.pageCount) * 100)}% read`
            : ''}
        </p>

        {actionError && (
          <p className="mt-3 rounded-lg bg-tg-destructive/10 px-3 py-2 text-center text-xs text-tg-destructive">
            {actionError}
          </p>
        )}
      </div>

      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-white/10 bg-tg-bg/95 px-4 py-3 pb-safe backdrop-blur supports-[backdrop-filter]:bg-tg-bg/80">
        <div className="mx-auto flex max-w-lg gap-3">
          <button
            type="button"
            disabled={readBusy}
            onClick={() => void openReader()}
            className="flex-1 rounded-xl bg-tg-button px-4 py-3 text-sm font-semibold text-tg-button-text disabled:opacity-50"
          >
            {readLabel}
          </button>
          <button
            type="button"
            disabled={downloading && !downloaded}
            onClick={() => {
              if (downloaded) {
                void removeDownload();
                return;
              }
              if (task?.status === 'paused' || task?.status === 'failed') {
                if (task.id !== undefined) void downloads.resume(task.id);
                return;
              }
              void startDownload();
            }}
            className="flex-1 rounded-xl bg-tg-secondary-bg px-4 py-3 text-sm font-semibold text-tg-text disabled:opacity-50"
          >
            {downloadLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
