/**
 * Pure helpers for the Apple Books–style corner curl.
 * Tip positions are in page UV: x 0=left…1=right, y 0=bottom…1=top.
 */

export type CurlDirection = 'next' | 'prev';

/** Resting corner that peels for a turn in the given reading order. */
export function restCorner(
  direction: CurlDirection,
  rtl: boolean,
): { x: number; y: number } {
  // LTR next / RTL prev peel from the bottom-right; the opposite peels BL.
  const fromRight = rtl ? direction === 'prev' : direction === 'next';
  return fromRight ? { x: 1, y: 0 } : { x: 0, y: 0 };
}

/** Where the tip settles when the turn completes. */
export function completeTip(
  direction: CurlDirection,
  rtl: boolean,
  tipY: number,
): { x: number; y: number } {
  const fromRight = rtl ? direction === 'prev' : direction === 'next';
  const y = Math.min(0.82, Math.max(0.12, tipY));
  // Past the opposite edge so the page finishes flat on the back.
  return fromRight ? { x: -0.28, y } : { x: 1.28, y };
}

/**
 * Signed turn progress from tip position.
 * +1 = fully advanced (next), -1 = fully previous, 0 = at rest.
 */
export function progressFromTip(
  tipX: number,
  tipY: number,
  direction: CurlDirection,
  rtl: boolean,
): number {
  const rest = restCorner(direction, rtl);
  const done = completeTip(direction, rtl, tipY);
  const denom = done.x - rest.x;
  if (Math.abs(denom) < 1e-6) return 0;
  const mag = Math.max(0, Math.min(1, (tipX - rest.x) / denom));
  // Small vertical contribution so a mostly-up flick still counts.
  const lift = Math.max(0, tipY - rest.y) * 0.08;
  const amount = Math.max(0, Math.min(1, mag + lift));
  return direction === 'next' ? amount : -amount;
}

/** Map a pointer into page UV, allowing a little overshoot past the edges. */
export function pointerToTip(
  clientX: number,
  clientY: number,
  left: number,
  top: number,
  width: number,
  height: number,
): { x: number; y: number } {
  const x = (clientX - left) / Math.max(1, width);
  const y = 1 - (clientY - top) / Math.max(1, height);
  return {
    x: Math.max(-0.35, Math.min(1.35, x)),
    y: Math.max(-0.15, Math.min(1.15, y)),
  };
}

/** Whether the tip has travelled far enough from rest to count as "active". */
export function tipTravel(
  tipX: number,
  tipY: number,
  direction: CurlDirection,
  rtl: boolean,
): number {
  const rest = restCorner(direction, rtl);
  return Math.hypot(tipX - rest.x, tipY - rest.y);
}
