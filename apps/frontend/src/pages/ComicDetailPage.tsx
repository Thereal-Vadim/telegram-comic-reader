import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { Chapter, ComicDetail } from '@comic/shared';
import { api } from '../api/client';
import { ChapterCard } from '../components/ChapterCard';
import { CoverImage } from '../components/CoverImage';
import { ErrorState, Spinner } from '../components/states';
import { db } from '../db/schema';
import { useLibrary } from '../store/library';
import { useBackButton, useHaptics } from '../telegram/hooks';

/**
 * Comic detail: cover, optional description, and a 3-column issue grid.
 * Tapping an issue opens the chapter hub (Read / Download), not the reader.
 */
export function ComicDetailPage(): React.JSX.Element {
  const { id } = useParams<{ id: string }>();
  const comicId = id ? decodeURIComponent(id) : '';
  const navigate = useNavigate();
  const { impact } = useHaptics();

  const [comic, setComic] = useState<ComicDetail | null>(null);
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [downloadedIds, setDownloadedIds] = useState<Set<string>>(new Set());

  const toggleFavorite = useLibrary((s) => s.toggleFavorite);
  const isFavorite = useLibrary((s) => s.favorites.has(comicId));
  const touchHistory = useLibrary((s) => s.touchHistory);
  const progressByChapter = useLibrary((s) => s.progress);

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

  useEffect(() => {
    void (async () => {
      const stored = await db.chapters
        .where('comicId')
        .equals(comicId)
        .filter((c) => c.downloadedAt !== undefined)
        .toArray();
      setDownloadedIds(new Set(stored.map((c) => c.id)));
    })();
  }, [comicId, chapters]);

  const openChapter = useCallback(
    (chapterId: string) => {
      impact('medium');
      void navigate(`/chapter/${encodeURIComponent(chapterId)}`);
    },
    [navigate, impact],
  );

  if (loading && !comic) return <Spinner label="Loading" />;
  if (error && !comic) return <ErrorState error={error} onRetry={load} />;
  if (!comic) return <ErrorState error={new Error('Comic not found')} />;

  const description = comic.description.trim();

  return (
    <div className="flex min-h-full flex-col pb-24">
      <header className="flex gap-4 px-4 pt-4">
        <CoverImage src={comic.coverUrl} alt={comic.title} eager className="w-28 shrink-0" />

        <div className="min-w-0 flex-1">
          <h1 className="text-lg font-bold leading-tight text-tg-text">{comic.title}</h1>
          {comic.authors.length > 0 && (
            <p className="mt-1 text-sm text-tg-hint">{comic.authors.join(', ')}</p>
          )}
          <p className="mt-1 text-xs text-tg-hint">
            {chapters.length} {chapters.length === 1 ? 'issue' : 'issues'}
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

      {description ? (
        <p className="mt-4 max-h-40 overflow-y-auto px-4 text-sm leading-relaxed text-tg-hint">
          {description}
        </p>
      ) : null}

      <section className="mt-6 px-3">
        <h2 className="px-1 pb-3 text-sm font-semibold uppercase tracking-wide text-tg-subtitle">
          Issues
        </h2>

        <div className="grid grid-cols-3 gap-x-2 gap-y-4">
          {chapters.map((chapter) => {
            const progress = progressByChapter.get(chapter.id);
            const isDownloaded = downloadedIds.has(chapter.id);
            let badge: string | undefined;
            if (isDownloaded) badge = 'Offline';
            else if (progress && progress.pageCount > 0) {
              badge = `${Math.round(((progress.pageIndex + 1) / progress.pageCount) * 100)}%`;
            }

            return (
              <ChapterCard
                key={chapter.id}
                chapter={chapter}
                fallbackCover={comic.coverUrl}
                {...(badge ? { badge } : {})}
                onOpen={() => openChapter(chapter.id)}
              />
            );
          })}
        </div>
      </section>
    </div>
  );
}
