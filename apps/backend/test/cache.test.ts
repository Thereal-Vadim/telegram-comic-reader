import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ImageCache } from '../src/images/cache.js';

/**
 * The cache is what keeps the proxy from re-transcoding the same page on every
 * request, and its eviction is what keeps it from filling the disk. Both need
 * to hold under concurrency, since a reader opening a chapter fires a dozen
 * near-simultaneous writes.
 */

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'comic-cache-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const buffer = (size: number, fill = 0x61): Buffer => Buffer.alloc(size, fill);

describe('ImageCache', () => {
  it('stores and retrieves a value', async () => {
    const cache = new ImageCache(dir, 10 * 1024 * 1024);
    await cache.init();

    const key = ImageCache.key('page-1', 'screen', 82);
    await cache.set(key, buffer(1024));

    const got = await cache.get(key);
    expect(got).not.toBeNull();
    expect(got?.byteLength).toBe(1024);
  });

  it('misses on an unknown key', async () => {
    const cache = new ImageCache(dir, 1024 * 1024);
    await cache.init();
    expect(await cache.get(ImageCache.key('nope', 'screen', 82))).toBeNull();
  });

  it('derives different keys per variant and per quality setting', () => {
    // Quality is part of the key so changing the encoder setting invalidates
    // the cache rather than serving bytes encoded at the old quality.
    const a = ImageCache.key('page-1', 'screen', 82);
    const b = ImageCache.key('page-1', 'zoom', 82);
    const c = ImageCache.key('page-1', 'screen', 90);

    expect(new Set([a, b, c]).size).toBe(3);
  });

  it('evicts least-recently-used entries once over the cap', async () => {
    // Cap is the 64 MB floor the config enforces; write past it in 8 MB chunks.
    const cap = 64 * 1024 * 1024;
    const chunk = 8 * 1024 * 1024;
    const cache = new ImageCache(dir, cap);
    await cache.init();

    const keys: string[] = [];
    for (let i = 0; i < 10; i++) {
      const key = ImageCache.key(`page-${i}`, 'screen', 82);
      keys.push(key);
      await cache.set(key, buffer(chunk));
      // Distinguish access times; the index uses a millisecond clock.
      await new Promise((r) => setTimeout(r, 2));
    }

    // The guarantee is that the cap is never exceeded. The 90% figure is only
    // how far a pass trims once it runs, so the resting size sits somewhere
    // between that and the cap depending on where the last write landed.
    expect(cache.totalBytes).toBeLessThanOrEqual(cap);
    expect(cache.entryCount).toBeLessThan(10);

    // The oldest writes should be the ones gone, the newest still present.
    expect(await cache.get(keys[0]!)).toBeNull();
    expect(await cache.get(keys[9]!)).not.toBeNull();
  });

  it('keeps entries that were read recently, not just written recently', async () => {
    const cap = 64 * 1024 * 1024;
    const chunk = 8 * 1024 * 1024;
    const cache = new ImageCache(dir, cap);
    await cache.init();

    const first = ImageCache.key('page-first', 'screen', 82);
    await cache.set(first, buffer(chunk));

    for (let i = 0; i < 4; i++) {
      await cache.set(ImageCache.key(`filler-${i}`, 'screen', 82), buffer(chunk));
      await new Promise((r) => setTimeout(r, 2));
    }

    // Touch the oldest entry so it is no longer the LRU victim.
    await cache.get(first);
    await new Promise((r) => setTimeout(r, 2));

    for (let i = 4; i < 10; i++) {
      await cache.set(ImageCache.key(`filler-${i}`, 'screen', 82), buffer(chunk));
      await new Promise((r) => setTimeout(r, 2));
    }

    expect(await cache.get(first)).not.toBeNull();
  });

  it('rebuilds its index from disk on restart', async () => {
    const key = ImageCache.key('persisted', 'screen', 82);

    const first = new ImageCache(dir, 10 * 1024 * 1024);
    await first.init();
    await first.set(key, buffer(2048));

    // A fresh instance over the same directory, as happens on redeploy.
    const second = new ImageCache(dir, 10 * 1024 * 1024);
    await second.init();

    expect(second.entryCount).toBe(1);
    expect(second.totalBytes).toBe(2048);
    expect(await second.get(key)).not.toBeNull();
  });

  it('reports a miss and repairs itself when a file vanishes underneath it', async () => {
    const cache = new ImageCache(dir, 10 * 1024 * 1024);
    await cache.init();

    const key = ImageCache.key('ghost', 'screen', 82);
    await cache.set(key, buffer(512));

    // Simulate an operator clearing the cache directory while we are running.
    await fs.rm(path.join(dir, key.slice(0, 2)), { recursive: true, force: true });

    expect(await cache.get(key)).toBeNull();
    expect(cache.entryCount).toBe(0);
  });

  it('handles concurrent writes without corrupting the byte total', async () => {
    const cache = new ImageCache(dir, 64 * 1024 * 1024);
    await cache.init();

    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        cache.set(ImageCache.key(`concurrent-${i}`, 'screen', 82), buffer(1024)),
      ),
    );

    expect(cache.entryCount).toBe(20);
    expect(cache.totalBytes).toBe(20 * 1024);
  });
});
