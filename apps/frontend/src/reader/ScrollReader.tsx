import { useCallback, useEffect, useMemo, useRef } from 'react';
import { api } from '../api/client';
import type { ReaderPage } from './ReaderCanvas';

/**
 * Continuous vertical scroll mode — pages stacked in a native scroller.
 * Centre tap still opens Themes & Settings; edge chrome is handled by the parent.
 */

export interface ScrollReaderProps {
  pages: ReaderPage[];
  index: number;
  onIndexChange: (index: number) => void;
  onTapCentre: () => void;
  paperColor: string;
  pageDim: number;
}

export function ScrollReader({
  pages,
  index,
  onIndexChange,
  onTapCentre,
  paperColor,
  pageDim,
}: ScrollReaderProps): React.JSX.Element {
  const scroller = useRef<HTMLDivElement>(null);
  const pageRefs = useRef<(HTMLElement | null)[]>([]);
  const suppressScroll = useRef(false);
  const tapStart = useRef<{ x: number; y: number; t: number } | null>(null);

  const srcs = useMemo(() => {
    const urls: { src: string; revoke: boolean }[] = pages.map((page) => {
      if (page.source.kind === 'url') {
        return { src: api.imageUrl(page.source.url, 'screen'), revoke: false };
      }
      return { src: URL.createObjectURL(page.source.blob), revoke: true };
    });
    return urls;
  }, [pages]);

  useEffect(() => {
    return () => {
      for (const row of srcs) {
        if (row.revoke) URL.revokeObjectURL(row.src);
      }
    };
  }, [srcs]);

  // Jump to the active page when the index changes from outside (scrubber).
  useEffect(() => {
    const el = pageRefs.current[index];
    if (!el || !scroller.current) return;
    suppressScroll.current = true;
    el.scrollIntoView({ block: 'start' });
    window.setTimeout(() => {
      suppressScroll.current = false;
    }, 80);
  }, [index]);

  const onScroll = useCallback(() => {
    if (suppressScroll.current || !scroller.current) return;
    const top = scroller.current.scrollTop + scroller.current.clientHeight * 0.35;
    let best = 0;
    for (let i = 0; i < pageRefs.current.length; i++) {
      const el = pageRefs.current[i];
      if (!el) continue;
      if (el.offsetTop <= top) best = i;
    }
    if (best !== index) onIndexChange(best);
  }, [index, onIndexChange]);

  return (
    <div
      ref={scroller}
      className="h-full w-full overflow-y-auto overscroll-contain"
      style={{ backgroundColor: paperColor, touchAction: 'pan-y' }}
      onScroll={onScroll}
      onPointerDown={(e) => {
        tapStart.current = { x: e.clientX, y: e.clientY, t: performance.now() };
      }}
      onPointerUp={(e) => {
        const start = tapStart.current;
        tapStart.current = null;
        if (!start) return;
        const dist = Math.hypot(e.clientX - start.x, e.clientY - start.y);
        if (dist < 10 && performance.now() - start.t < 300) {
          const w = scroller.current?.clientWidth ?? 1;
          const localX = e.clientX - (scroller.current?.getBoundingClientRect().left ?? 0);
          if (localX > w * 0.33 && localX < w * 0.67) {
            onTapCentre();
          } else if (localX >= w * 0.67 && index < pages.length - 1) {
            onIndexChange(index + 1);
          } else if (localX <= w * 0.33 && index > 0) {
            onIndexChange(index - 1);
          } else {
            onTapCentre();
          }
        }
      }}
    >
      <div className="mx-auto flex max-w-3xl flex-col gap-2 px-2 py-14">
        {pages.map((page, i) => (
          <article
            key={page.id}
            ref={(el) => {
              pageRefs.current[i] = el;
            }}
            className="overflow-hidden rounded-sm shadow-sm"
            style={{ backgroundColor: paperColor }}
          >
            {srcs[i] ? (
              <img
                src={srcs[i]!.src}
                alt={`Page ${i + 1}`}
                className="block h-auto w-full"
                style={{ filter: pageDim < 1 ? `brightness(${pageDim})` : undefined }}
                draggable={false}
              />
            ) : (
              <div className="flex aspect-[2/3] items-center justify-center text-sm text-black/40">
                Page {i + 1}
              </div>
            )}
          </article>
        ))}
      </div>
    </div>
  );
}
