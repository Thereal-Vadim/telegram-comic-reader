import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { ReaderSettingsSheet } from '../components/ReaderSettingsSheet';
import { ErrorState, Spinner } from '../components/states';
import { db } from '../db/schema';
import { getStoredPages, isChapterDownloaded } from '../db/storage';
import {
  ReaderCanvas,
  type ReaderCanvasHandle,
  type ReaderPage as CanvasPage,
} from '../reader/ReaderCanvas';
import { ScrollReader } from '../reader/ScrollReader';
import type { TextureStats } from '../reader/TextureManager';
import { useLibrary } from '../store/library';
import { useReaderSettings } from '../store/reader';
import { useBackButton, useHaptics } from '../telegram/hooks';

/**
 * The reading view — Apple Books–style HUD + Themes & Settings sheet.
 *
 * Always-on: centred title (top) and page counter (bottom).
 * Centre tap: opens the settings sheet (scale, animation, paper themes).
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
  const [comicTitle, setComicTitle] = useState('');
  const [scale, setScale] = useState(1);

  const canvasRef = useRef<ReaderCanvasHandle>(null);

  const chromeVisible = useReaderSettings((s) => s.chromeVisible);
  const toggleChrome = useReaderSettings((s) => s.toggleChrome);
  const setChromeVisible = useReaderSettings((s) => s.setChromeVisible);
  const direction = useReaderSettings((s) => s.direction);
  const paperColor = useReaderSettings((s) => s.paperColor);
  const ambientColor = useReaderSettings((s) => s.ambientColor);
  const pageDim = useReaderSettings((s) => s.pageDim);
  const pageAnimation = useReaderSettings((s) => s.pageAnimation);
  const showStats = useReaderSettings((s) => s.showStats);

  const recordProgress = useLibrary((s) => s.recordProgress);

  useBackButton(useCallback(() => void navigate(-1), [navigate]));

  useEffect(() => {
    if (!chapterId) return;
    let cancelled = false;

    void (async () => {
      setLoading(true);
      setError(null);

      try {
        const chapter = await db.chapters.get(chapterId);
        if (!cancelled && chapter) {
          setTitle(chapter.title);
          const comic = await db.comics.get(chapter.comicId);
          if (comic) setComicTitle(comic.title);
        }

        if (await isChapterDownloaded(chapterId)) {
          const stored = await getStoredPages(chapterId);
          if (cancelled) return;

          if (stored.length > 0) {
            setPages(
              stored.map((p) => ({
                id: p.id,
                index: p.index,
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

  useEffect(() => {
    const current = Number(searchParams.get('page') ?? 0);
    if (current !== index) {
      setSearchParams({ page: String(index) }, { replace: true });
    }
  }, [index, searchParams, setSearchParams]);

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

  const displayTitle = comicTitle || title || 'Reading';
  const isScroll = pageAnimation === 'scroll';
  // Subtle ink that stays legible on both light and dark ambients.
  const hudInk = isDark(ambientColor) ? 'rgba(255,255,255,0.72)' : 'rgba(28,28,30,0.55)';

  if (loading) return <Spinner label="Opening chapter" />;
  if (error) return <ErrorState error={error} onRetry={() => window.location.reload()} />;
  if (pages.length === 0) {
    return <ErrorState error={new Error('This chapter has no readable pages.')} />;
  }

  return (
    <div
      className="relative h-viewport w-full overflow-hidden"
      style={{ backgroundColor: ambientColor }}
    >
      {isScroll ? (
        <ScrollReader
          pages={pages}
          index={clampedIndex}
          onIndexChange={handleIndexChange}
          onTapCentre={toggleChrome}
          paperColor={paperColor}
          pageDim={pageDim}
        />
      ) : (
        <ReaderCanvas
          ref={canvasRef}
          pages={pages}
          index={clampedIndex}
          onIndexChange={handleIndexChange}
          onTapCentre={toggleChrome}
          onThresholdCrossed={() => impact('soft')}
          onZoomChange={handleZoomChange}
          onScaleChange={setScale}
          rtl={direction === 'rtl'}
          paperColor={paperColor}
          pageDim={pageDim}
          animation={pageAnimation === 'fade' || pageAnimation === 'slide' ? pageAnimation : 'curl'}
          {...(showStats ? { onStats: setStats } : {})}
        />
      )}

      {/* Always-on Apple Books HUD: title + page counter */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-30 pt-safe">
        <div className="flex items-start justify-between px-4 pb-2 pt-3">
          <span className="w-10" />
          <p
            className="min-w-0 flex-1 truncate text-center text-[13px] font-medium tracking-wide"
            style={{ color: hudInk }}
          >
            {displayTitle}
          </p>
          {chromeVisible ? (
            <button
              type="button"
              aria-label="Close reader"
              onClick={() => {
                impact('light');
                void navigate(-1);
              }}
              className="pointer-events-auto flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-black/10 text-base font-medium backdrop-blur-md"
              style={{ color: isDark(ambientColor) ? '#fff' : '#1c1c1e' }}
            >
              ×
            </button>
          ) : (
            <span className="w-10" />
          )}
        </div>
        {title && comicTitle && chromeVisible && (
          <p className="px-12 text-center text-[11px]" style={{ color: hudInk }}>
            {title}
            {source === 'offline' ? ' · Offline' : ''}
          </p>
        )}
      </div>

      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-30 pb-safe">
        <p
          className="px-4 pb-3 pt-2 text-center text-[13px] font-medium tabular-nums tracking-wide"
          style={{ color: hudInk }}
        >
          {clampedIndex + 1}/{pages.length}
        </p>
      </div>

      <ReaderSettingsSheet
        open={chromeVisible}
        onClose={() => setChromeVisible(false)}
        scale={scale}
        onNudgeScale={(delta) => {
          if (isScroll) return;
          canvasRef.current?.nudgeScale(delta);
        }}
        pageIndex={clampedIndex}
        pageCount={pages.length}
        onScrubPage={(i) => {
          impact('soft');
          setIndex(i);
        }}
      />

      {showStats && stats && <StatsOverlay stats={stats} />}
    </div>
  );
}

function isDark(hex: string): boolean {
  const raw = hex.replace('#', '');
  if (raw.length < 6) return true;
  const r = parseInt(raw.slice(0, 2), 16);
  const g = parseInt(raw.slice(2, 4), 16);
  const b = parseInt(raw.slice(4, 6), 16);
  return (r * 299 + g * 587 + b * 114) / 1000 < 140;
}

function StatsOverlay({ stats }: { stats: TextureStats }): React.JSX.Element {
  const mb = (stats.totalBytes / 1024 / 1024).toFixed(1);
  const overBudget = stats.screenCount > 3 || stats.zoomCount > 1;

  return (
    <div
      className={`pointer-events-none absolute left-2 top-14 z-50 rounded bg-tg-secondary-bg/90 px-2 py-1 font-mono text-[10px] leading-tight ${
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
