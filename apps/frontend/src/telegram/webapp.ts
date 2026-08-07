import type { TelegramWebApp, ThemeParams } from './types';

/**
 * Access to the Telegram bridge, plus a browser fallback.
 *
 * The app has to run in three places: inside Telegram, in a plain browser
 * during development, and in a headless browser under Playwright. Rather than
 * scattering `if (window.Telegram)` through the codebase, everything goes
 * through `getWebApp()`, which returns a stub outside Telegram whose buttons
 * and haptics are no-ops.
 */

/** Default palette for the browser fallback, matching Telegram's dark theme. */
const FALLBACK_THEME: ThemeParams = {
  bg_color: '#17212b',
  text_color: '#f5f5f5',
  hint_color: '#708499',
  link_color: '#6ab3f3',
  button_color: '#5288c1',
  button_text_color: '#ffffff',
  secondary_bg_color: '#232e3c',
  header_bg_color: '#17212b',
  section_bg_color: '#17212b',
  subtitle_text_color: '#708499',
  destructive_text_color: '#ec3942',
};

function createStub(): TelegramWebApp {
  const noop = (): void => undefined;
  const listeners = new Map<string, Set<() => void>>();

  const makeButton = (): TelegramWebApp['MainButton'] => {
    const handlers = new Set<() => void>();
    return {
      text: '',
      color: FALLBACK_THEME.button_color!,
      textColor: FALLBACK_THEME.button_text_color!,
      isVisible: false,
      isActive: true,
      isProgressVisible: false,
      setText: noop,
      show: noop,
      hide: noop,
      enable: noop,
      disable: noop,
      showProgress: noop,
      hideProgress: noop,
      onClick: (cb) => void handlers.add(cb),
      offClick: (cb) => void handlers.delete(cb),
      setParams: noop,
    };
  };

  return {
    initData: '',
    initDataUnsafe: {},
    version: '6.0',
    platform: 'unknown',
    colorScheme: 'dark',
    themeParams: FALLBACK_THEME,
    isExpanded: true,
    viewportHeight: typeof window === 'undefined' ? 800 : window.innerHeight,
    viewportStableHeight: typeof window === 'undefined' ? 800 : window.innerHeight,
    headerColor: FALLBACK_THEME.header_bg_color!,
    backgroundColor: FALLBACK_THEME.bg_color!,
    isClosingConfirmationEnabled: false,
    BackButton: (() => {
      const button = {
        isVisible: false,
        show: (): void => {
          button.isVisible = true;
        },
        hide: (): void => {
          button.isVisible = false;
        },
        onClick: noop,
        offClick: noop,
      };
      return button;
    })(),
    MainButton: makeButton(),
    HapticFeedback: {
      impactOccurred: noop,
      notificationOccurred: noop,
      selectionChanged: noop,
    },
    // The stub reports 6.0 so every version-gated call takes its fallback path.
    isVersionAtLeast: () => false,
    setHeaderColor: noop,
    setBackgroundColor: noop,
    enableClosingConfirmation: noop,
    disableClosingConfirmation: noop,
    onEvent: (event, cb) => {
      const set = listeners.get(event) ?? new Set();
      set.add(cb);
      listeners.set(event, set);
    },
    offEvent: (event, cb) => void listeners.get(event)?.delete(cb),
    ready: noop,
    expand: noop,
    close: noop,
    showAlert: (message, cb) => {
      window.alert(message);
      cb?.();
    },
    showConfirm: (message, cb) => cb?.(window.confirm(message)),
  };
}

let stub: TelegramWebApp | null = null;

export function getWebApp(): TelegramWebApp {
  const real = typeof window !== 'undefined' ? window.Telegram?.WebApp : undefined;
  if (real) return real;
  stub ??= createStub();
  return stub;
}

/**
 * One-time setup, called before React mounts.
 *
 * `disableVerticalSwipes` is the important one. Without it, Telegram's
 * drag-down-to-dock gesture competes with the reader's own vertical panning
 * and with horizontal swipes that have any vertical component, so a page turn
 * intermittently minimizes the app instead. It only exists from Bot API 7.7,
 * hence the guard, and on older clients we fall back to CSS `overscroll-behavior`
 * which mitigates but does not eliminate the problem.
 */
export function initTelegram(): void {
  const tg = getWebApp();

  tg.ready();
  tg.expand();

  if (tg.isVersionAtLeast('7.7')) {
    tg.disableVerticalSwipes?.();
  }

  // Match the chrome to the app background so the header does not flash a
  // different colour during navigation.
  if (tg.isVersionAtLeast('6.1')) {
    const bg = tg.themeParams.bg_color;
    if (bg) {
      tg.setHeaderColor(bg);
      tg.setBackgroundColor(bg);
    }
  }
}
