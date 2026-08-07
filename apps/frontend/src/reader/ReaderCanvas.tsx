import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import type { Texture, WebGLRenderer } from 'three';
import { FlipScene } from './FlipScene';
import { TextureManager, type TextureSource } from './TextureManager';
import { useFlipGesture, type TurnDirection } from './useFlipGesture';

/**
 * The reader surface: canvas, gesture handling, and the texture window.
 *
 * Texture policy lives here. Exactly three pages are ever resident (previous,
 * current, next), acquired whenever the index moves and released by the
 * manager's LRU as new ones arrive. Prefetching the neighbours is what makes a
 * turn instant; capping at three is what stops a 300-page chapter from
 * accumulating 2 GB of GPU memory over a reading session.
 */

export interface ReaderPage {
  id: string;
  index: number;
  /** Where to get the bytes: a proxy URL online, an IndexedDB blob offline. */
  source: TextureSource;
  width: number | null;
  height: number | null;
}

export interface ReaderCanvasProps {
  pages: ReaderPage[];
  index: number;
  onIndexChange: (index: number) => void;
  onTapCentre: () => void;
  onThresholdCrossed?: () => void;
  /** Right-to-left reading order. */
  rtl?: boolean;
  paperColor?: string;
  /** Surfaces GPU budget numbers to a debug overlay. */
  onStats?: (stats: ReturnType<TextureManager['stats']>) => void;
}

/** Hands the renderer to the manager and wires up context-loss recovery. */
function RendererBridge({
  manager,
  onContextRestored,
}: {
  manager: TextureManager;
  onContextRestored: () => void;
}): null {
  const gl = useThree((s) => s.gl) as WebGLRenderer;

  useEffect(() => {
    manager.attachRenderer(gl);

    const canvas = gl.domElement;

    /*
     * Mobile WebViews drop the GL context under memory pressure, when the app
     * is backgrounded, or when another tab claims the GPU. The default
     * behaviour is for the context to be gone permanently; calling
     * preventDefault is what tells the browser we intend to recover, and
     * without it the reader stays black until a full reload.
     */
    const handleLost = (event: Event): void => {
      event.preventDefault();
      console.warn('[reader] WebGL context lost; awaiting restore');
    };

    const handleRestored = (): void => {
      console.info('[reader] WebGL context restored; re-uploading textures');
      // Our bitmaps were freed at upload time, so nothing can be re-uploaded
      // from memory. Drop the slots and let the reader re-acquire from source.
      manager.invalidateForContextRestore();
      onContextRestored();
    };

    canvas.addEventListener('webglcontextlost', handleLost);
    canvas.addEventListener('webglcontextrestored', handleRestored);

    return () => {
      canvas.removeEventListener('webglcontextlost', handleLost);
      canvas.removeEventListener('webglcontextrestored', handleRestored);
    };
  }, [gl, manager, onContextRestored]);

  return null;
}

export function ReaderCanvas({
  pages,
  index,
  onIndexChange,
  onTapCentre,
  onThresholdCrossed,
  rtl = false,
  paperColor = '#f8f5ef',
  onStats,
}: ReaderCanvasProps): React.JSX.Element {
  /*
   * The manager's lifetime is tied to the mount, not to a memo.
   *
   * Holding it in `useMemo` and disposing it from an effect cleanup is subtly
   * broken: React may keep the memoized value across a remount while the
   * cleanup has already disposed it, leaving a permanently dead manager whose
   * every `acquire` returns null. StrictMode's simulated unmount reproduces
   * that on the first render in development, and any future remount would do
   * the same in production. Keeping it in state and replacing it when it comes
   * back disposed makes the remount path explicit.
   */
  const [manager, setManager] = useState(() => new TextureManager({ screenCap: 3, zoomCap: 1 }));

  useEffect(() => {
    if (manager.disposed) {
      setManager(new TextureManager({ screenCap: 3, zoomCap: 1 }));
      return;
    }
    return () => manager.dispose();
  }, [manager]);

  // Textures are React state because a swap must re-render the scene once;
  // the *animation* never touches state, only these three slots do.
  const [textures, setTextures] = useState<{
    prev: Texture | null;
    current: Texture | null;
    next: Texture | null;
  }>({ prev: null, current: null, next: null });

  const [generation, setGeneration] = useState(0);
  const reducedMotion = usePrefersReducedMotion();

  // Guards against a late texture load writing into state after the index has
  // moved on, which would briefly show the wrong page.
  const indexRef = useRef(index);
  indexRef.current = index;

  const canTurn = useCallback(
    (direction: TurnDirection): boolean =>
      direction === 'next' ? indexRef.current < pages.length - 1 : indexRef.current > 0,
    [pages.length],
  );

  const { state: gesture, bind, startTurn, resetZoom } = useFlipGesture({
    onCommit: () => undefined, // the scene commits once the spring settles
    onTapCentre,
    ...(onThresholdCrossed ? { onThresholdCrossed } : {}),
    canTurn,
    rtl,
    reducedMotion,
  });

  /* Acquire the three-page window whenever the index moves. */
  useEffect(() => {
    let cancelled = false;

    const window_ = [
      { slot: 'prev' as const, page: pages[index - 1] },
      { slot: 'current' as const, page: pages[index] },
      { slot: 'next' as const, page: pages[index + 1] },
    ];

    // Cancel decodes for anything that just left the window; a fast scrub can
    // otherwise leave a dozen loads racing for pages nobody will see.
    manager.cancelExcept(
      new Set(window_.map((w) => w.page?.id).filter((id): id is string => id !== undefined)),
    );

    // The current page is loaded first and awaited on its own so it appears as
    // soon as possible; the neighbours are prefetched behind it.
    const loadCurrent = async (): Promise<void> => {
      const page = pages[index];
      if (!page) return;
      const texture = await manager.acquire(page.id, page.source, 'screen');
      if (cancelled || indexRef.current !== index) return;
      setTextures((t) => ({ ...t, current: texture }));
    };

    const loadNeighbours = async (): Promise<void> => {
      for (const { slot, page } of window_) {
        if (slot === 'current' || !page) continue;
        const texture = await manager.acquire(page.id, page.source, 'screen');
        if (cancelled || indexRef.current !== index) return;
        setTextures((t) => ({ ...t, [slot]: texture }));
      }
    };

    void loadCurrent().then(() => (cancelled ? undefined : loadNeighbours()));

    // Slots for pages outside the window are cleared immediately so a stale
    // texture is never shown while the replacement decodes.
    setTextures((t) => ({
      prev: pages[index - 1] ? t.prev : null,
      current: t.current,
      next: pages[index + 1] ? t.next : null,
    }));

    return () => {
      cancelled = true;
    };
  }, [index, pages, manager, generation]);

  /*
   * Publish the live budget on `window`.
   *
   * This is what makes the cap externally checkable: an end-to-end test can
   * turn two hundred pages and read the real resident count rather than
   * trusting that the code path it cannot see is doing what it claims. It is
   * two numbers on a global, so it stays in production builds where it is
   * equally useful for diagnosing a report from a real device.
   */
  useEffect(() => {
    const publish = (): void => {
      const stats = manager.stats();
      const target = window as unknown as {
        __READER_TEXTURE_COUNT__?: number;
        __READER_TEXTURE_STATS__?: typeof stats;
      };
      target.__READER_TEXTURE_COUNT__ = stats.screenCount;
      target.__READER_TEXTURE_STATS__ = stats;
      onStats?.(stats);
    };

    publish();
    const id = window.setInterval(publish, 250);
    return () => {
      window.clearInterval(id);
      delete (window as unknown as { __READER_TEXTURE_COUNT__?: number }).__READER_TEXTURE_COUNT__;
    };
  }, [manager, onStats]);

  const handleTurnComplete = useCallback(
    (direction: TurnDirection) => {
      const nextIndex = indexRef.current + (direction === 'next' ? 1 : -1);
      if (nextIndex < 0 || nextIndex >= pages.length) return;

      // Shift the texture window rather than dropping it: the page we just
      // turned to is already decoded, so it appears with no flash.
      setTextures((t) =>
        direction === 'next'
          ? { prev: t.current, current: t.next, next: null }
          : { prev: null, current: t.prev, next: t.current },
      );
      resetZoom();
      onIndexChange(nextIndex);
    },
    [pages.length, onIndexChange, resetZoom],
  );

  const handleContextRestored = useCallback(() => {
    setTextures({ prev: null, current: null, next: null });
    // Bumping the generation re-runs the acquire effect from a clean slate.
    setGeneration((g) => g + 1);
  }, []);

  const currentPage = pages[index];
  const aspect = useMemo(() => {
    if (currentPage?.width && currentPage.height) return currentPage.width / currentPage.height;
    // Comic pages are close enough to 2:3 that this is a safe default until
    // the real dimensions arrive with the decoded texture.
    return 2 / 3;
  }, [currentPage?.width, currentPage?.height]);

  return (
    <div
      className="reader-surface relative h-full w-full"
      {...bind}
      role="application"
      aria-label="Comic reader"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight' || e.key === 'PageDown') startTurn(rtl ? 'prev' : 'next');
        if (e.key === 'ArrowLeft' || e.key === 'PageUp') startTurn(rtl ? 'next' : 'prev');
      }}
    >
      <Canvas
        orthographic
        camera={{ position: [0, 0, 10], zoom: 1, near: 0.1, far: 100 }}
        // Capped at 2: a 3x device pixel ratio triples fragment work for a
        // difference nobody can see on a phone-sized comic page.
        dpr={[1, 2]}
        gl={{
          antialias: false, // the page is a textured quad; MSAA buys nothing
          alpha: true,
          powerPreference: 'high-performance',
          // Lets the browser reclaim the drawing buffer between frames, which
          // measurably lowers peak memory in WebViews.
          preserveDrawingBuffer: false,
        }}
        style={{ touchAction: 'none' }}
      >
        <RendererBridge manager={manager} onContextRestored={handleContextRestored} />
        <FlipScene
          gesture={gesture}
          currentTexture={textures.current}
          nextTexture={textures.next}
          prevTexture={textures.prev}
          aspect={aspect}
          paperColor={paperColor}
          onTurnComplete={handleTurnComplete}
          reducedMotion={reducedMotion}
        />
      </Canvas>
    </div>
  );
}

/** Tracks the OS "reduce motion" preference, which the reader honours. */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  });

  useEffect(() => {
    if (!window.matchMedia) return;
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const listener = (e: MediaQueryListEvent): void => setReduced(e.matches);
    query.addEventListener('change', listener);
    return () => query.removeEventListener('change', listener);
  }, []);

  return reduced;
}
