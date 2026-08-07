import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { AdapterInfo, ImportListResponse, ImportResult } from '@comic/shared';
import { api, ApiClientError } from '../api/client';
import { ErrorState, Spinner } from '../components/states';
import { cacheChapters, cacheComic } from '../db/storage';
import { downloads } from '../workers/downloadManager';
import { useHaptics } from '../telegram/hooks';

type ImportItem = ImportListResponse['items'][number];

/**
 * Sources + personal URL import.
 *
 * Catalog adapters (Archive.org, OPDS, local disk) stay listed below. Above
 * them, the user can paste a link to a comic they already own — Google Drive,
 * Dropbox, a direct CBZ/ZIP, or a page of images on their own site. After the
 * backend parses the link, pages are queued into IndexedDB so the next open
 * is fully offline.
 */
export function SettingsPage(): React.JSX.Element {
  const navigate = useNavigate();
  const { impact, notify } = useHaptics();

  const [adapters, setAdapters] = useState<AdapterInfo[]>([]);
  const [imports, setImports] = useState<ImportItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [lastImport, setLastImport] = useState<ImportResult | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [adapterResponse, importResponse] = await Promise.all([
        api.adapters(),
        api.listImports().catch(() => ({ items: [] as ImportItem[] })),
      ]);
      setAdapters(adapterResponse.adapters.filter((a) => a.kind !== 'import'));
      setImports(importResponse.items);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onImport = useCallback(async () => {
    const trimmed = url.trim();
    if (!trimmed || importing) return;

    setImporting(true);
    setImportError(null);
    setLastImport(null);
    impact('light');

    try {
      const result = await api.importUrl({
        url: trimmed,
        ...(title.trim() ? { title: title.trim() } : {}),
      });

      await cacheComic({ ...result.comic, cachedAt: Date.now() });
      await cacheChapters(result.chapters);

      // Immediately pull page binaries into IndexedDB so a second open never
      // depends on Drive / Dropbox / the origin site being reachable.
      const chapter = result.chapters[0];
      if (chapter) {
        await downloads.enqueueChapter({
          chapterId: chapter.id,
          comicId: result.comic.id,
          comicTitle: result.comic.title,
          chapterTitle: chapter.title,
          pageCount: chapter.pageCount,
        });
      }

      setLastImport({ ...result, offlineQueued: true });
      setUrl('');
      setTitle('');
      notify('success');
      await load();
    } catch (err) {
      notify('error');
      const message =
        err instanceof ApiClientError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Import failed';
      setImportError(message);
    } finally {
      setImporting(false);
    }
  }, [url, title, importing, impact, notify, load]);

  const onDelete = useCallback(
    async (item: ImportItem) => {
      impact('medium');
      try {
        await api.deleteImport(item.comic.id);
        setImports((prev) => prev.filter((i) => i.comic.id !== item.comic.id));
        notify('success');
      } catch (err) {
        notify('error');
        setImportError(err instanceof Error ? err.message : 'Could not delete import');
      }
    },
    [impact, notify],
  );

  const onPaste = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text.trim()) {
        setUrl(text.trim());
        impact('light');
      }
    } catch {
      // Clipboard permission denied in some WebViews; the input still works.
    }
  }, [impact]);

  if (loading && adapters.length === 0 && imports.length === 0) {
    return <Spinner label="Loading sources" />;
  }
  if (error && adapters.length === 0 && imports.length === 0) {
    return <ErrorState error={error} onRetry={load} />;
  }

  return (
    <div className="px-4 pb-24 pt-4">
      <header className="mb-6">
        <h1 className="text-lg font-bold text-tg-text">Sources</h1>
        <p className="mt-1 text-sm text-tg-hint">
          Import comics you already own from a link, or browse the catalogs
          configured on this server.
        </p>
      </header>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-tg-subtitle">
          Import by link
        </h2>
        <p className="text-sm leading-relaxed text-tg-hint">
          Paste a Google Drive, Dropbox, or OneDrive share link, a direct
          CBZ/ZIP URL, or a page of images from your own site. Pages are saved
          on this device for offline reading.
        </p>

        <label className="block">
          <span className="sr-only">Import URL</span>
          <input
            type="url"
            inputMode="url"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder="https://drive.google.com/file/d/…/view"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            disabled={importing}
            className="w-full rounded-xl border border-white/10 bg-tg-secondary-bg px-3 py-3 text-sm text-tg-text outline-none placeholder:text-tg-hint focus:border-tg-link"
          />
        </label>

        <label className="block">
          <span className="sr-only">Optional title</span>
          <input
            type="text"
            placeholder="Title (optional)"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            disabled={importing}
            className="w-full rounded-xl border border-white/10 bg-tg-secondary-bg px-3 py-3 text-sm text-tg-text outline-none placeholder:text-tg-hint focus:border-tg-link"
          />
        </label>

        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => void onPaste()}
            disabled={importing}
            className="rounded-xl bg-tg-secondary-bg px-4 py-3 text-sm font-medium text-tg-link disabled:opacity-50"
          >
            Paste
          </button>
          <button
            type="button"
            onClick={() => void onImport()}
            disabled={importing || !url.trim()}
            className="flex-1 rounded-xl bg-tg-button px-4 py-3 text-sm font-semibold text-tg-button-text disabled:opacity-50"
          >
            {importing ? 'Importing…' : 'Import'}
          </button>
        </div>

        {importError && (
          <p className="rounded-xl bg-tg-destructive/15 px-3 py-2 text-sm text-tg-destructive">
            {importError}
          </p>
        )}

        {lastImport && (
          <div className="rounded-xl bg-tg-secondary-bg px-4 py-3">
            <p className="text-sm font-semibold text-tg-text">{lastImport.comic.title}</p>
            <p className="mt-0.5 text-xs text-tg-hint">
              {lastImport.kind === 'archive' ? 'Archive' : 'Web page'} ·{' '}
              {lastImport.chapters[0]?.pageCount ?? 0} pages · saving offline…
            </p>
            <button
              type="button"
              onClick={() => {
                impact('light');
                void navigate(`/comic/${encodeURIComponent(lastImport.comic.id)}`);
              }}
              className="mt-3 text-xs font-medium text-tg-link"
            >
              Open comic →
            </button>
          </div>
        )}
      </section>

      <section className="mt-8 space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-tg-subtitle">
          My imports
        </h2>
        {imports.length === 0 ? (
          <p className="text-sm text-tg-hint">Nothing imported yet.</p>
        ) : (
          imports.map((item) => (
            <article key={item.comic.id} className="rounded-xl bg-tg-secondary-bg px-4 py-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <Link
                    to={`/comic/${encodeURIComponent(item.comic.id)}`}
                    className="block truncate text-sm font-semibold text-tg-text"
                  >
                    {item.comic.title}
                  </Link>
                  <p className="mt-0.5 text-xs text-tg-hint">
                    {item.kind === 'archive' ? 'Archive' : 'Web page'} · {item.pageCount} pages
                  </p>
                  <p className="mt-1 truncate text-[11px] text-tg-hint">{item.sourceUrl}</p>
                </div>
                <button
                  type="button"
                  onClick={() => void onDelete(item)}
                  className="shrink-0 text-xs font-medium text-tg-destructive"
                >
                  Remove
                </button>
              </div>
            </article>
          ))
        )}
      </section>

      <section className="mt-8 space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-tg-subtitle">
          Connected catalogs
        </h2>

        {adapters.length === 0 ? (
          <p className="text-sm text-tg-hint">No server catalogs are configured.</p>
        ) : (
          adapters.map((adapter) => <SourceCard key={adapter.id} adapter={adapter} />)
        )}
      </section>

      <section className="mt-8 space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-tg-subtitle">
          About licensing
        </h2>
        <p className="text-sm leading-relaxed text-tg-hint">
          Link import is for comics you already have the right to read — purchases
          on your Drive, files from your own OPDS, or pages you host. The Internet
          Archive catalog only lists titles with an explicit Creative Commons or
          public-domain license.
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
    case 'import':
      return {
        blurb: 'Comics you imported from personal links.',
        href: null,
        linkLabel: '',
      };
    default:
      return { blurb: adapter.kind, href: null, linkLabel: '' };
  }
}
