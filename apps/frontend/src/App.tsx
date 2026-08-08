import { Suspense, lazy, useEffect } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { bootOk, bootStage } from './boot/log';
import { Spinner } from './components/states';
import { HomePage } from './pages/HomePage';
import { useLibrary } from './store/library';
import { downloads } from './workers/downloadManager';

/**
 * App shell and routing.
 *
 * Home stays eager (default landing). Everything else — including the ~600 KB
 * three.js reader — is code-split so a cold open that only browses the catalog
 * never pays for detail/search/downloads/settings/WebGL parse time.
 */
const SearchPage = lazy(() =>
  import('./pages/SearchPage').then((m) => ({ default: m.SearchPage })),
);
const ComicDetailPage = lazy(() =>
  import('./pages/ComicDetailPage').then((m) => ({ default: m.ComicDetailPage })),
);
const ChapterPage = lazy(() =>
  import('./pages/ChapterPage').then((m) => ({ default: m.ChapterPage })),
);
const ReaderPage = lazy(() =>
  import('./pages/ReaderPage').then((m) => ({ default: m.ReaderPage })),
);
const DownloadsPage = lazy(() =>
  import('./pages/DownloadsPage').then((m) => ({ default: m.DownloadsPage })),
);
const SettingsPage = lazy(() =>
  import('./pages/SettingsPage').then((m) => ({ default: m.SettingsPage })),
);

function scheduleIdle(task: () => void): void {
  const ric = (
    window as Window & {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
    }
  ).requestIdleCallback;
  if (typeof ric === 'function') {
    ric(task, { timeout: 2000 });
    return;
  }
  window.setTimeout(task, 250);
}

export function App(): React.JSX.Element {
  const hydrate = useLibrary((s) => s.hydrate);
  const location = useLocation();

  useEffect(() => {
    bootStage('indexeddb', 'Reading favourites and progress');
    void hydrate().then(() => bootOk('indexeddb', 'local library ready'));
    // Resume downloads after first paint so they do not contend with Home.
    scheduleIdle(() => {
      void downloads.restore();
    });
  }, [hydrate]);

  // Reader is full-bleed; chapter hub keeps a sticky action bar — hide tabs on both.
  const hideTabs =
    location.pathname.startsWith('/read/') || location.pathname.startsWith('/chapter/');

  // Shell renders immediately. Hydration runs in the background; the journal
  // protects favourites/progress taps that race the Dexie open.
  return (
    <div className="flex min-h-viewport flex-col bg-tg-bg text-tg-text">
      <main className="flex-1">
        <Suspense fallback={<Spinner label="Loading…" />}>
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/search" element={<SearchPage />} />
            <Route path="/comic/:id" element={<ComicDetailPage />} />
            <Route path="/chapter/:chapterId" element={<ChapterPage />} />
            <Route path="/read/:chapterId" element={<ReaderPage />} />
            <Route path="/downloads" element={<DownloadsPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
      </main>

      {!hideTabs && <TabBar />}
    </div>
  );
}

function TabBar(): React.JSX.Element {
  const tabs = [
    { to: '/', label: 'Home' },
    { to: '/search', label: 'Search' },
    { to: '/downloads', label: 'Downloaded' },
    { to: '/settings', label: 'Settings' },
  ] as const;

  return (
    <nav className="sticky bottom-0 z-20 border-t border-white/5 bg-tg-header-bg pb-safe">
      <div className="flex">
        {tabs.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            end={tab.to === '/'}
            className={({ isActive }) =>
              `flex-1 py-3 text-center text-xs font-medium transition-colors ${
                isActive ? 'text-tg-link' : 'text-tg-hint'
              }`
            }
          >
            {tab.label}
          </NavLink>
        ))}
      </div>
    </nav>
  );
}
