import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { ErrorState, Spinner } from '../components/states';
import { db } from '../db/schema';
import { getStoredPages, isChapterDownloaded } from '../db/storage';
import { ReaderCanvas, type ReaderPage as CanvasPage } from '../reader/ReaderCanvas';
import type { TextureStats } from '../reader/TextureManager';
import { useLibrary } from '../store/library';
import { useReaderSettings } from '../store/reader';
import { useBackButton, useHaptics } from '../telegram/hooks';

/**
 * The reading view.
 *
 * Page sources are chosen once per chapter: if the chapter is downloaded,
 * every page comes from an IndexedDB Blob and the reader never touches the
 * network; otherwise pages stream from the proxy. Deciding up front rather
 * than per page means a partially downloaded chapter cannot produce a
 * confusing mix where some pages work offline and others do not.
 *
 * Telegram SDK: native BackButton closes the reader; theme CSS variables drive
 * the chrome; HapticFeedback fires on page turns, commit threshold, and zoom.
 */
export function ReaderPage(): React.JSX.Element {
  const { chapterId: rawChapterId } = useParams<{ chapterId: string }>();
  const chapterId = rawChapterId ? decodeURIComponent(rawChapterId) : '';
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { impact } = useHaptics();

  const [pages, setPages] = useState<CanvasPage[]>([]);
  const [index, setIndex] = useState(() => Number(searchParams.get('page') ?? 0) || 0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [source, setSource] = useState<'offline' | 'network' | null>(null);
  const [stats, setStats] = useState<TextureStats | null>(null);
  const [title, setTitle] = useState('');

  const chromeVisible = useReaderSettings((s) => s.chromeVisible);
  const toggleChrome = useReaderSettings((s) => s.toggleChrome);
  const setChromeVisible = useReaderSettings((s) => s.setChromeVisible);
  const direction = useReaderSettings((s) => s.direction);
  const paperColor = useReaderSettings((s) => s.paperColor);
  const showStats = useReaderSettings((s) => s.showStats);

  const recordProgress = useLibrary((s) => s.recordProgress);

  // Native Telegram back control — restores prior visibility on unmount.
  useBackButton(useCallback(() => void navigate(-1), [navigate]));

  /* Resolve the page list, preferring local storage. */
  useEffect(() => {
    if (!chapterId) return;
    let cancelled = false;

    void (async () => {
      setLoading(true);
      setError(null);

      try {
        const chapter = await db.chapters.get(chapterId);
        if (!cancelled && chapter) setTitle(chapter.title);

        if (await isChapterDownloaded(chapterId)) {
          const stored = await getStoredPages(chapterId);
          if (cancelled) return;

          if (stored.length > 0) {
            setPages(
              stored.map((p) => ({
                id: p.id,
                index: p.index,
                // Blob sources skip the network entirely; createImageBitmap
                // reads them directly, so no object URL is ever allocated and
                // there is nothing to revoke. Offline zoom reuses the same
                // blob — sharper bytes were never stored.
                source: { kind: 'blob' as const, blob: p.blob },
                zoomSource: { kind: 'blob' as const, blob: p.blob },
                width: p.width,
                height: p.height,
              })),
            );
            setSource('offline');
            setLoading(false);
            return;
          }
        }

        const response = await api.pages(chapterId);
        if (cancelled) return;

        setPages(
          response.pages.map((p) => ({
            id: p.id,
            index: p.index,
            source: { kind: 'url' as const, url: api.imageUrl(p.url, 'screen') },
            // Hi-res variant for pinch / double-tap; TextureManager caps this
            // at one resident slot and disposes it when zoom ends.
            zoomSource: { kind: 'url' as const, url: api.imageUrl(p.url, 'zoom') },
            width: p.width,
            height: p.height,
          })),
        );
        setSource('network');
      } catch (err) {
        if (!cancelled) setError(err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [chapterId]);

  /* Persist progress, throttled so a fast scrub is not one write per page. */
  const progressTimer = useRef<number | null>(null);
  useEffect(() => {
    if (pages.length === 0) return;

    if (progressTimer.current !== null) window.clearTimeout(progressTimer.current);
    progressTimer.current = window.setTimeout(() => {
      void (async () => {
        const chapter = await db.chapters.get(chapterId);
        await recordProgress({
          chapterId,
          comicId: chapter?.comicId ?? chapterId,
          pageIndex: index,
          pageCount: pages.length,
        });
      })();
    }, 600);

    return () => {
      if (progressTimer.current !== null) window.clearTimeout(progressTimer.current);
    };
  }, [index, pages.length, chapterId, recordProgress]);

  /* Keep the URL in sync so a reload resumes on the same page. */
  useEffect(() => {
    const current = Number(searchParams.get('page') ?? 0);
    if (current !== index) {
      setSearchParams({ page: String(index) }, { replace: true });
    }
  }, [index, searchParams, setSearchParams]);

  // Hide the chrome on entry: the reader should open to a full page, not a
  // page framed by controls the user has to dismiss.
  useEffect(() => {
    setChromeVisible(false);
  }, [setChromeVisible]);

  const handleIndexChange = useCallback(
    (next: number) => {
      setIndex(next);
      impact('light');
    },
    [impact],
  );

  const handleZoomChange = useCallback(
    (zoomed: boolean) => {
      impact(zoomed ? 'medium' : 'soft');
    },
    [impact],
  );

  const clampedIndex = useMemo(
    () => Math.max(0, Math.min(index, Math.max(0, pages.length - 1))),
    [index, pages.length],
  );

  if (loading) return <Spinner label="Opening chapter" />;
  if (error) return <ErrorState error={error} onRetry={() => window.location.reload()} />;
  if (pages.length === 0) {
    return <ErrorState error={new Error('This chapter has no readable pages.')} />;
  }

  return (
    <div className="relative h-viewport w-full overflow-hidden bg-tg-bg">
      <ReaderCanvas
        pages={pages}
        index={clampedIndex}
        onIndexChange={handleIndexChange}
        onTapCentre={toggleChrome}
        onThresholdCrossed={() => impact('soft')}
        onZoomChange={handleZoomChange}
        rtl={direction === 'rtl'}
        paperColor={paperColor}
        {...(showStats ? { onStats: setStats } : {})}
      />

      {/* Top chrome: title + close. Uses Telegram theme tokens so a theme
          change never remounts the WebGL canvas underneath. */}
      <div
        className={`pointer-events-none absolute inset-x-0 top-0 pt-safe transition-opacity duration-200 ${
          chromeVisible ? 'opacity-100' : 'opacity-0'
        }`}
      >
        <div className="pointer-events-auto flex items-center gap-3 bg-gradient-to-b from-tg-header-bg/95 to-transparent px-4 pb-6 pt-3">
          <button
            type="button"
            onClick={() => {
              impact('light');
              void navigate(-1);
            }}
            className="rounded-lg bg-tg-secondary-bg px-3 py-1.5 text-sm font-medium text-tg-link"
          >
            Close
          </button>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-tg-text">{title || 'Reading'}</p>
            <p className="truncate text-[11px] text-tg-hint">
              {source === 'offline' ? 'Offline · double-tap to zoom' : 'Streaming · double-tap to zoom'}
            </p>
          </div>
        </div>
      </div>

      {/* Bottom chrome: scrubber. Pointer-transparent when hidden so a tap
          while fading still reaches the reader surface. */}
      <div
        className={`pointer-events-none absolute inset-x-0 bottom-0 pb-safe transition-opacity duration-200 ${
          chromeVisible ? 'opacity-100' : 'opacity-0'
        }`}
      >
        <div className="pointer-events-auto bg-gradient-to-t from-tg-header-bg/95 to-transparent px-4 pb-4 pt-8">
          <input
            type="range"
            min={0}
            max={pages.length - 1}
            value={clampedIndex}
            onChange={(e) => setIndex(Number(e.target.value))}
            aria-label="Page"
            className="w-full accent-tg-button"
            // Reversed for right-to-left titles so the slider tracks the
            // direction pages actually advance.
            style={direction === 'rtl' ? { transform: 'scaleX(-1)' } : undefined}
          />
          <div className="mt-1 flex items-center justify-between text-xs text-tg-hint">
            <span className="tabular-nums text-tg-text">
              {clampedIndex + 1} / {pages.length}
            </span>
            <span>{source === 'offline' ? 'Offline copy' : 'Streaming'}</span>
          </div>
        </div>
      </div>

      {showStats && stats && <StatsOverlay stats={stats} />}
    </div>
  );
}

/**
 * GPU budget readout.
 *
 * Left in the shipped build behind a setting rather than stripped: the whole
 * point of the texture cap is that it holds on real devices, and the fastest
 * way to confirm that on a phone in the field is to look at the counter.
 */
function StatsOverlay({ stats }: { stats: TextureStats }): React.JSX.Element {
  const mb = (stats.totalBytes / 1024 / 1024).toFixed(1);
  const overBudget = stats.screenCount > 3 || stats.zoomCount > 1;

  return (
    <div
      className={`pointer-events-none absolute left-2 top-2 rounded bg-tg-secondary-bg/90 px-2 py-1 font-mono text-[10px] leading-tight ${
        overBudget ? 'text-tg-destructive' : 'text-tg-accent'
      }`}
    >
      <div>
        screen {stats.screenCount}/3 · zoom {stats.zoomCount}/1
      </div>
      <div>
        {mb} MB · {stats.pendingLoads} loading
      </div>
      <div>{stats.evictions} evicted</div>
    </div>
  );
}
