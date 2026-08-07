import type { ThemeParams } from './types';
import { getWebApp } from './webapp';

/**
 * Bridges Telegram's theme into CSS custom properties.
 *
 * Every colour in the app is expressed as `var(--tg-*)`, so switching themes
 * is a single write to `documentElement.style` rather than a React re-render.
 * That matters most in the reader: a theme change while a page turn is in
 * flight must not remount the WebGL canvas, which would drop every texture.
 */

/** Telegram theme key -> CSS variable, with a fallback for older clients. */
const VARIABLE_MAP: ReadonlyArray<readonly [keyof ThemeParams, string, string]> = [
  ['bg_color', '--tg-bg', '#17212b'],
  ['text_color', '--tg-text', '#f5f5f5'],
  ['hint_color', '--tg-hint', '#708499'],
  ['link_color', '--tg-link', '#6ab3f3'],
  ['button_color', '--tg-button', '#5288c1'],
  ['button_text_color', '--tg-button-text', '#ffffff'],
  ['secondary_bg_color', '--tg-secondary-bg', '#232e3c'],
  ['header_bg_color', '--tg-header-bg', '#17212b'],
  ['accent_text_color', '--tg-accent', '#6ab3f3'],
  ['section_bg_color', '--tg-section-bg', '#17212b'],
  ['section_header_text_color', '--tg-section-header', '#6ab3f3'],
  ['subtitle_text_color', '--tg-subtitle', '#708499'],
  ['destructive_text_color', '--tg-destructive', '#ec3942'],
];

export function applyTheme(): void {
  const tg = getWebApp();
  const root = document.documentElement;

  for (const [key, cssVar, fallback] of VARIABLE_MAP) {
    root.style.setProperty(cssVar, tg.themeParams[key] ?? fallback);
  }

  // Lets Tailwind's `dark:` variants and the native form controls follow suit.
  root.classList.toggle('dark', tg.colorScheme === 'dark');
  root.style.colorScheme = tg.colorScheme;
}

/**
 * Publish the viewport height as a CSS variable.
 *
 * `100vh` is wrong inside the Telegram WebView: it reports the full window
 * even while the app is docked or the keyboard is open, so a full-height
 * reader ends up with its controls under the fold. `viewportStableHeight`
 * excludes any in-progress resize, which is what makes it usable for layout.
 */
export function applyViewport(): void {
  const tg = getWebApp();
  const height = tg.viewportStableHeight || window.innerHeight;
  document.documentElement.style.setProperty('--tg-viewport-height', `${height}px`);
}

/** Subscribe to theme and viewport changes. Returns an unsubscribe function. */
export function watchTelegramAppearance(): () => void {
  const tg = getWebApp();

  applyTheme();
  applyViewport();

  tg.onEvent('themeChanged', applyTheme);
  tg.onEvent('viewportChanged', applyViewport);
  // Outside Telegram there is no viewportChanged event, so mirror window resize.
  window.addEventListener('resize', applyViewport);

  return () => {
    tg.offEvent('themeChanged', applyTheme);
    tg.offEvent('viewportChanged', applyViewport);
    window.removeEventListener('resize', applyViewport);
  };
}
