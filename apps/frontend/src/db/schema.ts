import Dexie, { type EntityTable } from 'dexie';
import type { Chapter, ComicSummary } from '@comic/shared';

/**
 * Offline store.
 *
 * Page bytes live here as Blobs rather than base64 strings: IndexedDB stores a
 * Blob by reference to the backing file, so a 400-page chapter costs its real
 * size on disk instead of the ~33% inflation base64 would add, and reading one
 * back does not have to decode a giant string on the main thread.
 */

/** A comic the user has interacted with. Cached so the library works offline. */
export interface StoredComic extends ComicSummary {
  /** Cover bytes, saved alongside so the library grid renders with no network. */
  coverBlob?: Blob;
  cachedAt: number;
}

export interface StoredChapter extends Chapter {
  /** Unset until every page has landed. Used to distinguish partial downloads. */
  downloadedAt?: number;
  /** Total bytes of this chapter's pages, for the storage breakdown UI. */
  bytes?: number;
}

export interface StoredPage {
  id: string;
  chapterId: string;
  index: number;
  blob: Blob;
  width: number | null;
  height: number | null;
  bytes: number;
}

export type DownloadStatus = 'queued' | 'running' | 'paused' | 'done' | 'failed';

export interface DownloadTask {
  id?: number;
  chapterId: string;
  comicId: string;
  /** Denormalized for the queue UI, which must render without a join. */
  comicTitle: string;
  chapterTitle: string;
  status: DownloadStatus;
  /** Pages already stored; the queue resumes from here after a restart. */
  completed: number;
  total: number;
  bytes: number;
  error?: string;
  /** Consecutive failures; drives the backoff and the give-up threshold. */
  attempts: number;
  queuedAt: number;
  updatedAt: number;
}

export interface ReadingProgress {
  chapterId: string;
  comicId: string;
  pageIndex: number;
  pageCount: number;
  updatedAt: number;
}

export interface Favorite {
  comicId: string;
  addedAt: number;
}

/** Zustand slices are persisted here rather than in localStorage. */
export interface KeyValue {
  key: string;
  value: unknown;
}

export class ComicDatabase extends Dexie {
  comics!: EntityTable<StoredComic, 'id'>;
  chapters!: EntityTable<StoredChapter, 'id'>;
  pages!: EntityTable<StoredPage, 'id'>;
  queue!: EntityTable<DownloadTask, 'id'>;
  progress!: EntityTable<ReadingProgress, 'chapterId'>;
  favorites!: EntityTable<Favorite, 'comicId'>;
  kv!: EntityTable<KeyValue, 'key'>;

  constructor(name = 'comic-reader') {
    super(name);

    /*
     * Indexes are chosen for the three hot queries:
     *   - pages of a chapter in order      -> [chapterId+index]
     *   - chapters of a comic in order     -> [comicId+number]
     *   - next runnable download           -> status
     * Anything not listed is not indexed, which keeps write amplification down
     * on the page table where the volume is.
     */
    this.version(1).stores({
      comics: 'id, title, cachedAt',
      chapters: 'id, comicId, [comicId+number], downloadedAt',
      pages: 'id, chapterId, [chapterId+index]',
      queue: '++id, chapterId, status, queuedAt',
      progress: 'chapterId, comicId, updatedAt',
      favorites: 'comicId, addedAt',
      kv: 'key',
    });
  }
}

export const db = new ComicDatabase();
