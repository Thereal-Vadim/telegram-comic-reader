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
export type PaperPresetId = 'soft' | 'sepia' | 'night';

export interface PaperPreset {
  readonly id: PaperPresetId;
  readonly label: string;
  /** Tint behind / under pages. */
  readonly paperColor: string;
  /** Letterbox / ambient surround — softer than Telegram bg for less glare. */
  readonly ambientColor: string;
  /** Multiplier applied to page textures (night dims bright scans). */
  readonly pageDim: number;
}

export const PAPER_PRESETS: readonly PaperPreset[] = [
  {
    id: 'soft',
    label: 'Soft',
    paperColor: '#f4f0e6',
    ambientColor: '#1a1814',
    pageDim: 1,
  },
  {
    id: 'sepia',
    label: 'Sepia',
    paperColor: '#e8dcc8',
    ambientColor: '#16120e',
    pageDim: 0.96,
  },
  {
    id: 'night',
    label: 'Night',
    paperColor: '#2a2a2c',
    ambientColor: '#0b0b0d',
    pageDim: 0.82,
  },
] as const;

const STORAGE_KEY = 'comic.readerPrefs';

interface PersistedPrefs {
  direction?: ReadingDirection;
  paperPreset?: PaperPresetId;
}

function loadPrefs(): PersistedPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as PersistedPrefs;
  } catch {
    return {};
  }
}

function savePrefs(partial: PersistedPrefs): void {
  try {
    const next = { ...loadPrefs(), ...partial };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Private mode / quota — preferences are best-effort.
  }
}

function presetById(id: PaperPresetId | undefined): PaperPreset {
  return PAPER_PRESETS.find((p) => p.id === id) ?? PAPER_PRESETS[0]!;
}

export interface ReaderState {
  chromeVisible: boolean;
  direction: ReadingDirection;
  layout: PageLayout;
  paperPreset: PaperPresetId;
  /** Paper tint behind pages, so scans with transparent margins look right. */
  paperColor: string;
  ambientColor: string;
  pageDim: number;
  /** Shows the texture-budget overlay. Off unless explicitly enabled. */
  showStats: boolean;

  toggleChrome: () => void;
  setChromeVisible: (visible: boolean) => void;
  setDirection: (direction: ReadingDirection) => void;
  setLayout: (layout: PageLayout) => void;
  setPaperPreset: (id: PaperPresetId) => void;
  toggleStats: () => void;
}

const initial = (() => {
  const prefs = loadPrefs();
  const paper = presetById(prefs.paperPreset);
  return {
    direction: prefs.direction === 'rtl' ? ('rtl' as const) : ('ltr' as const),
    paperPreset: paper.id,
    paperColor: paper.paperColor,
    ambientColor: paper.ambientColor,
    pageDim: paper.pageDim,
  };
})();

export const useReaderSettings = create<ReaderState>((set) => ({
  chromeVisible: true,
  direction: initial.direction,
  layout: 'single',
  paperPreset: initial.paperPreset,
  paperColor: initial.paperColor,
  ambientColor: initial.ambientColor,
  pageDim: initial.pageDim,
  showStats: false,

  toggleChrome: () => set((s) => ({ chromeVisible: !s.chromeVisible })),
  setChromeVisible: (chromeVisible) => set({ chromeVisible }),
  setDirection: (direction) => {
    savePrefs({ direction });
    set({ direction });
  },
  setLayout: (layout) => set({ layout }),
  setPaperPreset: (id) => {
    const paper = presetById(id);
    savePrefs({ paperPreset: paper.id });
    set({
      paperPreset: paper.id,
      paperColor: paper.paperColor,
      ambientColor: paper.ambientColor,
      pageDim: paper.pageDim,
    });
  },
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
