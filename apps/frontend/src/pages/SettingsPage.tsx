import { useCallback, useEffect, useState } from 'react';
import type { AdapterInfo } from '@comic/shared';
import { api } from '../api/client';
import { ErrorState, Spinner } from '../components/states';

/**
 * Library status — what YOU pointed the server at.
 *
 * The app does not browse or scrape any third-party comic site. Content only
 * appears after the operator sets LOCAL_LIBRARY_DIR and/or OPDS_CATALOGS on
 * the backend. This screen just shows whether those hooks are live.
 */
export function SettingsPage(): React.JSX.Element {
  const [adapters, setAdapters] = useState<AdapterInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await api.adapters();
      setAdapters(response.adapters);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading && adapters.length === 0) return <Spinner label="Loading library" />;
  if (error && adapters.length === 0) return <ErrorState error={error} onRetry={load} />;

  return (
    <div className="px-4 pb-24 pt-4">
      <header className="mb-6">
        <h1 className="text-lg font-bold text-tg-text">Library</h1>
        <p className="mt-1 text-sm text-tg-hint">
          Comics come only from the folders and catalogs you configure on the
          server. Nothing is pulled from public websites by default.
        </p>
      </header>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-tg-subtitle">
          Connected
        </h2>

        {adapters.length === 0 ? (
          <p className="rounded-xl bg-tg-secondary-bg px-4 py-3 text-sm text-tg-hint">
            No library configured yet. Set <code className="text-tg-text">LOCAL_LIBRARY_DIR</code>{' '}
            or <code className="text-tg-text">OPDS_CATALOGS</code> in the backend env and restart.
          </p>
        ) : (
          adapters.map((adapter) => <LibraryCard key={adapter.id} adapter={adapter} />)
        )}
      </section>

      <section className="mt-8 space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-tg-subtitle">
          How to point the app at your files
        </h2>
        <ol className="list-decimal space-y-3 pl-5 text-sm leading-relaxed text-tg-hint">
          <li>
            <span className="text-tg-text">Folder of CBZ/ZIP files</span>
            <br />
            Set <code className="text-tg-text">LOCAL_LIBRARY_DIR=/path/to/comics</code>. Layout:{' '}
            <code className="text-tg-text">Series/Chapter 01.cbz</code> or a bare{' '}
            <code className="text-tg-text">Title.cbz</code>.
          </li>
          <li>
            <span className="text-tg-text">Your OPDS server</span>
            <br />
            Set{' '}
            <code className="text-tg-text">
              OPDS_CATALOGS=My Library|https://your-server/opds|user|pass
            </code>{' '}
            (user/pass optional). Works with Kavita, Komga, Calibre-Web, etc.
          </li>
          <li>
            Restart the backend. This screen and Home will list whatever those
            hooks expose — you choose the origin.
          </li>
        </ol>
        <p className="text-xs text-tg-hint">
          Full template: <code className="text-tg-text">.env.example</code> in the repo root.
        </p>
      </section>
    </div>
  );
}

function LibraryCard({ adapter }: { adapter: AdapterInfo }): React.JSX.Element {
  const blurb =
    adapter.kind === 'local'
      ? 'CBZ / ZIP files from LOCAL_LIBRARY_DIR on this server.'
      : adapter.kind === 'opds'
        ? 'OPDS catalog you configured (Kavita, Komga, Calibre-Web, …).'
        : adapter.kind;

  return (
    <article className="rounded-xl bg-tg-secondary-bg px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold text-tg-text">{adapter.label}</h3>
          <p className="mt-0.5 text-xs text-tg-hint">{blurb}</p>
        </div>
        <span
          className={`shrink-0 rounded-md px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
            adapter.healthy
              ? 'bg-tg-button/15 text-tg-button'
              : 'bg-tg-destructive/15 text-tg-destructive'
          }`}
        >
          {adapter.healthy ? 'Online' : 'Offline'}
        </span>
      </div>
    </article>
  );
}
