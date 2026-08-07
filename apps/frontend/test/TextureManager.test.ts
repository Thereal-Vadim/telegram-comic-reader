import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TextureManager, type TextureSource } from '../src/reader/TextureManager';
import { createdBitmaps, installBitmapStub, resetBitmaps } from './setup';

/**
 * The memory budget is the load-bearing claim of the reader, so it gets tested
 * directly rather than inferred from the code reading correctly.
 *
 * A leak here is invisible over ten pages and fatal over a volume: three
 * textures at screen resolution is roughly 21 MB, but an unbounded cache over
 * a 300-page chapter would be about 2 GB, which no mobile WebView survives.
 */

/** Stands in for WebGLRenderer.initTexture, which needs a real GL context. */
function fakeRenderer(): { initTexture: ReturnType<typeof vi.fn> } {
  return { initTexture: vi.fn() };
}

const source = (n: number): TextureSource => ({ kind: 'url', url: `https://example.test/${n}.webp` });

let manager: TextureManager;

beforeEach(() => {
  resetBitmaps();
  // Reinstalled every test so the failure case below cannot bleed forward.
  installBitmapStub();
  manager = new TextureManager({ screenCap: 3, zoomCap: 1 });
  manager.attachRenderer(fakeRenderer() as never);
});

describe('TextureManager', () => {
  it('returns a texture for a page', async () => {
    const texture = await manager.acquire('page-1', source(1));
    expect(texture).not.toBeNull();
    expect(manager.stats().screenCount).toBe(1);
  });

  it('returns the same texture for a repeated request without decoding twice', async () => {
    const first = await manager.acquire('page-1', source(1));
    const second = await manager.acquire('page-1', source(1));

    expect(second).toBe(first);
    expect(createdBitmaps).toHaveLength(1);
  });

  it('coalesces concurrent requests for the same page', async () => {
    // The reader prefetches neighbours while the user may tap straight to one.
    const [a, b, c] = await Promise.all([
      manager.acquire('page-1', source(1)),
      manager.acquire('page-1', source(1)),
      manager.acquire('page-1', source(1)),
    ]);

    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(createdBitmaps).toHaveLength(1);
  });

  it('never holds more than three screen textures', async () => {
    for (let i = 0; i < 10; i++) {
      await manager.acquire(`page-${i}`, source(i));
      expect(manager.stats().screenCount).toBeLessThanOrEqual(3);
    }

    expect(manager.stats().screenCount).toBe(3);
    expect(manager.stats().evictions).toBe(7);
  });

  it('evicts the least recently used page, not the most recent', async () => {
    await manager.acquire('a', source(1));
    await manager.acquire('b', source(2));
    await manager.acquire('c', source(3));

    // Touch 'a' so 'b' becomes the oldest.
    await manager.acquire('a', source(1));
    await manager.acquire('d', source(4));

    const bitmapCount = createdBitmaps.length;
    // Re-acquiring 'a' must not decode again; re-acquiring 'b' must.
    await manager.acquire('a', source(1));
    expect(createdBitmaps).toHaveLength(bitmapCount);

    await manager.acquire('b', source(2));
    expect(createdBitmaps.length).toBeGreaterThan(bitmapCount);
  });

  it('closes every bitmap it decodes', async () => {
    // Bitmaps are released immediately after upload, so none should still be
    // open even while their textures are live.
    for (let i = 0; i < 8; i++) {
      await manager.acquire(`page-${i}`, source(i));
    }

    expect(createdBitmaps.length).toBeGreaterThan(0);
    expect(createdBitmaps.every((b) => b.closed)).toBe(true);
  });

  it('disposes the underlying texture when evicting', async () => {
    const first = await manager.acquire('page-0', source(0));
    const disposeSpy = vi.spyOn(first!, 'dispose');

    for (let i = 1; i <= 4; i++) await manager.acquire(`page-${i}`, source(i));

    expect(disposeSpy).toHaveBeenCalledOnce();
    // The image reference is nulled too, so the closed bitmap wrapper is not
    // pinned by the disposed texture.
    expect(first!.image).toBeNull();
  });

  it('budgets zoom textures separately so a pinch cannot evict the flip window', async () => {
    await manager.acquire('a', source(1));
    await manager.acquire('b', source(2));
    await manager.acquire('c', source(3));

    await manager.acquire('b', source(2), 'zoom');

    const stats = manager.stats();
    expect(stats.screenCount).toBe(3);
    expect(stats.zoomCount).toBe(1);
  });

  it('holds only one zoom texture at a time', async () => {
    await manager.acquire('a', source(1), 'zoom');
    await manager.acquire('b', source(2), 'zoom');

    expect(manager.stats().zoomCount).toBe(1);
  });

  it('releases zoom textures without touching the screen window', async () => {
    await manager.acquire('a', source(1));
    await manager.acquire('a', source(2), 'zoom');

    manager.releaseZoom();

    expect(manager.stats().zoomCount).toBe(0);
    expect(manager.stats().screenCount).toBe(1);
  });

  it('reports a bounded byte total', async () => {
    for (let i = 0; i < 12; i++) await manager.acquire(`page-${i}`, source(i));

    // Three 1080x1620 RGBA textures is about 21 MB; allow headroom but assert
    // it is nowhere near what an unbounded cache of twelve pages would be.
    const { totalBytes } = manager.stats();
    expect(totalBytes).toBeLessThan(32 * 1024 * 1024);
  });

  it('drops everything on dispose', async () => {
    for (let i = 0; i < 3; i++) await manager.acquire(`page-${i}`, source(i));

    manager.dispose();

    const stats = manager.stats();
    expect(stats.screenCount).toBe(0);
    expect(stats.zoomCount).toBe(0);
    expect(stats.totalBytes).toBe(0);
    expect(manager.disposed).toBe(true);
  });

  it('is safe to dispose twice', async () => {
    await manager.acquire('page-0', source(0));
    manager.dispose();
    expect(() => manager.dispose()).not.toThrow();
  });

  it('returns null rather than throwing once disposed', async () => {
    manager.dispose();
    expect(await manager.acquire('page-1', source(1))).toBeNull();
  });

  it('drops slots on context loss so the reader re-acquires from source', async () => {
    await manager.acquire('a', source(1));
    await manager.acquire('b', source(2));

    const sources = manager.invalidateForContextRestore();

    // The sources come back so the caller knows what to reload, but nothing is
    // still resident: the GPU objects are gone and the bitmaps were freed.
    expect(sources).toHaveLength(2);
    expect(manager.stats().screenCount).toBe(0);
  });

  it('survives a failed decode without taking down the reader', async () => {
    const failing = vi.fn(async () => {
      throw new Error('decode failed');
    });
    vi.stubGlobal('createImageBitmap', failing);

    const texture = await manager.acquire('broken', source(99));

    expect(texture).toBeNull();
    expect(manager.stats().screenCount).toBe(0);
  });

  /**
   * The soak test. Turning 200 pages is an ordinary session; if anything in the
   * acquire path retains, this is where it shows up as a texture count that
   * climbs instead of holding flat.
   */
  it('holds flat over a 200-page soak', async () => {
    for (let i = 0; i < 200; i++) {
      await manager.acquire(`page-${i}`, source(i));
    }

    const stats = manager.stats();
    expect(stats.screenCount).toBe(3);
    expect(stats.pendingLoads).toBe(0);
    expect(stats.evictions).toBe(197);
    expect(createdBitmaps.every((b) => b.closed)).toBe(true);
  });
});
