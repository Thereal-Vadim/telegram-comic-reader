import Dexie from 'dexie';
import { db, type StoredPage } from './schema';

/**
 * Storage accounting and eviction.
 *
 * Browser storage is a shared, revocable resource. Two failure modes matter
 * and both are handled explicitly rather than surfacing as a generic write
 * error deep inside a download:
 *
 *  1. Quota exhaustion. `QuotaExceededError` is thrown by the write that
 *     happens to cross the line, which is rarely the one at fault. We check
 *     headroom before starting a chapter and evict on the way in.
 *  2. Eviction by the browser. Without a persistence grant, a WebView under
 *     pressure may drop the whole origin's storage, taking downloaded chapters
 *     with it. We request `persist()` once and report the outcome, because a
 *     reader that promises offline access and then loses it is worse than one
 *     that says up front it could not get a guarantee.
 */

export interface StorageStatus {
  /** Bytes currently used by this origin, as reported by the browser. */
  usage: number;
  /** Total the browser is willing to give us. Zero when unknown. */
  quota: number;
  /** True once the origin's data is exempt from automatic eviction. */
  persisted: boolean;
  /** Bytes attributable to downloaded pages. */
  pageBytes: number;
}

/** Below this much free space we refuse to start a new download. */
const MIN_HEADROOM_BYTES = 50 * 1024 * 1024;

/** Keep a margin under the quota; writes near the ceiling fail unpredictably. */
const QUOTA_SAFETY_FACTOR = 0.9;

export class StorageQuotaError extends Error {
  readonly needed: number;
  readonly available: number;

  constructor(needed: number, available: number) {
    super(
      `not enough storage: need ~${Math.ceil(needed / 1024 / 1024)} MB, ` +
        `${Math.floor(available / 1024 / 1024)} MB available`,
    );
    this.name = 'StorageQuotaError';
    this.needed = needed;
    this.available = available;
  }
}

/**
 * Ask the browser to exempt our data from automatic eviction.
 *
 * Safari grants this silently based on engagement heuristics and Chrome
 * generally grants it for installed or high-engagement origins, so a `false`
 * result is informational, not fatal.
 */
export async function requestPersistence(): Promise<boolean> {
  if (!('storage' in navigator) || !navigator.storage.persist) return false;
  try {
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

export async function getStorageStatus(): Promise<StorageStatus> {
  let usage = 0;
  let quota = 0;
  let persisted = false;

  if ('storage' in navigator && navigator.storage.estimate) {
    try {
      const estimate = await navigator.storage.estimate();
      usage = estimate.usage ?? 0;
      quota = estimate.quota ?? 0;
    } catch {
      // Firefox in private mode rejects estimate(); treat as unknown.
    }
  }
  if ('storage' in navigator && navigator.storage.persisted) {
    persisted = await navigator.storage.persisted().catch(() => false);
  }

  // Summing the page table is O(n) over downloaded pages, which is fine at the
  // scale of a personal library and is more honest than the browser's usage
  // figure, which folds in caches we do not control.
  let pageBytes = 0;
  await db.pages.each((p) => {
    pageBytes += p.bytes;
  });

  return { usage, quota, persisted, pageBytes };
}

/** Free bytes we are willing to use, after the safety margin. */
export async function availableBytes(): Promise<number> {
  const { usage, quota } = await getStorageStatus();
  if (quota === 0) return Number.POSITIVE_INFINITY; // unknown; let writes decide
  return Math.max(0, quota * QUOTA_SAFETY_FACTOR - usage);
}

/**
 * Verify there is room for an estimated download, evicting old chapters if not.
 * Throws {@link StorageQuotaError} when eviction cannot free enough.
 */
export async function ensureHeadroom(estimatedBytes: number): Promise<void> {
  const needed = estimatedBytes + MIN_HEADROOM_BYTES;
  let available = await availableBytes();
  if (available >= needed) return;

  const freed = await evictLeastRecentlyRead(needed - available);
  available += freed;

  if (available < needed) {
    throw new StorageQuotaError(needed, available);
  }
}

/**
 * Delete downloaded chapters, oldest-read first, until `targetBytes` is freed.
 *
 * Ordering is by reading progress rather than download time: a chapter
 * downloaded months ago but read yesterday is more likely to be wanted than
 * one grabbed this morning and never opened. Favourited comics are skipped
 * entirely, since an explicit favourite is the clearest signal of intent.
 */
export async function evictLeastRecentlyRead(targetBytes: number): Promise<number> {
  const favorites = new Set((await db.favorites.toArray()).map((f) => f.comicId));
  const progressByChapter = new Map(
    (await db.progress.toArray()).map((p) => [p.chapterId, p.updatedAt]),
  );

  const candidates = (await db.chapters.filter((c) => c.downloadedAt !== undefined).toArray())
    .filter((c) => !favorites.has(c.comicId))
    .sort((a, b) => {
      // Never-read chapters sort oldest, so they are reclaimed first.
      const aTime = progressByChapter.get(a.id) ?? 0;
      const bTime = progressByChapter.get(b.id) ?? 0;
      return aTime - bTime;
    });

  let freed = 0;
  for (const chapter of candidates) {
    if (freed >= targetBytes) break;
    freed += await deleteChapterPages(chapter.id);
  }
  return freed;
}

/** Remove a chapter's pages and clear its downloaded marker. Returns bytes freed. */
export async function deleteChapterPages(chapterId: string): Promise<number> {
  return db.transaction('rw', db.pages, db.chapters, async () => {
    const pages = await db.pages.where('chapterId').equals(chapterId).toArray();
    const bytes = pages.reduce((sum, p) => sum + p.bytes, 0);

    await db.pages.where('chapterId').equals(chapterId).delete();
    // `modify` with a callback rather than `update`: the downloaded marker has
    // to be removed outright, and assigning undefined through `update` is not
    // the same as deleting the key.
    await db.chapters.where('id').equals(chapterId).modify((chapter) => {
      delete chapter.downloadedAt;
      chapter.bytes = 0;
    });

    return bytes;
  });
}

/** Remove everything belonging to a comic, including its cached metadata. */
export async function deleteComic(comicId: string): Promise<number> {
  const chapters = await db.chapters.where('comicId').equals(comicId).toArray();
  let freed = 0;
  for (const c of chapters) freed += await deleteChapterPages(c.id);

  await db.transaction('rw', db.chapters, db.comics, db.progress, async () => {
    await db.chapters.where('comicId').equals(comicId).delete();
    await db.progress.where('comicId').equals(comicId).delete();
    await db.comics.delete(comicId);
  });
  return freed;
}

/**
 * Wrap a write so a quota failure becomes a typed error.
 *
 * Dexie surfaces the underlying DOMException, whose `name` is the only
 * reliable discriminator; the message text varies by engine.
 */
export async function withQuotaHandling<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const name = (err as { name?: string; inner?: { name?: string } })?.name;
    const innerName = (err as { inner?: { name?: string } })?.inner?.name;
    if (name === 'QuotaExceededError' || innerName === 'QuotaExceededError') {
      const available = await availableBytes().catch(() => 0);
      throw new StorageQuotaError(0, available);
    }
    throw err;
  }
}

/* -------------------------------------------------------------------------- */
/* Read paths used by the reader                                              */
/* -------------------------------------------------------------------------- */

export async function isChapterDownloaded(chapterId: string): Promise<boolean> {
  const chapter = await db.chapters.get(chapterId);
  return chapter?.downloadedAt !== undefined;
}

export async function getStoredPages(chapterId: string): Promise<StoredPage[]> {
  // The compound [chapterId+index] index returns these already ordered, which
  // avoids sorting a few hundred entries on every chapter open.
  return db.pages
    .where('[chapterId+index]')
    .between([chapterId, Dexie.minKey], [chapterId, Dexie.maxKey])
    .toArray();
}

