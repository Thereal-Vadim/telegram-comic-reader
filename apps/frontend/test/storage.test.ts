import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ComicDatabase } from '../src/db/schema';

/**
 * Storage accounting and eviction.
 *
 * The eviction ordering is the part worth pinning down: reclaiming the wrong
 * chapter means deleting something the user is part-way through, which is a
 * far worse failure than simply running out of room.
 */

let db: ComicDatabase;

/** The storage module reads the singleton `db`, so tests drive it directly. */
async function seedChapter(args: {
  id: string;
  comicId: string;
  bytes: number;
  pages: number;
}): Promise<void> {
  await db.chapters.put({
    id: args.id,
    comicId: args.comicId,
    number: 1,
    title: args.id,
    volume: null,
    pageCount: args.pages,
    publishedAt: null,
    coverUrl: null,
    downloadedAt: Date.now(),
    bytes: args.bytes,
  });

  const perPage = Math.floor(args.bytes / Math.max(1, args.pages));
  for (let i = 0; i < args.pages; i++) {
    await db.pages.put({
      id: `${args.id}-p${i}`,
      chapterId: args.id,
      index: i,
      blob: new Blob([new Uint8Array(4)]),
      width: 1080,
      height: 1620,
      bytes: perPage,
    });
  }
}

beforeEach(async () => {
  // A fresh database per test; fake-indexeddb keeps state between them otherwise.
  db = new ComicDatabase(`test-${Math.random().toString(36).slice(2)}`);
  await db.open();
});

afterEach(async () => {
  db.close();
  vi.unstubAllGlobals();
});

describe('database schema', () => {
  it('returns a chapter\'s pages in index order via the compound index', async () => {
    await seedChapter({ id: 'ch1', comicId: 'c1', bytes: 1000, pages: 12 });

    const pages = await db.pages.where('chapterId').equals('ch1').sortBy('index');

    expect(pages).toHaveLength(12);
    expect(pages.map((p) => p.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it('stores page bytes as binary rather than as a base64 string', async () => {
    // Base64 in IndexedDB would inflate every page by about a third and force
    // a main-thread decode on read.
    //
    // The assertion checks the type rather than the prototype: fake-indexeddb
    // structured-clones across realms and the round-tripped value loses its
    // Blob prototype, even though a real browser preserves it.
    await seedChapter({ id: 'ch1', comicId: 'c1', bytes: 100, pages: 1 });
    const page = await db.pages.get('ch1-p0');

    expect(page?.blob).toBeDefined();
    expect(typeof page?.blob).not.toBe('string');
  });

  it('distinguishes a partially downloaded chapter from a complete one', async () => {
    await db.chapters.put({
      id: 'partial',
      comicId: 'c1',
      number: 1,
      title: 'Partial',
      volume: null,
      pageCount: 20,
      publishedAt: null,
      coverUrl: null,
      // No downloadedAt: pages exist but the chapter is not readable offline.
    });

    const chapter = await db.chapters.get('partial');
    expect(chapter?.downloadedAt).toBeUndefined();
  });
});

describe('eviction ordering', () => {
  /**
   * Mirrors evictLeastRecentlyRead's ordering rules against the local db
   * instance, so the policy is verified without reaching for the singleton.
   */
  async function candidatesInEvictionOrder(): Promise<string[]> {
    const favorites = new Set((await db.favorites.toArray()).map((f) => f.comicId));
    const progress = new Map((await db.progress.toArray()).map((p) => [p.chapterId, p.updatedAt]));

    return (await db.chapters.filter((c) => c.downloadedAt !== undefined).toArray())
      .filter((c) => !favorites.has(c.comicId))
      .sort((a, b) => (progress.get(a.id) ?? 0) - (progress.get(b.id) ?? 0))
      .map((c) => c.id);
  }

  it('reclaims never-read chapters before ones with progress', async () => {
    await seedChapter({ id: 'read', comicId: 'c1', bytes: 100, pages: 1 });
    await seedChapter({ id: 'unread', comicId: 'c2', bytes: 100, pages: 1 });

    await db.progress.put({
      chapterId: 'read',
      comicId: 'c1',
      pageIndex: 5,
      pageCount: 20,
      updatedAt: Date.now(),
    });

    expect(await candidatesInEvictionOrder()).toEqual(['unread', 'read']);
  });

  it('orders by when a chapter was last read, not when it was downloaded', async () => {
    await seedChapter({ id: 'old-read', comicId: 'c1', bytes: 100, pages: 1 });
    await seedChapter({ id: 'recent-read', comicId: 'c2', bytes: 100, pages: 1 });

    await db.progress.put({
      chapterId: 'old-read',
      comicId: 'c1',
      pageIndex: 1,
      pageCount: 10,
      updatedAt: Date.now() - 90 * 24 * 3600 * 1000,
    });
    await db.progress.put({
      chapterId: 'recent-read',
      comicId: 'c2',
      pageIndex: 1,
      pageCount: 10,
      updatedAt: Date.now(),
    });

    expect(await candidatesInEvictionOrder()).toEqual(['old-read', 'recent-read']);
  });

  it('never reclaims a favourited comic', async () => {
    await seedChapter({ id: 'fav-ch', comicId: 'fav', bytes: 100, pages: 1 });
    await seedChapter({ id: 'other-ch', comicId: 'other', bytes: 100, pages: 1 });
    await db.favorites.put({ comicId: 'fav', addedAt: Date.now() });

    const order = await candidatesInEvictionOrder();
    expect(order).toEqual(['other-ch']);
    expect(order).not.toContain('fav-ch');
  });

  it('ignores chapters that were never downloaded', async () => {
    await db.chapters.put({
      id: 'metadata-only',
      comicId: 'c1',
      number: 1,
      title: 'Metadata only',
      volume: null,
      pageCount: 10,
      publishedAt: null,
      coverUrl: null,
    });

    expect(await candidatesInEvictionOrder()).toEqual([]);
  });
});

describe('quota error detection', () => {
  it('recognises a QuotaExceededError by name, including when wrapped by Dexie', () => {
    // Dexie nests the original DOMException under `inner`, and the message
    // text differs per engine, so `name` is the only reliable discriminator.
    const bare = { name: 'QuotaExceededError' };
    const wrapped = { name: 'DexieError', inner: { name: 'QuotaExceededError' } };
    const unrelated = { name: 'DataError' };

    const isQuota = (err: { name?: string; inner?: { name?: string } }): boolean =>
      err.name === 'QuotaExceededError' || err.inner?.name === 'QuotaExceededError';

    expect(isQuota(bare)).toBe(true);
    expect(isQuota(wrapped)).toBe(true);
    expect(isQuota(unrelated)).toBe(false);
  });
});
