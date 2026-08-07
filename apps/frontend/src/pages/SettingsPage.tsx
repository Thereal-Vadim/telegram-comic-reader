import { useCallback, useEffect, useState } from 'react';
import type { AdapterInfo, ComxSessionStatus } from '@comic/shared';
import { api, ApiClientError } from '../api/client';
import { ErrorState, Spinner } from '../components/states';
import { useHaptics } from '../telegram/hooks';

/**
 * Library status + com-x.life account connection.
 *
 * Connecting an account opens a real browser session on the server (human
 * pacing). That session is reused for catalog browsing now and file downloads
 * later — you “go inside” once, then the Mini App can use the site.
 */
export function SettingsPage(): React.JSX.Element {
  const [adapters, setAdapters] = useState<AdapterInfo[]>([]);
  const [comx, setComx] = useState<ComxSessionStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const hasComx = adapters.some((a) => a.kind === 'comx');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await api.adapters();
      setAdapters(response.adapters);
      if (response.adapters.some((a) => a.kind === 'comx')) {
        setComx(await api.comxSession());
      } else {
        setComx(null);
      }
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
          Connect the sources you want to read from. com-x.life needs your site
          login so the app can browse and later download from your account.
        </p>
      </header>

      {hasComx && (
        <ComxConnectCard
          status={comx}
          onChanged={(next) => {
            setComx(next);
            void load();
          }}
        />
      )}

      <section className="mt-6 space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-tg-subtitle">
          Connected
        </h2>

        {adapters.length === 0 ? (
          <p className="rounded-xl bg-tg-secondary-bg px-4 py-3 text-sm text-tg-hint">
            No library configured yet. Set <code className="text-tg-text">LOCAL_LIBRARY_DIR</code>{' '}
            or <code className="text-tg-text">COMX_ENABLED=true</code> in the backend env and
            restart.
          </p>
        ) : (
          adapters.map((adapter) => <LibraryCard key={adapter.id} adapter={adapter} />)
        )}
      </section>

      <section className="mt-8 space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-tg-subtitle">
          How sources work
        </h2>
        <ol className="list-decimal space-y-3 pl-5 text-sm leading-relaxed text-tg-hint">
          <li>
            <span className="text-tg-text">com-x.life</span>
            <br />
            Enable with <code className="text-tg-text">COMX_ENABLED=true</code>, then sign in
            above. One session covers catalog, reading, and future downloads.
          </li>
          <li>
            <span className="text-tg-text">Folder of CBZ/ZIP files</span>
            <br />
            Set <code className="text-tg-text">LOCAL_LIBRARY_DIR=/path/to/comics</code>.
          </li>
          <li>
            <span className="text-tg-text">Your OPDS server</span>
            <br />
            Set{' '}
            <code className="text-tg-text">
              OPDS_CATALOGS=My Library|https://your-server/opds|user|pass
            </code>
            .
          </li>
        </ol>
      </section>
    </div>
  );
}

function ComxConnectCard({
  status,
  onChanged,
}: {
  status: ComxSessionStatus | null;
  onChanged: (status: ComxSessionStatus) => void;
}): React.JSX.Element {
  const { impact, notify } = useHaptics();
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const connect = async (): Promise<void> => {
    if (!login.trim() || !password) return;
    setBusy(true);
    setMessage(null);
    try {
      const next = await api.connectComx(login.trim(), password);
      onChanged(next);
      setPassword('');
      impact('medium');
      notify('success');
      setMessage(
        next.connected
          ? 'Connected. Home can load your com-x catalog; the same session will be used for downloads.'
          : 'Signed in, but the session looks empty — try again.',
      );
    } catch (err) {
      notify('error');
      setMessage(err instanceof ApiClientError ? err.message : 'Could not connect to com-x.life');
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async (): Promise<void> => {
    setBusy(true);
    setMessage(null);
    try {
      const next = await api.disconnectComx();
      onChanged(next);
      impact('light');
      setMessage('Disconnected.');
    } catch (err) {
      notify('error');
      setMessage(err instanceof ApiClientError ? err.message : 'Could not disconnect');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-xl bg-tg-secondary-bg px-4 py-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-tg-text">com-x.life account</h2>
          <p className="mt-0.5 text-xs text-tg-hint">
            Sign in here to go inside the site from this Mini App.
          </p>
        </div>
        <span
          className={`shrink-0 rounded-md px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
            status?.connected
              ? 'bg-tg-button/15 text-tg-button'
              : 'bg-tg-destructive/15 text-tg-destructive'
          }`}
        >
          {status?.connected ? 'Inside' : 'Signed out'}
        </span>
      </div>

      {status?.connected ? (
        <div className="space-y-3">
          <p className="text-sm text-tg-text">
            Logged in as <span className="font-medium">{status.login ?? 'account'}</span>
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() => void disconnect()}
            className="w-full rounded-xl bg-tg-bg px-4 py-3 text-sm font-semibold text-tg-text disabled:opacity-50"
          >
            {busy ? 'Working…' : 'Disconnect'}
          </button>
        </div>
      ) : (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void connect();
          }}
        >
          <label className="block">
            <span className="mb-1 block text-xs text-tg-hint">Login</span>
            <input
              value={login}
              onChange={(e) => setLogin(e.target.value)}
              autoComplete="username"
              className="w-full rounded-xl bg-tg-bg px-3 py-2.5 text-sm text-tg-text outline-none ring-tg-button focus:ring-1"
              placeholder="Your com-x.life login"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-tg-hint">Password</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              className="w-full rounded-xl bg-tg-bg px-3 py-2.5 text-sm text-tg-text outline-none ring-tg-button focus:ring-1"
              placeholder="Password"
            />
          </label>
          <button
            type="submit"
            disabled={busy || !login.trim() || !password}
            className="w-full rounded-xl bg-tg-button px-4 py-3 text-sm font-semibold text-tg-button-text disabled:opacity-50"
          >
            {busy ? 'Signing in… (slow on purpose)' : 'Sign in to com-x.life'}
          </button>
          <p className="text-[11px] leading-relaxed text-tg-hint">
            Sign-in uses a real browser with human pacing so the site is less
            likely to block the account. This can take ~15–30 seconds.
          </p>
        </form>
      )}

      {message && <p className="mt-3 text-xs text-tg-hint">{message}</p>}
    </section>
  );
}

function LibraryCard({ adapter }: { adapter: AdapterInfo }): React.JSX.Element {
  const blurb =
    adapter.kind === 'local'
      ? 'CBZ / ZIP files from LOCAL_LIBRARY_DIR on this server.'
      : adapter.kind === 'opds'
        ? 'OPDS catalog you configured (Kavita, Komga, Calibre-Web, …).'
        : adapter.kind === 'comx'
          ? 'com-x.life — connect your account above to browse and download.'
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
