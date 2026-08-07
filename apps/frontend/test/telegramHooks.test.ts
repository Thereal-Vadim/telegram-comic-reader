import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useBackButton, useHaptics } from '../src/telegram/hooks';
import { getWebApp } from '../src/telegram/webapp';

/**
 * The Telegram bridge is a process-global singleton. These tests pin the two
 * behaviours that are easy to regress: BackButton visibility restore on
 * unmount, and haptic calls not throwing outside Telegram.
 */

describe('useBackButton', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    getWebApp().BackButton.hide();
  });

  it('shows the back button while mounted and hides it again on unmount', () => {
    const tg = getWebApp();
    const show = vi.spyOn(tg.BackButton, 'show');
    const hide = vi.spyOn(tg.BackButton, 'hide');
    const onClick = vi.spyOn(tg.BackButton, 'onClick');
    const offClick = vi.spyOn(tg.BackButton, 'offClick');

    const onBack = vi.fn();
    const { unmount } = renderHook(() => useBackButton(onBack));

    expect(show).toHaveBeenCalled();
    expect(onClick).toHaveBeenCalled();

    unmount();
    expect(offClick).toHaveBeenCalled();
    // Was not visible before mount, so cleanup hides it.
    expect(hide).toHaveBeenCalled();
  });

  it('does not bind when onBack is null', () => {
    const tg = getWebApp();
    const show = vi.spyOn(tg.BackButton, 'show');
    const onClick = vi.spyOn(tg.BackButton, 'onClick');
    const { unmount } = renderHook(() => useBackButton(null));
    expect(show).not.toHaveBeenCalled();
    expect(onClick).not.toHaveBeenCalled();
    unmount();
    expect(show).not.toHaveBeenCalled();
  });
});

describe('useHaptics', () => {
  it('exposes impact / notify / select without throwing in the browser stub', () => {
    const { result } = renderHook(() => useHaptics());
    expect(() => result.current.impact('light')).not.toThrow();
    expect(() => result.current.notify('success')).not.toThrow();
    expect(() => result.current.select()).not.toThrow();
  });
});
