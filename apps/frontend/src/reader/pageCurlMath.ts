/**
 * Pure helpers for Apple Books–style corner curl.
 *
 * Tip positions are page UV: x 0=left…1=right, y 0=bottom…1=top.
 * Projection maps a DOM pointer onto the letterboxed page plane
 * (orthographic raycaster equivalent).
 */

export type CurlDirection = 'next' | 'prev';

/** Page size vs visible viewport — both in Three.js world units. */
export interface PageLayout {
  pageWidth: number;
  pageHeight: number;
  viewWidth: number;
  viewHeight: number;
}

/** Resting corner that peels for a turn (top or bottom, left or right). */
export function restCorner(
  direction: CurlDirection,
  rtl: boolean,
  cornerY: 0 | 1 = 0,
): { x: number; y: number } {
  // LTR next / RTL prev peel from the right edge; the opposite peels left.
  const fromRight = rtl ? direction === 'prev' : direction === 'next';
  return fromRight ? { x: 1, y: cornerY } : { x: 0, y: cornerY };
}

/** Pick top vs bottom corner from where the finger grabbed. */
export function cornerYFromPointer(tipY: number): 0 | 1 {
  return tipY >= 0.5 ? 1 : 0;
}

/** Where the tip settles when the turn completes. */
export function completeTip(
  direction: CurlDirection,
  rtl: boolean,
  tipY: number,
): { x: number; y: number } {
  const fromRight = rtl ? direction === 'prev' : direction === 'next';
  const y = Math.min(0.92, Math.max(0.08, tipY));
  // Past the opposite edge (demo: ±1.5 × page width in world space → UV ±1).
  return fromRight ? { x: -1, y } : { x: 2, y };
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
  cornerY: 0 | 1 = 0,
): number {
  const rest = restCorner(direction, rtl, cornerY);
  const done = completeTip(direction, rtl, tipY);
  const denom = done.x - rest.x;
  if (Math.abs(denom) < 1e-6) return 0;
  const mag = Math.max(0, Math.min(1, (tipX - rest.x) / denom));
  return direction === 'next' ? mag : -mag;
}

/**
 * Project a DOM pointer onto the page plane (ortho raycaster).
 *
 * Accounts for letterboxing: only the fitted page quad maps to UV 0..1.
 */
export function projectPointerToPage(
  clientX: number,
  clientY: number,
  left: number,
  top: number,
  canvasW: number,
  canvasH: number,
  layout: PageLayout,
  zoom = 1,
  cameraX = 0,
  cameraY = 0,
): { x: number; y: number } {
  const ndcX = ((clientX - left) / Math.max(1, canvasW)) * 2 - 1;
  const ndcY = -((clientY - top) / Math.max(1, canvasH)) * 2 + 1;

  const z = Math.max(0.01, zoom);
  // Orthographic visible world half-extents, matching R3F viewport + zoom.
  const worldX = (ndcX * layout.viewWidth) / (2 * z) + cameraX;
  const worldY = (ndcY * layout.viewHeight) / (2 * z) + cameraY;

  const x = worldX / Math.max(1e-6, layout.pageWidth) + 0.5;
  const y = worldY / Math.max(1e-6, layout.pageHeight) + 0.5;

  return {
    x: Math.max(-0.5, Math.min(1.5, x)),
    y: Math.max(-0.2, Math.min(1.2, y)),
  };
}

/** @deprecated Use {@link projectPointerToPage} — kept for call-site clarity. */
export function pointerToTip(
  clientX: number,
  clientY: number,
  left: number,
  top: number,
  width: number,
  height: number,
): { x: number; y: number } {
  // Fallback when layout is unknown: treat the canvas as the full page.
  const x = (clientX - left) / Math.max(1, width);
  const y = 1 - (clientY - top) / Math.max(1, height);
  return {
    x: Math.max(-0.35, Math.min(1.35, x)),
    y: Math.max(-0.15, Math.min(1.15, y)),
  };
}

/** Distance of the tip from the rest corner. */
export function tipTravel(
  tipX: number,
  tipY: number,
  direction: CurlDirection,
  rtl: boolean,
  cornerY: 0 | 1 = 0,
): number {
  const rest = restCorner(direction, rtl, cornerY);
  return Math.hypot(tipX - rest.x, tipY - rest.y);
}

/**
 * Frame-rate–independent paper lerp (~0.16/frame at 60 fps).
 * Gives the heavy Apple Books settle feel.
 */
export function paperLerpAlpha(deltaSeconds: number, strength = 10.5): number {
  return 1 - Math.exp(-strength * Math.min(deltaSeconds, 1 / 30));
}
