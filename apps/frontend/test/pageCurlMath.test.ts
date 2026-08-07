import { describe, expect, it } from 'vitest';
import {
  completeTip,
  progressFromTip,
  restCorner,
  tipTravel,
} from '../src/reader/pageCurlMath';

describe('pageCurlMath', () => {
  it('peels next from the bottom-right in LTR', () => {
    expect(restCorner('next', false)).toEqual({ x: 1, y: 0 });
    expect(restCorner('prev', false)).toEqual({ x: 0, y: 0 });
  });

  it('swaps peel corners for RTL', () => {
    expect(restCorner('next', true)).toEqual({ x: 0, y: 0 });
    expect(restCorner('prev', true)).toEqual({ x: 1, y: 0 });
  });

  it('maps tip travel into signed progress', () => {
    expect(progressFromTip(1, 0, 'next', false)).toBeCloseTo(0, 5);
    const mid = progressFromTip(0.35, 0.2, 'next', false);
    expect(mid).toBeGreaterThan(0.4);
    expect(mid).toBeLessThan(1);
    expect(progressFromTip(-0.28, 0.35, 'next', false)).toBeCloseTo(1, 2);
    expect(progressFromTip(0, 0, 'prev', false)).toBeCloseTo(0, 5);
    expect(progressFromTip(1.28, 0.35, 'prev', false)).toBeCloseTo(-1, 2);
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
  });
});
