import { create } from 'zustand';
import type { ComicSummary } from '@comic/shared';
import { db, type Favorite, type ReadingProgress } from '../db/schema';
import { withQuotaHandling } from '../db/storage';

/**
 * Favourites, reading history, and per-chapter progress.
 *
 * Persisted through Dexie rather than zustand's localStorage middleware. Two
 * reasons: localStorage caps at roughly 5 MB of strings and a long history
 * plus a few hundred favourites gets close to that, and it is synchronous, so
 * every write blocks the main thread. Keeping this in the same database as the
 * downloaded pages also means clearing a comic removes its progress atomically
 * rather than leaving an orphan entry pointing at content that is gone.
 */

export interface LibraryState {
  favorites: Set<string>;
  progress: Map<string, ReadingProgress>;
  /** Most recently opened comics, newest first. */
  history: string[];
  hydrated: boolean;

  hydrate: () => Promise<void>;
  toggleFavorite: (comicId: string) => Promise<void>;
  isFavorite: (comicId: string) => boolean;
  recordProgress: (args: {
    chapterId: string;
    comicId: string;
    pageIndex: number;
    pageCount: number;
  }) => Promise<void>;
  getProgress: (chapterId: string) => ReadingProgress | undefined;
  /** Where to resume a comic: its most recently read chapter. */
  lastReadChapter: (comicId: string) => ReadingProgress | undefined;
  touchHistory: (comicId: string) => Promise<void>;
  clearHistory: () => Promise<void>;
}

const HISTORY_KEY = 'history';
const HISTORY_LIMIT = 50;

export const useLibrary = create<LibraryState>((set, get) => ({
  favorites: new Set(),
  progress: new Map(),
  history: [],
  hydrated: false,

  hydrate: async () => {
    if (get().hydrated) return;

    const [favorites, progressRows, historyRow] = await Promise.all([
      db.favorites.toArray(),
      db.progress.toArray(),
      db.kv.get(HISTORY_KEY),
    ]);

    set({
      favorites: new Set(favorites.map((f: Favorite) => f.comicId)),
      progress: new Map(progressRows.map((p: ReadingProgress) => [p.chapterId, p])),
      history: Array.isArray(historyRow?.value) ? (historyRow.value as string[]) : [],
      hydrated: true,
    });
  },

  toggleFavorite: async (comicId) => {
    const next = new Set(get().favorites);
    const adding = !next.has(comicId);

    // Optimistic: the star should respond to the tap immediately, and a failed
    // write here is recoverable on next hydrate.
    if (adding) next.add(comicId);
    else next.delete(comicId);
    set({ favorites: next });

    try {
      if (adding) await db.favorites.put({ comicId, addedAt: Date.now() });
      else await db.favorites.delete(comicId);
    } catch (err) {
      console.warn('[library] favourite write failed; rolling back', err);
      const rolledBack = new Set(get().favorites);
      if (adding) rolledBack.delete(comicId);
      else rolledBack.add(comicId);
      set({ favorites: rolledBack });
    }
  },

  isFavorite: (comicId) => get().favorites.has(comicId),

  recordProgress: async ({ chapterId, comicId, pageIndex, pageCount }) => {
    const entry: ReadingProgress = {
      chapterId,
      comicId,
      pageIndex,
      pageCount,
      updatedAt: Date.now(),
    };

    const next = new Map(get().progress);
    next.set(chapterId, entry);
    set({ progress: next });

    // Progress is written on every page turn, so a quota failure here must not
    // interrupt reading; the in-memory copy carries the session either way.
    await withQuotaHandling(() => db.progress.put(entry)).catch((err: unknown) => {
      console.warn('[library] progress write failed', err);
    });
  },

  getProgress: (chapterId) => get().progress.get(chapterId),

  lastReadChapter: (comicId) => {
    let latest: ReadingProgress | undefined;
    for (const entry of get().progress.values()) {
      if (entry.comicId !== comicId) continue;
      if (!latest || entry.updatedAt > latest.updatedAt) latest = entry;
    }
    return latest;
  },

  touchHistory: async (comicId) => {
    // Move to front, dropping any earlier occurrence so the list stays unique.
    const history = [comicId, ...get().history.filter((id) => id !== comicId)].slice(
      0,
      HISTORY_LIMIT,
    );
    set({ history });
    await db.kv.put({ key: HISTORY_KEY, value: history }).catch(() => undefined);
  },

  clearHistory: async () => {
    set({ history: [] });
    await db.kv.delete(HISTORY_KEY).catch(() => undefined);
  },
}));

/** Cache a comic's metadata so the library grid renders offline. */
export async function cacheComicSummary(comic: ComicSummary): Promise<void> {
  await withQuotaHandling(() => db.comics.put({ ...comic, cachedAt: Date.now() })).catch(
    (err: unknown) => console.warn('[library] could not cache comic metadata', err),
  );
}
