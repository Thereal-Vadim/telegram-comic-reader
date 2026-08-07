import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { ComicSummary, HomeFeedResponse } from '@comic/shared';
import { bootStage, bootWarn } from '../boot/log';
import { api } from '../api/client';
import { BootScreen } from '../components/BootScreen';
import { CoverImage } from '../components/CoverImage';
import { EmptyState, ErrorState } from '../components/states';
import { useLibrary } from '../store/library';
import { useHaptics } from '../telegram/hooks';
import { db } from '../db/schema';

/**
 * The home feed: a hero row across the top and one shelf per content source.
 *
 * When the network is unavailable this falls back to whatever is in IndexedDB,
 * so opening the app on a plane still shows the library rather than an error.
 */
export function HomePage(): React.JSX.Element {
  const [feed, setFeed] = useState<HomeFeedResponse | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [offlineFallback, setOfflineFallback] = useState(false);

  const hydrate = useLibrary((s) => s.hydrate);
  const favorites = useLibrary((s) => s.favorites);

  const load = useCallback(async () => {
    setError(null);
    setOfflineFallback(false);
    bootStage('home-ui', 'Loading Home shelves');

    try {
      const response = await api.home();
      setFeed(response);

      // Cache summaries so the offline path below has something to show.
      await db.comics
        .bulkPut(
          [...response.hero, ...response.shelves.flatMap((s) => s.items)].map((c) => ({
            ...c,
            cachedAt: Date.now(),
          })),
        )
        .catch(() => undefined);
    } catch (err) {
      // Before surfacing the error, see whether we can serve from cache.
      bootStage('home-ui', 'Home failed — checking offline cache');
      const cached = await db.comics.orderBy('cachedAt').reverse().limit(40).toArray();
      if (cached.length > 0) {
        bootWarn('home-ui', `Showing ${cached.length} cached comics offline`);
        setFeed({
          hero: cached.slice(0, 6),
          shelves: [{ id: 'cached', title: 'Available offline', items: cached }],
          degraded: [],
        });
        setOfflineFallback(true);
      } else {
        setError(err);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void hydrate();
    // Paint last IndexedDB shelf immediately, then refresh from the API.
    let cancelled = false;
    void (async () => {
      const cached = await db.comics.orderBy('cachedAt').reverse().limit(40).toArray();
      if (cancelled || cached.length === 0) return;
      setFeed((prev) =>
        prev ?? {
          hero: cached.slice(0, 6),
          shelves: [{ id: 'cached', title: 'Updating…', items: cached }],
          degraded: [],
        },
      );
      setLoading(false);
    })();
    void load();
    return () => {
      cancelled = true;
    };
  }, [hydrate, load]);

  if (loading && !feed) {
    return <BootScreen title="Loading library" subtitle="Fetching popular comics…" />;
  }
  if (error && !feed) return <ErrorState error={error} onRetry={load} />;
  if (!feed) return <EmptyState title="Nothing here yet" />;

  const hasContent = feed.hero.length > 0 || feed.shelves.some((s) => s.items.length > 0);
  if (!hasContent) {
    return (
      <EmptyState
        title="Library is empty"
        description="Enable a source on the server (LOCAL_LIBRARY_DIR, OPDS_CATALOGS, or COMX_ENABLED with COMX_LOGIN/COMX_PASSWORD), then restart."
      />
    );
  }

  const favoriteItems = [...feed.shelves.flatMap((s) => s.items)].filter((c) =>
    favorites.has(c.id),
  );

  return (
    <div className="pb-24">
      {offlineFallback && (
        <div className="mx-4 mt-3 rounded-lg bg-tg-secondary-bg px-3 py-2 text-xs text-tg-hint">
          Offline. Showing what is stored on this device.
        </div>
      )}

      {feed.degraded.length > 0 && (
        <div className="mx-4 mt-3 rounded-lg bg-tg-secondary-bg px-3 py-2 text-xs text-tg-hint">
          {feed.degraded.length === 1
            ? `${feed.degraded[0]!.adapterId} is unavailable: ${feed.degraded[0]!.reason}`
            : `${feed.degraded.length} sources are unavailable.`}
        </div>
      )}

      {feed.hero.length > 0 && <HeroCarousel items={feed.hero} />}

      {favoriteItems.length > 0 && <Shelf title="Favourites" items={favoriteItems} />}

      {feed.shelves.map((shelf) => (
        <Shelf key={shelf.id} title={shelf.title} items={shelf.items} />
      ))}
    </div>
  );
}

/**
 * Horizontally snapping hero row.
 *
 * CSS scroll-snap rather than a JS carousel: it is one property, it tracks the
 * finger natively, and it does not fight the WebView's momentum scrolling the
 * way a transform-driven carousel does.
 */
function HeroCarousel({ items }: { items: ComicSummary[] }): React.JSX.Element {
  const navigate = useNavigate();
  const { select } = useHaptics();

  return (
    <div className="no-scrollbar mt-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4">
      {items.map((comic, i) => (
        <button
          key={comic.id}
          type="button"
          onClick={() => {
            select();
            void navigate(`/comic/${encodeURIComponent(comic.id)}`);
          }}
          className="relative w-[78vw] max-w-sm shrink-0 snap-center overflow-hidden rounded-xl text-left"
        >
          <CoverImage
            src={comic.coverUrl}
            alt={comic.title}
            eager={i < 2}
            className="!aspect-[16/10]"
          />
          {/* Gradient keeps the title legible over arbitrary cover art. */}
          <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 to-transparent p-3">
            <h2 className="line-clamp-1 text-base font-semibold text-white">{comic.title}</h2>
            {comic.authors.length > 0 && (
              <p className="line-clamp-1 text-xs text-white/70">{comic.authors.join(', ')}</p>
            )}
          </div>
        </button>
      ))}
    </div>
  );
}

function Shelf({ title, items }: { title: string; items: ComicSummary[] }): React.JSX.Element {
  return (
    <section className="mt-6">
      <div className="mb-2 flex items-baseline justify-between px-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-tg-subtitle">{title}</h2>
        <span className="text-xs text-tg-hint">{items.length}</span>
      </div>

      <div className="no-scrollbar flex gap-3 overflow-x-auto px-4">
        {items.map((comic) => (
          <Link
            key={comic.id}
            to={`/comic/${encodeURIComponent(comic.id)}`}
            className="w-28 shrink-0"
          >
            <CoverImage src={comic.coverUrl} alt={comic.title} />
            <p className="mt-1.5 line-clamp-2 text-xs leading-tight text-tg-text">{comic.title}</p>
          </Link>
        ))}
      </div>
    </section>
  );
}
