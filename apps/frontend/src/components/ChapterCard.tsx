import { useEffect, useRef, useState } from 'react';
import type { Chapter } from '@comic/shared';
import { api } from '../api/client';
import { CoverImage } from './CoverImage';

const previewCache = new Map<string, string | null>();

/**
 * One cell in the 3-column issue grid: first-page thumb + readable title.
 * Preview is fetched only when the card approaches the viewport.
 */
export function ChapterCard({
  chapter,
  fallbackCover,
  badge,
  onOpen,
}: {
  chapter: Chapter;
  fallbackCover: string | null;
  badge?: string;
  onOpen: () => void;
}): React.JSX.Element {
  const ref = useRef<HTMLButtonElement>(null);
  const [coverUrl, setCoverUrl] = useState<string | null>(
    () => chapter.coverUrl ?? previewCache.get(chapter.id) ?? null,
  );
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (visible || !ref.current) return;
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
      { rootMargin: '240px' },
    );
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    if (coverUrl || previewCache.has(chapter.id)) {
      if (!coverUrl && previewCache.has(chapter.id)) {
        setCoverUrl(previewCache.get(chapter.id) ?? null);
      }
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const preview = await api.chapterPreview(chapter.id);
        if (cancelled) return;
        previewCache.set(chapter.id, preview.coverUrl);
        setCoverUrl(preview.coverUrl);
      } catch {
        if (!cancelled) {
          previewCache.set(chapter.id, null);
          setCoverUrl(null);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [visible, chapter.id, coverUrl]);

  const src = coverUrl ?? fallbackCover;

  return (
    <button
      ref={ref}
      type="button"
      onClick={onOpen}
      className="flex w-full flex-col text-left active:opacity-80"
    >
      <div className="relative">
        <CoverImage src={src} alt={chapter.title} className="w-full" />
        {badge && (
          <span className="absolute bottom-1 right-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-white">
            {badge}
          </span>
        )}
      </div>
      <p className="mt-1.5 line-clamp-2 text-[11px] font-medium leading-snug text-tg-text">
        {chapter.title}
      </p>
      <p className="mt-0.5 text-[10px] text-tg-hint">
        {chapter.pageCount > 0 ? `${chapter.pageCount} pages` : 'Open'}
      </p>
    </button>
  );
}
