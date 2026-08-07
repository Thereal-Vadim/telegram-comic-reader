import { describe, expect, it } from 'vitest';
import {
  clampPan,
  clampScale,
  dragToProgress,
  isDoubleTap,
  MAX_SCALE,
  shouldCommitTurn,
  tapZone,
} from '../src/reader/gestureMath';
import { stepSpring } from '../src/reader/useFlipGesture';
import { shouldUseSpread } from '../src/store/reader';

/**
 * The spring drives every page turn, so its edge cases are the ones a user
 * feels: an overshoot reads as a bounce, a failure to settle burns the GPU
 * forever on an animation nobody can see.
 */
describe('stepSpring', () => {
  it('moves toward the target', () => {
    const { value } = stepSpring(0, 1, 0, 1 / 60);
    expect(value).toBeGreaterThan(0);
    expect(value).toBeLessThan(1);
  });

  it('settles exactly on the target rather than approaching it forever', () => {
    let value = 0;
    let velocity = 0;

    for (let i = 0; i < 240; i++) {
      const stepped = stepSpring(value, 1, velocity, 1 / 60);
      value = stepped.value;
      velocity = stepped.velocity;
      if (value === 1 && velocity === 0) break;
    }

    // Exact equality: the snap threshold must actually fire, otherwise the
    // render loop never idles.
    expect(value).toBe(1);
    expect(velocity).toBe(0);
  });

  it('does not overshoot appreciably at the default damping', () => {
    let value = 0;
    let velocity = 0;
    let peak = 0;

    for (let i = 0; i < 240; i++) {
      const stepped = stepSpring(value, 1, velocity, 1 / 60);
      value = stepped.value;
      velocity = stepped.velocity;
      peak = Math.max(peak, value);
    }

    // Near-critical damping: a little overshoot is fine, a visible bounce is not.
    expect(peak).toBeLessThan(1.05);
  });

  it('clamps a huge timestep instead of integrating it into a jump', () => {
    // A backgrounded WebView resumes with a delta of several seconds. Without
    // the clamp the spring integrates that into a violent overshoot.
    const { value } = stepSpring(0, 1, 0, 5);
    expect(Number.isFinite(value)).toBe(true);
    expect(Math.abs(value)).toBeLessThan(2);
  });

  it('handles a backward turn symmetrically', () => {
    const forward = stepSpring(0, 1, 0, 1 / 60);
    const backward = stepSpring(0, -1, 0, 1 / 60);
    expect(backward.value).toBeCloseTo(-forward.value, 10);
  });

  it('is already settled when current equals target', () => {
    const { value, velocity } = stepSpring(1, 1, 0, 1 / 60);
    expect(value).toBe(1);
    expect(velocity).toBe(0);
  });
});

describe('gestureMath', () => {
  it('clamps scale into the 1..4 window', () => {
    expect(clampScale(0.5)).toBe(1);
    expect(clampScale(2)).toBe(2);
    expect(clampScale(99)).toBe(MAX_SCALE);
  });

  it('zeros pan when not zoomed and bounds it when zoomed', () => {
    expect(clampPan(400, 1, 390)).toBe(0);
    expect(clampPan(10_000, 2, 390)).toBeLessThan(400);
    expect(clampPan(-10_000, 2, 390)).toBeGreaterThan(-400);
  });

  it('detects a centre / edge tap zone', () => {
    expect(tapZone(10, 300)).toBe('left');
    expect(tapZone(150, 300)).toBe('centre');
    expect(tapZone(290, 300)).toBe('right');
  });

  it('recognises a double-tap within space and time', () => {
    const first = { time: 1000, x: 100, y: 100 };
    expect(isDoubleTap(first, { time: 1200, x: 105, y: 102 })).toBe(true);
    expect(isDoubleTap(first, { time: 1400, x: 105, y: 102 })).toBe(false);
    expect(isDoubleTap(first, { time: 1100, x: 200, y: 100 })).toBe(false);
    expect(isDoubleTap(null, { time: 1100, x: 100, y: 100 })).toBe(false);
  });

  it('maps a leftward drag to a forward turn in LTR', () => {
    expect(dragToProgress(-100, 200, false)).toBeCloseTo(0.5);
    expect(dragToProgress(-100, 200, true)).toBeCloseTo(-0.5);
  });

  it('commits on distance or a matching flick', () => {
    expect(shouldCommitTurn(0.3, 0, false)).toBe(true);
    expect(shouldCommitTurn(0.1, 0, false)).toBe(false);
    // Leftward flick (negative velocity) agrees with a forward (positive) turn.
    expect(shouldCommitTurn(0.1, -0.6, false)).toBe(true);
    // Opposite flick does not commit a short drag.
    expect(shouldCommitTurn(0.1, 0.6, false)).toBe(false);
  });
});

describe('shouldUseSpread', () => {
  it('never spreads in portrait', () => {
    expect(shouldUseSpread('auto-spread', 500, 900)).toBe(false);
  });

  it('does not spread on a phone in landscape', () => {
    // Two pages on an 844pt-wide screen renders each at roughly 40% of its
    // intended size, which is worse than one page.
    expect(shouldUseSpread('auto-spread', 844, 390)).toBe(false);
  });

  it('spreads on a wide landscape viewport', () => {
    expect(shouldUseSpread('auto-spread', 1280, 800)).toBe(true);
  });

  it('honours an explicit single-page preference regardless of size', () => {
    expect(shouldUseSpread('single', 1600, 900)).toBe(false);
  });
});
