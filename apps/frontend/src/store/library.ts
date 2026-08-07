import { create } from 'zustand';
import type { ComicSummary } from '@comic/shared';
import { db, type Favorite, type ReadingProgress } from '../db/schema';
import { withQuotaHandling } from '../db/storage';
import {
  clearFavoriteIntent,
  clearProgressIntent,
  readJournal,
  recordFavoriteIntent,
  recordProgressIntent,
  type Journal,
} from '../db/journal';

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

/** Shared so several mounting components produce one read, not one each. */
let hydration: Promise<void> | null = null;

export const useLibrary = create<LibraryState>((set, get) => ({
  favorites: new Set(),
  progress: new Map(),
  history: [],
  hydrated: false,

  hydrate: async () => {
    if (get().hydrated) return;

    hydration ??= (async () => {
      try {
        const [favorites, progressRows, historyRow] = await Promise.all([
          db.favorites.toArray(),
          db.progress.toArray(),
          db.kv.get(HISTORY_KEY),
        ]);

        const favoriteIds = new Set(favorites.map((f: Favorite) => f.comicId));
        const progress = new Map(progressRows.map((p: ReadingProgress) => [p.chapterId, p]));

        // Replay anything the previous session recorded but did not get to
        // write. A journalled intent is always the newer of the two by
        // construction, so it wins over the row it shadows.
        const journal = readJournal();
        for (const [comicId, intent] of Object.entries(journal.favorites)) {
          if (intent.op === 'add') favoriteIds.add(comicId);
          else favoriteIds.delete(comicId);
        }
        for (const entry of Object.values(journal.progress)) {
          const existing = progress.get(entry.chapterId);
          if (!existing || entry.updatedAt >= existing.updatedAt) {
            progress.set(entry.chapterId, entry);
          }
        }

        set({
          favorites: favoriteIds,
          progress,
          history: Array.isArray(historyRow?.value) ? (historyRow.value as string[]) : [],
          hydrated: true,
        });

        void flushJournal(journal);
      } catch (err) {
        // A blocked or corrupt database must not leave the app stuck behind
        // the hydration gate; an empty library is recoverable, a blank screen
        // is not.
        console.warn('[library] could not read local library; starting empty', err);
        set({ hydrated: true });
      } finally {
        hydration = null;
      }
    })();

    return hydration;
  },

  toggleFavorite: async (comicId) => {
    const next = new Set(get().favorites);
    const adding = !next.has(comicId);

    // Optimistic: the star should respond to the tap immediately, and a failed
    // write here is recoverable on next hydrate.
    if (adding) next.add(comicId);
    else next.delete(comicId);
    set({ favorites: next });

    // Journalled first and synchronously, so the intent is already durable if
    // the app is closed before the asynchronous write below commits.
    const at = recordFavoriteIntent(comicId, adding ? 'add' : 'remove');

    try {
      if (adding) await db.favorites.put({ comicId, addedAt: at });
      else await db.favorites.delete(comicId);
      clearFavoriteIntent(comicId, at);
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

    // Closing the app on the page you just turned to is the common case, so
    // the position is journalled before the store write is attempted.
    recordProgressIntent(entry);

    // Progress is written on every page turn, so a quota failure here must not
    // interrupt reading; the in-memory copy carries the session either way.
    await withQuotaHandling(() => db.progress.put(entry))
      .then(() => clearProgressIntent(chapterId, entry.updatedAt))
      .catch((err: unknown) => {
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

/**
 * Move replayed intents into Dexie so the journal drains.
 *
 * Failures are ignored on purpose: the entry stays journalled and is replayed
 * on the next start, which is the behaviour that makes it a journal rather
 * than a cache.
 */
async function flushJournal(journal: Journal): Promise<void> {
  for (const [comicId, intent] of Object.entries(journal.favorites)) {
    try {
      if (intent.op === 'add') await db.favorites.put({ comicId, addedAt: intent.at });
      else await db.favorites.delete(comicId);
      clearFavoriteIntent(comicId, intent.at);
    } catch (err) {
      console.warn('[library] could not replay a favourite', err);
    }
  }

  for (const entry of Object.values(journal.progress)) {
    try {
      await db.progress.put(entry);
      clearProgressIntent(entry.chapterId, entry.updatedAt);
    } catch (err) {
      console.warn('[library] could not replay reading progress', err);
    }
  }
}

/** Cache a comic's metadata so the library grid renders offline. */
export async function cacheComicSummary(comic: ComicSummary): Promise<void> {
  await withQuotaHandling(() => db.comics.put({ ...comic, cachedAt: Date.now() })).catch(
    (err: unknown) => console.warn('[library] could not cache comic metadata', err),
  );
}
