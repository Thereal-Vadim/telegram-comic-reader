import { describe, expect, it } from 'vitest';
import {
  completeTip,
  cornerYFromPointer,
  paperLerpAlpha,
  progressFromTip,
  projectPointerToPage,
  restCorner,
  tipTravel,
} from '../src/reader/pageCurlMath';

describe('pageCurlMath', () => {
  it('peels next from the bottom-right in LTR by default', () => {
    expect(restCorner('next', false)).toEqual({ x: 1, y: 0 });
    expect(restCorner('prev', false)).toEqual({ x: 0, y: 0 });
  });

  it('picks top corners when cornerY is 1', () => {
    expect(restCorner('next', false, 1)).toEqual({ x: 1, y: 1 });
    expect(restCorner('prev', false, 1)).toEqual({ x: 0, y: 1 });
  });

  it('swaps peel edges for RTL', () => {
    expect(restCorner('next', true)).toEqual({ x: 0, y: 0 });
    expect(restCorner('prev', true)).toEqual({ x: 1, y: 0 });
  });

  it('chooses top vs bottom from pointer height', () => {
    expect(cornerYFromPointer(0.2)).toBe(0);
    expect(cornerYFromPointer(0.5)).toBe(1);
    expect(cornerYFromPointer(0.9)).toBe(1);
  });

  it('maps tip travel into signed progress', () => {
    expect(progressFromTip(1, 0, 'next', false)).toBeCloseTo(0, 5);
    const mid = progressFromTip(0.35, 0.2, 'next', false);
    expect(mid).toBeGreaterThan(0.4);
    expect(mid).toBeLessThan(1);
    expect(progressFromTip(-0.45, 0.35, 'next', false)).toBeCloseTo(1, 2);
    expect(progressFromTip(0, 0, 'prev', false)).toBeCloseTo(0, 5);
    expect(progressFromTip(1.45, 0.35, 'prev', false)).toBeCloseTo(-1, 2);
  });

  it('complete tip lands past the opposite edge', () => {
    const next = completeTip('next', false, 0.4);
    expect(next.x).toBeLessThan(0);
    expect(next.y).toBeCloseTo(0.4);
    const prev = completeTip('prev', false, 0.4);
    expect(prev.x).toBeGreaterThan(1);
  });

  it('measures tip travel from the rest corner', () => {
    expect(tipTravel(1, 0, 'next', false)).toBeCloseTo(0, 5);
    expect(tipTravel(0.5, 0, 'next', false)).toBeCloseTo(0.5, 5);
    expect(tipTravel(1, 1, 'next', false, 1)).toBeCloseTo(0, 5);
  });

  it('projects canvas centre onto page centre when the page fills the view', () => {
    const tip = projectPointerToPage(50, 50, 0, 0, 100, 100, {
      pageWidth: 2,
      pageHeight: 2,
      viewWidth: 2,
      viewHeight: 2,
    });
    expect(tip.x).toBeCloseTo(0.5, 3);
    expect(tip.y).toBeCloseTo(0.5, 3);
  });

  it('accounts for letterboxing when projecting onto a narrower page', () => {
    // View is 4 wide, page is 2 wide — left quarter of canvas is outside the page.
    const leftEdge = projectPointerToPage(0, 50, 0, 0, 100, 100, {
      pageWidth: 2,
      pageHeight: 2,
      viewWidth: 4,
      viewHeight: 2,
    });
    expect(leftEdge.x).toBeLessThan(0);
    const pageLeft = projectPointerToPage(25, 50, 0, 0, 100, 100, {
      pageWidth: 2,
      pageHeight: 2,
      viewWidth: 4,
      viewHeight: 2,
    });
    expect(pageLeft.x).toBeCloseTo(0, 2);
  });

  it('paper lerp is ~0.16 per frame at 60 fps', () => {
    expect(paperLerpAlpha(1 / 60)).toBeCloseTo(0.16, 1);
  });
});
