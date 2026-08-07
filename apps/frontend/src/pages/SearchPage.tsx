import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { ComicSummary } from '@comic/shared';
import { api } from '../api/client';
import { CoverImage } from '../components/CoverImage';
import { EmptyState, ErrorState, Spinner } from '../components/states';

/**
 * Search with debounced queries and genre filtering.
 *
 * The debounce is 300 ms and every request carries an AbortSignal, so typing
 * quickly cancels the in-flight lookups rather than racing them. Without the
 * abort, a slow early query can resolve after a fast later one and overwrite
 * the newer results with stale ones.
 */
export function SearchPage(): React.JSX.Element {
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [results, setResults] = useState<ComicSummary[]>([]);
  const [genre, setGenre] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [searched, setSearched] = useState(false);

  const inFlight = useRef<AbortController | null>(null);

  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(query), 300);
    return () => window.clearTimeout(id);
  }, [query]);

  const run = useCallback(async (q: string, activeGenre: string | null) => {
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;

    setLoading(true);
    setError(null);

    try {
      const response = await api.search({
        q,
        ...(activeGenre ? { genre: activeGenre } : {}),
      });
      if (controller.signal.aborted) return;
      setResults(response.items);
      setSearched(true);
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(err);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    // An empty query with no genre is the browse-everything case, which the
    // backend handles as an unfiltered listing.
    void run(debounced, genre);
  }, [debounced, genre, run]);

  useEffect(() => () => inFlight.current?.abort(), []);

  // Genre chips are derived from whatever came back rather than hardcoded,
  // since the available genres depend entirely on the configured sources.
  const genres = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of results) {
      for (const g of item.genres) counts.set(g, (counts.get(g) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([name]) => name);
  }, [results]);

  return (
    <div className="pb-24">
      <div className="sticky top-0 z-10 bg-tg-bg px-4 pb-3 pt-3">
        <input
          type="search"
          inputMode="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search your library"
          aria-label="Search comics"
          className="w-full rounded-xl bg-tg-secondary-bg px-4 py-2.5 text-base text-tg-text placeholder:text-tg-hint focus:outline-none focus:ring-2 focus:ring-tg-button"
        />

        {genres.length > 0 && (
          <div className="no-scrollbar mt-2 flex gap-2 overflow-x-auto">
            {genre && (
              <button
                type="button"
                onClick={() => setGenre(null)}
                className="shrink-0 rounded-full bg-tg-button px-3 py-1 text-xs font-medium text-tg-button-text"
              >
                Clear
              </button>
            )}
            {genres.map((g) => (
              <button
                key={g}
                type="button"
                onClick={() => setGenre(g === genre ? null : g)}
                className={`shrink-0 rounded-full px-3 py-1 text-xs ${
                  g === genre
                    ? 'bg-tg-button text-tg-button-text'
                    : 'bg-tg-secondary-bg text-tg-hint'
                }`}
              >
                {g}
              </button>
            ))}
          </div>
        )}
      </div>

      {loading && results.length === 0 && <Spinner />}
      {/* Ternary rather than `&&`: `error` is `unknown`, and the truthy branch
          of `&&` would widen the expression to something React cannot render. */}
      {error ? <ErrorState error={error} onRetry={() => void run(debounced, genre)} /> : null}

      {!loading && !error && searched && results.length === 0 && (
        <EmptyState
          title="No matches"
          description={query ? `Nothing matched "${query}".` : 'This source returned no items.'}
        />
      )}

      <div className="grid grid-cols-3 gap-3 px-4 pt-2 sm:grid-cols-4">
        {results.map((comic) => (
          <Link key={comic.id} to={`/comic/${encodeURIComponent(comic.id)}`}>
            <CoverImage src={comic.coverUrl} alt={comic.title} />
            <p className="mt-1.5 line-clamp-2 text-xs leading-tight text-tg-text">{comic.title}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
