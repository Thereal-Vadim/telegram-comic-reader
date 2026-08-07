import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { ComicSummary, HomeFeedResponse } from '@comic/shared';
import { bootStage, bootWarn } from '../boot/log';
import { api } from '../api/client';
import { BootScreen } from '../components/BootScreen';
import { CoverImage } from '../components/CoverImage';
import { EmptyState, ErrorState } from '../components/states';
import { db, type ReadingProgress, type StoredChapter } from '../db/schema';
import { isDemoSampleComic, purgeStaleLocalCatalog } from '../db/storage';
import { useLibrary } from '../store/library';
import { useHaptics } from '../telegram/hooks';

const SHELF_VISIBLE = 16;

interface ContinueItem {
  comic: ComicSummary;
  progress: ReadingProgress;
  /** 0–100 whole-comic estimate when chapter list is known; else chapter page %. */
  percent: number;
}

/**
 * Home: Continue (3) → Favourites → New (Comics, then Manga).
 *
 * Continue and Favourites are local (progress / stars). The New shelves come
 * from the catalog feed, split by genre heuristics when the source tags manga.
 */
export function HomePage(): React.JSX.Element {
  const [feed, setFeed] = useState<HomeFeedResponse | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [offlineFallback, setOfflineFallback] = useState(false);
  const [continueItems, setContinueItems] = useState<ContinueItem[]>([]);
  const [favoriteItems, setFavoriteItems] = useState<ComicSummary[]>([]);

  const favorites = useLibrary((s) => s.favorites);
  const progress = useLibrary((s) => s.progress);
  const hydrated = useLibrary((s) => s.hydrated);

  const load = useCallback(async () => {
    setError(null);
    setOfflineFallback(false);
    bootStage('home-ui', 'Loading Home shelves');

    try {
      const response = await api.home();
      const localAdapterLive = feedHasLocalAdapter(response);
      // Demo CBZ titles only belong on Home when the local adapter is mounted
      // (dev/e2e). Otherwise strip them so stale IndexedDB rows cannot resurface.
      const live = localAdapterLive ? response : withoutDemoSamples(response);
      setFeed(live);

      const purged = await purgeStaleLocalCatalog({ localAdapterLive }).catch(() => [] as string[]);
      if (purged.length > 0) {
        bootStage('home-ui', `Purged ${purged.length} local sample comics from cache`);
        dropPurgedFromLibrary(purged);
      }

      const toCache = [...live.hero, ...live.shelves.flatMap((s) => s.items)].map((c) => ({
        ...c,
        cachedAt: Date.now(),
      }));
      const writeCache = (): void => {
        void db.comics.bulkPut(toCache).catch(() => undefined);
      };
      const ric = (
        window as Window & {
          requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
        }
      ).requestIdleCallback;
      if (typeof ric === 'function') ric(writeCache, { timeout: 2500 });
      else window.setTimeout(writeCache, 100);
    } catch (err) {
      bootStage('home-ui', 'Home failed — checking offline cache');
      const cached = await catalogCacheForUi(40);
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
    let cancelled = false;
    void (async () => {
      const cached = await catalogCacheForUi(40);
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
  }, [load]);

  // Build Continue + Favourites whenever local library or feed changes.
  useEffect(() => {
    if (!hydrated) return;
    let cancelled = false;

    void (async () => {
      const catalog = await buildCatalogIndex(feed);
      if (cancelled) return;

      const continueRows = await buildContinueItems(progress, catalog);
      if (cancelled) return;
      setContinueItems(continueRows);

      const favs: ComicSummary[] = [];
      for (const id of favorites) {
        const comic = catalog.get(id);
        if (comic) favs.push(comic);
      }
      // Preserve roughly newest-favourite order when we only have a Set:
      // fall back to catalog encounter order from IndexedDB cache time.
      setFavoriteItems(favs);
    })();

    return () => {
      cancelled = true;
    };
  }, [hydrated, feed, favorites, progress]);

  const catalogItems = useMemo(() => {
    if (!feed) return [] as ComicSummary[];
    const hideDemos = !feedHasLocalAdapter(feed);
    const seen = new Set<string>();
    const items: ComicSummary[] = [];
    for (const comic of [...feed.hero, ...feed.shelves.flatMap((s) => s.items)]) {
      if (hideDemos && isDemoSampleComic(comic)) continue;
      if (seen.has(comic.id)) continue;
      seen.add(comic.id);
      items.push(comic);
    }
    return items;
  }, [feed]);

  const { comicsShelf, mangaShelf } = useMemo(() => {
    const comics: ComicSummary[] = [];
    const manga: ComicSummary[] = [];
    for (const comic of catalogItems) {
      if (looksLikeManga(comic)) manga.push(comic);
      else comics.push(comic);
    }
    return { comicsShelf: comics, mangaShelf: manga };
  }, [catalogItems]);

  if (loading && !feed) {
    return <BootScreen title="Loading library" subtitle="Fetching popular comics…" />;
  }
  if (error && !feed) return <ErrorState error={error} onRetry={load} />;
  if (!feed) return <EmptyState title="Nothing here yet" />;

  const hasLocal = continueItems.length > 0 || favoriteItems.length > 0;
  const hasCatalog = comicsShelf.length > 0 || mangaShelf.length > 0;
  if (!hasLocal && !hasCatalog) {
    return (
      <EmptyState
        title="Library is empty"
        description="Enable a source on the server (LOCAL_LIBRARY_DIR, OPDS_CATALOGS, or COMX_ENABLED with COMX_LOGIN/COMX_PASSWORD), then restart."
      />
    );
  }

  return (
    <div className="pb-24 pt-4">
      <header className="mb-2 px-4">
        <h1 className="text-lg font-bold text-tg-text">Home</h1>
        <p className="mt-1 text-sm text-tg-hint">Pick up where you left off, then browse what’s new.</p>
      </header>

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

      <ContinueSection items={continueItems} />

      {favoriteItems.length > 0 && (
        <CoverShelf title="Favourites" items={favoriteItems} />
      )}

      {(comicsShelf.length > 0 || mangaShelf.length > 0) && (
        <section className="mt-8">
          <div className="mb-1 px-4">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-tg-subtitle">
              New
            </h2>
            <p className="mt-1 text-xs text-tg-hint">Fresh from the catalog</p>
          </div>

          {comicsShelf.length > 0 && (
            <CoverShelf title="Comics" items={comicsShelf} nested />
          )}
          {mangaShelf.length > 0 && (
            <CoverShelf title="Manga" items={mangaShelf} nested />
          )}
        </section>
      )}
    </div>
  );
}

function ContinueSection({ items }: { items: ContinueItem[] }): React.JSX.Element {
  const navigate = useNavigate();
  const { impact } = useHaptics();

  return (
    <section className="mt-5">
      <div className="mb-2 px-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-tg-subtitle">
          Continue reading
        </h2>
      </div>

      {items.length === 0 ? (
        <p className="mx-4 rounded-xl bg-tg-secondary-bg px-4 py-3 text-sm text-tg-hint">
          Open a comic and turn a few pages — your next three titles show up here with progress.
        </p>
      ) : (
        <ul className="space-y-2 px-4">
          {items.map(({ comic, progress, percent }) => (
            <li key={comic.id}>
              <button
                type="button"
                onClick={() => {
                  impact('medium');
                  void navigate(
                    `/read/${encodeURIComponent(progress.chapterId)}?page=${progress.pageIndex}`,
                  );
                }}
                className="flex w-full items-center gap-3 rounded-xl bg-tg-secondary-bg p-3 text-left"
              >
                <CoverImage
                  src={comic.coverUrl}
                  alt={comic.title}
                  eager
                  className="w-12 shrink-0 !rounded-lg"
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-tg-text">{comic.title}</p>
                  {comic.authors.length > 0 && (
                    <p className="mt-0.5 truncate text-xs text-tg-hint">
                      {comic.authors.join(', ')}
                    </p>
                  )}
                  <div className="mt-2 flex items-center gap-2">
                    <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-black/30">
                      <div
                        className="h-full rounded-full bg-tg-button"
                        style={{ width: `${percent}%` }}
                      />
                    </div>
                    <span className="shrink-0 tabular-nums text-[11px] font-medium text-tg-link">
                      {percent}%
                    </span>
                  </div>
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function CoverShelf({
  title,
  items,
  nested = false,
}: {
  title: string;
  items: ComicSummary[];
  nested?: boolean;
}): React.JSX.Element {
  const visible = items.slice(0, SHELF_VISIBLE);
  return (
    <section className={nested ? 'mt-4' : 'mt-8'}>
      <div className="mb-2 flex items-baseline justify-between px-4">
        <h2
          className={
            nested
              ? 'text-base font-semibold text-tg-text'
              : 'text-sm font-semibold uppercase tracking-wide text-tg-subtitle'
          }
        >
          {title}
        </h2>
        <span className="text-xs text-tg-hint">{items.length}</span>
      </div>

      <div className="no-scrollbar flex gap-3 overflow-x-auto px-4">
        {visible.map((comic) => (
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

async function catalogCacheForUi(limit: number): Promise<ComicSummary[]> {
  const cached = await db.comics.orderBy('cachedAt').reverse().limit(limit * 2).toArray();
  // Prefer remote catalog rows so demo local stubs do not paint over com-x.
  const remote = cached.filter((c) => !c.id.startsWith('local:') && !isDemoSampleComic(c));
  const picked = remote.length > 0 ? remote : cached.filter((c) => !isDemoSampleComic(c));
  return picked.slice(0, limit);
}

function feedHasLocalAdapter(feed: HomeFeedResponse): boolean {
  return (
    feed.shelves.some((s) => s.id === 'local') ||
    feed.hero.some((c) => c.id.startsWith('local:'))
  );
}

function withoutDemoSamples(feed: HomeFeedResponse): HomeFeedResponse {
  return {
    ...feed,
    hero: feed.hero.filter((c) => !isDemoSampleComic(c)),
    shelves: feed.shelves
      .map((s) => ({ ...s, items: s.items.filter((c) => !isDemoSampleComic(c)) }))
      .filter((s) => s.items.length > 0),
  };
}

function dropPurgedFromLibrary(purgedIds: string[]): void {
  const purged = new Set(purgedIds);
  useLibrary.setState((s) => {
    const favorites = new Set([...s.favorites].filter((id) => !purged.has(id)));
    const progress = new Map(
      [...s.progress.entries()].filter(([, row]) => !purged.has(row.comicId)),
    );
    const history = s.history.filter((id) => !purged.has(id));
    return { favorites, progress, history };
  });
  void db.kv
    .get('history')
    .then(async (row) => {
      if (!row || !Array.isArray(row.value)) return;
      const next = (row.value as string[]).filter((id) => !purged.has(id));
      await db.kv.put({ key: 'history', value: next });
    })
    .catch(() => undefined);
}

async function buildCatalogIndex(
  feed: HomeFeedResponse | null,
): Promise<Map<string, ComicSummary>> {
  const map = new Map<string, ComicSummary>();
  const hideDemos = !feed || !feedHasLocalAdapter(feed);
  const cached = hideDemos
    ? await catalogCacheForUi(200)
    : (await db.comics.orderBy('cachedAt').reverse().limit(200).toArray());
  for (const comic of cached) map.set(comic.id, comic);
  if (feed) {
    for (const comic of [...feed.hero, ...feed.shelves.flatMap((s) => s.items)]) {
      if (hideDemos && isDemoSampleComic(comic)) continue;
      map.set(comic.id, comic);
    }
  }
  return map;
}

async function buildContinueItems(
  progress: Map<string, ReadingProgress>,
  catalog: Map<string, ComicSummary>,
): Promise<ContinueItem[]> {
  const latestByComic = new Map<string, ReadingProgress>();
  for (const entry of progress.values()) {
    const prev = latestByComic.get(entry.comicId);
    if (!prev || entry.updatedAt > prev.updatedAt) {
      latestByComic.set(entry.comicId, entry);
    }
  }

  const ranked = [...latestByComic.entries()].sort((a, b) => b[1].updatedAt - a[1].updatedAt);

  const rows: ContinueItem[] = [];
  for (const [comicId, prog] of ranked) {
    if (rows.length >= 3) break;

    let comic = catalog.get(comicId);
    if (!comic) {
      const stored = await db.comics.get(comicId);
      if (stored) comic = stored;
    }
    // Hide procedural sample titles once the local library source is gone.
    if (!comic || (isDemoSampleComic(comic) && comic.id.startsWith('local:'))) continue;

    const chapters = await db.chapters.where('comicId').equals(comicId).toArray();
    const percent = estimateComicPercent(prog, chapters, comic.chapterCount);
    rows.push({ comic, progress: prog, percent });
  }
  return rows;
}

/** Whole-title % when we know chapter order; otherwise page % of the open issue. */
function estimateComicPercent(
  progress: ReadingProgress,
  chapters: StoredChapter[],
  chapterCountHint: number | null,
): number {
  const pageFrac =
    progress.pageCount > 0
      ? Math.min(1, Math.max(0, (progress.pageIndex + 1) / progress.pageCount))
      : 0;

  if (chapters.length > 0) {
    const ordered = [...chapters].sort((a, b) => a.number - b.number);
    const idx = ordered.findIndex((c) => c.id === progress.chapterId);
    if (idx >= 0) {
      const total = Math.max(ordered.length, chapterCountHint ?? ordered.length);
      const value = ((idx + pageFrac) / total) * 100;
      return Math.min(100, Math.max(0, Math.round(value)));
    }
  }

  if (chapterCountHint && chapterCountHint > 0) {
    // Unknown chapter index — show in-issue progress only, capped.
    return Math.min(100, Math.max(0, Math.round(pageFrac * 100)));
  }

  return Math.min(100, Math.max(0, Math.round(pageFrac * 100)));
}

function looksLikeManga(comic: ComicSummary): boolean {
  const haystack = [...comic.genres, comic.title, ...comic.authors].join(' ').toLowerCase();
  return /манг|manga|манхва|manhwa|маньхуа|manhua|манга/.test(haystack);
}
