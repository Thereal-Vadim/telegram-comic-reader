/**
 * Typings for the `window.Telegram.WebApp` bridge injected by
 * telegram-web-app.js.
 *
 * Hand-written rather than pulled from a package: the official script is
 * loaded from Telegram's CDN at runtime, so any npm package is only supplying
 * types plus a thin wrapper anyway. Writing them here means every method we
 * call is one we have actually checked against the Bot API changelog, and the
 * version guards below stay honest.
 */

export interface ThemeParams {
  bg_color?: string;
  text_color?: string;
  hint_color?: string;
  link_color?: string;
  button_color?: string;
  button_text_color?: string;
  secondary_bg_color?: string;
  header_bg_color?: string;
  accent_text_color?: string;
  section_bg_color?: string;
  section_header_text_color?: string;
  subtitle_text_color?: string;
  destructive_text_color?: string;
}

export type HapticImpactStyle = 'light' | 'medium' | 'heavy' | 'rigid' | 'soft';
export type HapticNotificationType = 'error' | 'success' | 'warning';

export interface HapticFeedback {
  impactOccurred(style: HapticImpactStyle): void;
  notificationOccurred(type: HapticNotificationType): void;
  selectionChanged(): void;
}

export interface BackButton {
  isVisible: boolean;
  show(): void;
  hide(): void;
  onClick(cb: () => void): void;
  offClick(cb: () => void): void;
}

export interface MainButton {
  text: string;
  color: string;
  textColor: string;
  isVisible: boolean;
  isActive: boolean;
  isProgressVisible: boolean;
  setText(text: string): void;
  show(): void;
  hide(): void;
  enable(): void;
  disable(): void;
  showProgress(leaveActive?: boolean): void;
  hideProgress(): void;
  onClick(cb: () => void): void;
  offClick(cb: () => void): void;
  setParams(params: {
    text?: string;
    color?: string;
    text_color?: string;
    is_active?: boolean;
    is_visible?: boolean;
  }): void;
}

export type WebAppEvent =
  | 'themeChanged'
  | 'viewportChanged'
  | 'mainButtonClicked'
  | 'backButtonClicked'
  | 'settingsButtonClicked'
  | 'popupClosed'
  | 'activated'
  | 'deactivated';

export interface TelegramWebApp {
  initData: string;
  initDataUnsafe: {
    user?: {
      id: number;
      first_name: string;
      last_name?: string;
      username?: string;
      language_code?: string;
      is_premium?: boolean;
      photo_url?: string;
    };
    start_param?: string;
    auth_date?: number;
    hash?: string;
  };
  version: string;
  platform: string;
  colorScheme: 'light' | 'dark';
  themeParams: ThemeParams;
  isExpanded: boolean;
  viewportHeight: number;
  /** Height excluding any in-flight resize; the value layout should trust. */
  viewportStableHeight: number;
  headerColor: string;
  backgroundColor: string;
  isClosingConfirmationEnabled: boolean;
  /** Bot API 7.7+ */
  isVerticalSwipesEnabled?: boolean;

  BackButton: BackButton;
  MainButton: MainButton;
  HapticFeedback: HapticFeedback;

  isVersionAtLeast(version: string): boolean;
  setHeaderColor(color: string): void;
  setBackgroundColor(color: string): void;
  enableClosingConfirmation(): void;
  disableClosingConfirmation(): void;
  /** Bot API 7.7+ */
  enableVerticalSwipes?(): void;
  /** Bot API 7.7+ */
  disableVerticalSwipes?(): void;
  onEvent(event: WebAppEvent, cb: () => void): void;
  offEvent(event: WebAppEvent, cb: () => void): void;
  ready(): void;
  expand(): void;
  close(): void;
  showAlert(message: string, cb?: () => void): void;
  showConfirm(message: string, cb?: (ok: boolean) => void): void;
}

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp };
  }
}
