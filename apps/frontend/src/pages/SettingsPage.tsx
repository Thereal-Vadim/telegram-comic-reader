import { useCallback, useEffect, useState } from 'react';
import type { AdapterInfo } from '@comic/shared';
import { api } from '../api/client';
import { ErrorState, Spinner } from '../components/states';

/**
 * Sources the library is reading from.
 *
 * This is deliberately not a free-form “paste any website URL” box. Arbitrary
 * site scraping is how piracy frontends get built; instead we surface the
 * licensed / open sources the backend is configured for, with a clear link to
 * each one so the user can see where the files come from and download them
 * under that source's own terms.
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

  if (loading && adapters.length === 0) return <Spinner label="Loading sources" />;
  if (error && adapters.length === 0) return <ErrorState error={error} onRetry={load} />;

  return (
    <div className="px-4 pb-24 pt-4">
      <header className="mb-6">
        <h1 className="text-lg font-bold text-tg-text">Sources</h1>
        <p className="mt-1 text-sm text-tg-hint">
          Libraries this app can browse and download from. Only openly licensed
          or self-hosted catalogs are supported.
        </p>
      </header>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-tg-subtitle">
          Connected
        </h2>

        {adapters.length === 0 ? (
          <p className="text-sm text-tg-hint">No sources are configured on the server.</p>
        ) : (
          adapters.map((adapter) => <SourceCard key={adapter.id} adapter={adapter} />)
        )}
      </section>

      <section className="mt-8 space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-tg-subtitle">
          About licensing
        </h2>
        <p className="text-sm leading-relaxed text-tg-hint">
          The Internet Archive source only lists comics whose metadata carries
          a Creative Commons or public-domain license. Copyrighted uploads on
          archive.org are filtered out on purpose.
        </p>
        <a
          href="https://archive.org/details/comics"
          target="_blank"
          rel="noreferrer"
          className="inline-block text-sm font-medium text-tg-link"
        >
          Browse Internet Archive Comics →
        </a>
      </section>
    </div>
  );
}

function SourceCard({ adapter }: { adapter: AdapterInfo }): React.JSX.Element {
  const meta = describeSource(adapter);

  return (
    <article className="rounded-xl bg-tg-secondary-bg px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold text-tg-text">{adapter.label}</h3>
          <p className="mt-0.5 text-xs text-tg-hint">{meta.blurb}</p>
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

      {meta.href && (
        <a
          href={meta.href}
          target="_blank"
          rel="noreferrer"
          className="mt-3 inline-block text-xs font-medium text-tg-link"
        >
          {meta.linkLabel}
        </a>
      )}
    </article>
  );
}

function describeSource(adapter: AdapterInfo): {
  blurb: string;
  href: string | null;
  linkLabel: string;
} {
  switch (adapter.kind) {
    case 'archive':
      return {
        blurb: 'Public-domain and Creative Commons comics from archive.org.',
        href: 'https://archive.org/details/comics',
        linkLabel: 'Open licensed catalog →',
      };
    case 'opds':
      return {
        blurb: 'Self-hosted OPDS catalog (Kavita, Komga, Calibre-Web, …).',
        href: null,
        linkLabel: '',
      };
    case 'local':
      return {
        blurb: 'CBZ / CBR / PDF files on the server disk.',
        href: null,
        linkLabel: '',
      };
    default:
      return { blurb: adapter.kind, href: null, linkLabel: '' };
  }
}
