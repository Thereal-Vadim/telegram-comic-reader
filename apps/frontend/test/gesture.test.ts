import { describe, expect, it } from 'vitest';
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
