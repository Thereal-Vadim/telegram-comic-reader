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
export type PageAnimation = 'slide' | 'curl' | 'fade' | 'scroll';
export type PaperPresetId =
  | 'original'
  | 'quiet'
  | 'paper'
  | 'bold'
  | 'calm'
  | 'focus'
  // Legacy ids from earlier builds — still accepted when loading prefs.
  | 'soft'
  | 'sepia'
  | 'night';

export interface PaperPreset {
  readonly id: PaperPresetId;
  readonly label: string;
  /** Tint behind / under pages. */
  readonly paperColor: string;
  /** Letterbox / ambient surround. */
  readonly ambientColor: string;
  /** Multiplier applied to page textures (night dims bright scans). */
  readonly pageDim: number;
  /** Swatch text colour for the theme card. */
  readonly inkColor: string;
}

export const PAPER_PRESETS: readonly PaperPreset[] = [
  {
    id: 'original',
    label: 'Original',
    paperColor: '#ffffff',
    ambientColor: '#ffffff',
    pageDim: 1,
    inkColor: '#1c1c1e',
  },
  {
    id: 'quiet',
    label: 'Quiet',
    paperColor: '#2c2c2e',
    ambientColor: '#1c1c1e',
    pageDim: 0.88,
    inkColor: '#aeaeb2',
  },
  {
    id: 'paper',
    label: 'Paper',
    paperColor: '#f4f0e6',
    ambientColor: '#e5dfd2',
    pageDim: 1,
    inkColor: '#1c1c1e',
  },
  {
    id: 'bold',
    label: 'Bold',
    paperColor: '#ffffff',
    ambientColor: '#f2f2f7',
    pageDim: 1.05,
    inkColor: '#000000',
  },
  {
    id: 'calm',
    label: 'Calm',
    paperColor: '#f3e6d8',
    ambientColor: '#e8d5c4',
    pageDim: 0.97,
    inkColor: '#4a3728',
  },
  {
    id: 'focus',
    label: 'Focus',
    paperColor: '#f2f2f7',
    ambientColor: '#d1d1d6',
    pageDim: 1,
    inkColor: '#1c1c1e',
  },
] as const;

export const PAGE_ANIMATIONS: readonly {
  id: PageAnimation;
  label: string;
  description: string;
}[] = [
  { id: 'slide', label: 'Slide', description: 'Horizontal push' },
  { id: 'curl', label: 'Curl', description: 'Apple Books fold' },
  { id: 'fade', label: 'Fast Fade', description: 'Quick cross-fade' },
  { id: 'scroll', label: 'Scroll', description: 'Continuous vertical' },
] as const;

const STORAGE_KEY = 'comic.readerPrefs';

interface PersistedPrefs {
  direction?: ReadingDirection;
  paperPreset?: PaperPresetId;
  pageAnimation?: PageAnimation;
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

/** Map legacy preset ids onto the Apple Books–style set. */
function normalizePresetId(id: PaperPresetId | undefined): PaperPresetId {
  if (id === 'soft' || id === 'sepia') return 'paper';
  if (id === 'night') return 'quiet';
  if (PAPER_PRESETS.some((p) => p.id === id)) return id!;
  return 'paper';
}

function presetById(id: PaperPresetId | undefined): PaperPreset {
  const normalized = normalizePresetId(id);
  return PAPER_PRESETS.find((p) => p.id === normalized) ?? PAPER_PRESETS[2]!;
}

function normalizeAnimation(id: PageAnimation | undefined): PageAnimation {
  if (id === 'slide' || id === 'curl' || id === 'fade' || id === 'scroll') return id;
  return 'curl';
}

export interface ReaderState {
  chromeVisible: boolean;
  direction: ReadingDirection;
  layout: PageLayout;
  paperPreset: PaperPresetId;
  pageAnimation: PageAnimation;
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
  setPageAnimation: (id: PageAnimation) => void;
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
    pageAnimation: normalizeAnimation(prefs.pageAnimation),
  };
})();

export const useReaderSettings = create<ReaderState>((set) => ({
  chromeVisible: false,
  direction: initial.direction,
  layout: 'single',
  paperPreset: initial.paperPreset,
  pageAnimation: initial.pageAnimation,
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
  setPageAnimation: (pageAnimation) => {
    savePrefs({ pageAnimation });
    set({ pageAnimation });
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
