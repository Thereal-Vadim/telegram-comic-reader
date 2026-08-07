import { create } from 'zustand';

/**
 * Reader UI preferences and chrome visibility.
 *
 * Kept apart from the library store on purpose: this slice changes on every
 * tap that toggles the chrome, and folding it into the library store would
 * re-render every component subscribed to favourites along with it.
 */

export type ReadingDirection = 'ltr' | 'rtl';
export type PageLayout = 'single' | 'auto-spread';

export interface ReaderState {
  chromeVisible: boolean;
  direction: ReadingDirection;
  layout: PageLayout;
  /** Paper tint behind pages, so scans with transparent margins look right. */
  paperColor: string;
  /** Shows the texture-budget overlay. Off unless explicitly enabled. */
  showStats: boolean;

  toggleChrome: () => void;
  setChromeVisible: (visible: boolean) => void;
  setDirection: (direction: ReadingDirection) => void;
  setLayout: (layout: PageLayout) => void;
  toggleStats: () => void;
}

export const useReaderSettings = create<ReaderState>((set) => ({
  chromeVisible: true,
  direction: 'ltr',
  layout: 'auto-spread',
  paperColor: '#f8f5ef',
  showStats: false,

  toggleChrome: () => set((s) => ({ chromeVisible: !s.chromeVisible })),
  setChromeVisible: (chromeVisible) => set({ chromeVisible }),
  setDirection: (direction) => set({ direction }),
  setLayout: (layout) => set({ layout }),
  toggleStats: () => set((s) => ({ showStats: !s.showStats })),
}));

/**
 * Whether to show two pages side by side.
 *
 * Only in landscape, and only when the viewport is genuinely wide enough that
 * two pages are each still legible. A spread on a phone in landscape renders
 * both pages at roughly 40% of their intended size, which is worse than one.
 */
export function shouldUseSpread(
  layout: PageLayout,
  viewportWidth: number,
  viewportHeight: number,
): boolean {
  if (layout === 'single') return false;
  const isLandscape = viewportWidth > viewportHeight;
  return isLandscape && viewportWidth >= 900;
}
