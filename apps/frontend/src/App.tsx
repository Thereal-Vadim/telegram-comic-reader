import { Suspense, lazy, useEffect } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { bootOk, bootStage } from './boot/log';
import { BootScreen } from './components/BootScreen';
import { Spinner } from './components/states';
import { HomePage } from './pages/HomePage';
import { SearchPage } from './pages/SearchPage';
import { ComicDetailPage } from './pages/ComicDetailPage';
import { DownloadsPage } from './pages/DownloadsPage';
import { SettingsPage } from './pages/SettingsPage';
import { useLibrary } from './store/library';
import { downloads } from './workers/downloadManager';

/**
 * App shell and routing.
 *
 * The reader is code-split. It pulls in three plus the R3F runtime, roughly
 * 600 KB, which would otherwise be parsed on every cold start including the
 * many where the user only browses the catalog.
 */
const ReaderPage = lazy(() =>
  import('./pages/ReaderPage').then((m) => ({ default: m.ReaderPage })),
);

export function App(): React.JSX.Element {
  const hydrate = useLibrary((s) => s.hydrate);
  const hydrated = useLibrary((s) => s.hydrated);
  const location = useLocation();

  useEffect(() => {
    bootStage('indexeddb', 'Reading favourites and progress');
    void hydrate().then(() => bootOk('indexeddb', 'local library ready'));
    // Picks up anything interrupted by the previous session closing.
    void downloads.restore();
  }, [hydrate]);

  // The reader is full-bleed and supplies its own controls, so the tab bar is
  // hidden there rather than overlapping the page.
  const isReader = location.pathname.startsWith('/read/');

  // Nothing renders until favourites and progress are read back from Dexie.
  // The first IndexedDB open on a cold start can take longer than the first
  // API response, and a route that renders before then would show an unstarred
  // comic the user has favourited — worse, a tap in that window is silently
  // undone the moment hydration lands and replaces the store.
  if (!hydrated) {
    return <BootScreen title="Starting app" subtitle="Opening local library…" />;
  }

  return (
    <div className="flex min-h-viewport flex-col bg-tg-bg text-tg-text">
      <main className="flex-1">
        <Suspense fallback={<Spinner label="Loading reader" />}>
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/search" element={<SearchPage />} />
            <Route path="/comic/:id" element={<ComicDetailPage />} />
            <Route path="/read/:chapterId" element={<ReaderPage />} />
            <Route path="/downloads" element={<DownloadsPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
      </main>

      {!isReader && <TabBar />}
    </div>
  );
}

function TabBar(): React.JSX.Element {
  const tabs = [
    { to: '/', label: 'Home' },
    { to: '/search', label: 'Search' },
    { to: '/downloads', label: 'Downloads' },
    { to: '/settings', label: 'Library' },
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
