/**
 * Pure helpers for the reader gesture layer.
 *
 * Kept free of React so the commit / double-tap / pan rules can be unit-tested
 * without mounting a canvas or synthesising PointerEvents.
 */

export const COMMIT_THRESHOLD = 0.28;
export const FLICK_VELOCITY = 0.45;
export const PAN_LOCKOUT_PX = 24;
export const TAP_SLOP_PX = 8;
export const TAP_MAX_MS = 300;
export const DOUBLE_TAP_MS = 280;
export const DOUBLE_TAP_SLOP_PX = 28;
/** Camera scale toggled by a centre double-tap. */
export const DOUBLE_TAP_ZOOM = 2.5;
export const MIN_SCALE = 1;
export const MAX_SCALE = 4;
/** Above this scale the reader prefers the hi-res zoom texture when present. */
export const ZOOM_TEXTURE_THRESHOLD = 1.35;

export function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

export function clampPan(pan: number, scale: number, surfaceSize: number): number {
  if (scale <= 1.01) return 0;
  const max = ((scale - 1) / scale) * surfaceSize * 0.5;
  return Math.max(-max, Math.min(max, pan));
}

export interface TapSample {
  readonly time: number;
  readonly x: number;
  readonly y: number;
}

/** True when `current` lands close enough in space and time to `previous`. */
export function isDoubleTap(previous: TapSample | null, current: TapSample): boolean {
  if (!previous) return false;
  if (current.time - previous.time > DOUBLE_TAP_MS) return false;
  return Math.hypot(current.x - previous.x, current.y - previous.y) <= DOUBLE_TAP_SLOP_PX;
}

export type TapZone = 'left' | 'centre' | 'right';

export function tapZone(localX: number, width: number): TapZone {
  const third = width / 3;
  if (localX < third) return 'left';
  if (localX > width - third) return 'right';
  return 'centre';
}

/**
 * Map a horizontal drag onto signed turn progress.
 * Positive means "advance to next" in the active reading order.
 */
export function dragToProgress(dx: number, width: number, rtl: boolean): number {
  const raw = -dx / Math.max(1, width);
  const signed = rtl ? -raw : raw;
  return Math.max(-1, Math.min(1, signed));
}

export function shouldCommitTurn(
  progress: number,
  velocity: number,
  rtl: boolean,
): boolean {
  if (Math.abs(progress) >= COMMIT_THRESHOLD) return true;
  const flicked = Math.abs(velocity) > FLICK_VELOCITY;
  if (!flicked) return false;
  const flickForward = rtl ? velocity > 0 : velocity < 0;
  const directionIsNext = progress > 0;
  return flickForward === directionIsNext;
}
