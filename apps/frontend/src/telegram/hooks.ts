import { useCallback, useEffect, useRef } from 'react';
import { getWebApp } from './webapp';
import type { HapticImpactStyle, HapticNotificationType } from './types';

/**
 * React bindings for the Telegram native controls.
 *
 * The recurring hazard with these is that BackButton and MainButton are
 * process-global singletons: mounting two components that both bind MainButton
 * leaves whichever unmounted last having hidden a button the other still
 * wants. Each hook here therefore restores the previous state on cleanup, and
 * callbacks are held in refs so re-registering does not churn the bridge.
 */

/**
 * Show the native back button while mounted and route it to `onBack`.
 * Restores the button's prior visibility on unmount.
 */
export function useBackButton(onBack: (() => void) | null): void {
  const handler = useRef(onBack);
  // Updated in an effect rather than during render: a ref written while
  // rendering is unsafe under concurrent rendering, and nothing reads this
  // before paint — the only reader is the bridge's click callback.
  useEffect(() => {
    handler.current = onBack;
  });

  const bound = onBack !== null;

  useEffect(() => {
    if (!bound) return;
    const tg = getWebApp();
    const wasVisible = tg.BackButton.isVisible;

    // Stable indirection: `onBack` can change every render without us having
    // to unregister and re-register on the bridge each time.
    const cb = (): void => handler.current?.();

    tg.BackButton.onClick(cb);
    tg.BackButton.show();

    return () => {
      tg.BackButton.offClick(cb);
      if (!wasVisible) tg.BackButton.hide();
    };
    // `onBack` is only read for its nullability; the ref carries the identity.
  }, [bound]);
}

export interface MainButtonConfig {
  text: string;
  onClick: () => void;
  visible?: boolean;
  enabled?: boolean;
  progress?: boolean;
}

/** Drive the native main button from component state. */
export function useMainButton(config: MainButtonConfig | null): void {
  const handler = useRef<(() => void) | null>(config?.onClick ?? null);
  useEffect(() => {
    handler.current = config?.onClick ?? null;
  });

  const bound = config !== null;
  const visible = config?.visible ?? true;
  const enabled = config?.enabled ?? true;
  const progress = config?.progress ?? false;
  const text = config?.text ?? '';

  useEffect(() => {
    const tg = getWebApp();
    const cb = (): void => handler.current?.();
    tg.MainButton.onClick(cb);
    return () => {
      tg.MainButton.offClick(cb);
      tg.MainButton.hide();
    };
  }, []);

  useEffect(() => {
    const tg = getWebApp();
    if (!bound || !visible) {
      tg.MainButton.hide();
      return;
    }
    tg.MainButton.setText(text);
    if (enabled) tg.MainButton.enable();
    else tg.MainButton.disable();
    if (progress) tg.MainButton.showProgress(true);
    else tg.MainButton.hideProgress();
    tg.MainButton.show();
  }, [bound, text, visible, enabled, progress]);
}

/**
 * Haptics, rate-limited.
 *
 * Page turns can fire faster than the taptic engine can service on iOS, and
 * an unthrottled stream both feels like a buzz and drops frames. 50 ms is
 * below the threshold where two taps read as one.
 */
export function useHaptics(): {
  impact: (style?: HapticImpactStyle) => void;
  notify: (type: HapticNotificationType) => void;
  select: () => void;
} {
  const lastFired = useRef(0);

  const throttled = useCallback((fn: () => void) => {
    const now = performance.now();
    if (now - lastFired.current < 50) return;
    lastFired.current = now;
    try {
      fn();
    } catch {
      // Haptics are unsupported on desktop clients and throw rather than
      // no-op. A missing buzz must never break a page turn.
    }
  }, []);

  const impact = useCallback(
    (style: HapticImpactStyle = 'light') =>
      throttled(() => getWebApp().HapticFeedback.impactOccurred(style)),
    [throttled],
  );
  const notify = useCallback(
    (type: HapticNotificationType) =>
      throttled(() => getWebApp().HapticFeedback.notificationOccurred(type)),
    [throttled],
  );
  const select = useCallback(
    () => throttled(() => getWebApp().HapticFeedback.selectionChanged()),
    [throttled],
  );

  return { impact, notify, select };
}

/**
 * Ask Telegram to confirm before closing.
 *
 * Used while a download is running, since backgrounding the Mini App suspends
 * its JavaScript and would silently stall the transfer.
 */
export function useClosingConfirmation(active: boolean): void {
  useEffect(() => {
    const tg = getWebApp();
    if (!tg.isVersionAtLeast('6.2')) return;
    if (active) tg.enableClosingConfirmation();
    else tg.disableClosingConfirmation();
    return () => tg.disableClosingConfirmation();
  }, [active]);
}
