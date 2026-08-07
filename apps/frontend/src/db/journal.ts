import type { ReadingProgress } from './schema';

/**
 * Synchronous write-ahead journal for the two pieces of state a user notices
 * losing: favourites and reading position.
 *
 * IndexedDB is the store of record, but its writes are asynchronous, and a
 * transaction that has not committed is discarded when the document goes away.
 * The gap is small but it is exactly where the important taps land: Telegram
 * tears the WebView down the instant the Mini App is swiped closed, and on a
 * loaded page a decode of a full-size cover can hold the main thread long
 * enough that the IndexedDB callbacks never get to run. Star a comic, close
 * the app, reopen — the star is gone.
 *
 * localStorage is synchronous, so an entry written inside the tap handler is
 * durable before the handler returns. Holding only intents that have not
 * reached Dexie yet keeps this a few hundred bytes, which is what makes it
 * safe to use a store whose 5 MB cap and main-thread writes rule it out for
 * the library itself.
 */

const KEY = 'comic.journal.v1';

export interface FavoriteIntent {
  op: 'add' | 'remove';
  at: number;
}

export interface Journal {
  favorites: Record<string, FavoriteIntent>;
  progress: Record<string, ReadingProgress>;
}

function read(): Journal {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { favorites: {}, progress: {} };

    const parsed = JSON.parse(raw) as Partial<Journal>;
    return {
      favorites: parsed.favorites ?? {},
      progress: parsed.progress ?? {},
    };
  } catch {
    // Corrupt or unavailable (private mode rejects writes on some clients).
    // Losing the journal only costs the last unflushed intent, so there is
    // nothing to gain by propagating this.
    return { favorites: {}, progress: {} };
  }
}

function write(journal: Journal): void {
  try {
    if (
      Object.keys(journal.favorites).length === 0 &&
      Object.keys(journal.progress).length === 0
    ) {
      localStorage.removeItem(KEY);
      return;
    }
    localStorage.setItem(KEY, JSON.stringify(journal));
  } catch {
    // Full or blocked. The Dexie write still runs; only crash durability is
    // lost, and the alternative is failing a favourite tap outright.
  }
}

export function readJournal(): Journal {
  return read();
}

/**
 * A wall-clock timestamp that never repeats within a session.
 *
 * The timestamp doubles as the identity of an intent, so two toggles landing
 * in the same millisecond must not share one: the first write completing would
 * otherwise clear the second tap's entry and lose it.
 */
let lastStamp = 0;
function stamp(): number {
  lastStamp = Math.max(Date.now(), lastStamp + 1);
  return lastStamp;
}

/** Record intent before the Dexie write starts. Returns its timestamp. */
export function recordFavoriteIntent(comicId: string, op: FavoriteIntent['op']): number {
  const at = stamp();
  const journal = read();
  journal.favorites[comicId] = { op, at };
  write(journal);
  return at;
}

export function recordProgressIntent(entry: ReadingProgress): void {
  const journal = read();
  journal.progress[entry.chapterId] = entry;
  write(journal);
}

/**
 * Drop an intent once Dexie holds it.
 *
 * Keyed on the timestamp so a toggle that happened while the previous write
 * was in flight is not silently discarded by the older write completing.
 */
export function clearFavoriteIntent(comicId: string, at: number): void {
  const journal = read();
  if (journal.favorites[comicId]?.at !== at) return;
  delete journal.favorites[comicId];
  write(journal);
}

export function clearProgressIntent(chapterId: string, updatedAt: number): void {
  const journal = read();
  if (journal.progress[chapterId]?.updatedAt !== updatedAt) return;
  delete journal.progress[chapterId];
  write(journal);
}

export function clearJournal(): void {
  write({ favorites: {}, progress: {} });
}
