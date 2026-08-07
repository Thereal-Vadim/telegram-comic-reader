import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client';

/**
 * Cover art with lazy loading and an explicit failure state.
 *
 * Covers are the bulk of the network traffic on the home feed, so they are
 * only requested once they approach the viewport. `loading="lazy"` alone is
 * not enough on the horizontal shelves: the browser considers everything in a
 * horizontally scrolling row to be "in viewport" and fetches the whole shelf
 * at once, so an IntersectionObserver scoped to the scroller does the work.
 */

export interface CoverImageProps {
  src: string | null;
  alt: string;
  className?: string;
  /** Skip the observer for above-the-fold art that should load immediately. */
  eager?: boolean;
}

export function CoverImage({
  src,
  alt,
  className = '',
  eager = false,
}: CoverImageProps): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(eager);
  const [status, setStatus] = useState<'loading' | 'loaded' | 'error'>('loading');

  // Resolved here rather than at each call site, so no caller can accidentally
  // render a backend-relative path against the frontend's own origin.
  const resolved = useMemo(() => (src ? api.absoluteUrl(src) : null), [src]);

  useEffect(() => {
    if (eager || visible || !ref.current) return;
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      // Start fetching a little before the cover scrolls in so it is decoded
      // by the time it lands.
      { rootMargin: '200px' },
    );

    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [eager, visible]);

  return (
    <div
      ref={ref}
      className={`relative overflow-hidden rounded-lg bg-tg-secondary-bg ${className}`}
      style={{ aspectRatio: '2 / 3' }}
    >
      {visible && resolved && status !== 'error' && (
        <img
          src={resolved}
          alt={alt}
          loading={eager ? 'eager' : 'lazy'}
          decoding="async"
          className={`h-full w-full object-cover transition-opacity duration-300 ${
            status === 'loaded' ? 'opacity-100' : 'opacity-0'
          }`}
          onLoad={() => setStatus('loaded')}
          onError={() => setStatus('error')}
        />
      )}

      {status !== 'loaded' && (
        <div className="absolute inset-0 flex items-center justify-center">
          {status === 'error' || !resolved ? (
            <span className="px-2 text-center text-xs text-tg-hint">{alt.slice(0, 40)}</span>
          ) : (
            <div className="h-full w-full animate-pulse bg-tg-secondary-bg" />
          )}
        </div>
      )}
    </div>
  );
}
