import fs from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '@comic/shared';
import { listImageEntries } from './zip.js';
import type {
  ImageSource,
  LocalChapter,
  LocalComicDetail,
  LocalComicSummary,
  LocalPageRef,
  ProviderAdapter,
  SearchArgs,
} from './types.js';

/**
 * Serves comics the operator already has on disk.
 *
 * Expected layout, which matches how most people already keep a library:
 *
 *   LIBRARY/
 *     Series Name/            <- a series; each archive inside is one chapter
 *       cover.jpg             <- optional; first page of chapter 1 is used otherwise
 *       Chapter 01.cbz
 *       Chapter 02.cbz
 *     One Shot.cbz            <- a bare archive is a single-chapter series
 *
 * Only CBZ is read natively. CBR is RAR-compressed and PDF needs a rasterizer;
 * both are detected and reported with a specific message rather than being
 * silently skipped, so a user whose library is half CBR understands why half
 * of it is missing.
 */

const ARCHIVE_EXT = /\.(cbz|zip)$/i;
const UNSUPPORTED_EXT = /\.(cbr|rar|pdf)$/i;
const COVER_NAMES = ['cover.jpg', 'cover.jpeg', 'cover.png', 'cover.webp', 'folder.jpg'];

/** Ids are base64url of the library-relative path: opaque, URL-safe, reversible. */
const encodeId = (relPath: string): string => Buffer.from(relPath, 'utf8').toString('base64url');
const decodeId = (id: string): string => Buffer.from(id, 'base64url').toString('utf8');

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export class LocalAdapter implements ProviderAdapter {
  readonly id = 'local';
  readonly label = 'Local Library';
  readonly kind = 'local' as const;

  readonly #root: string;
  readonly #maxEntryBytes: number;
  /** Directory scans are cheap but not free; a short TTL keeps the feed snappy. */
  #index: CacheEntry<LocalComicSummary[]> | null = null;
  readonly #chapterCache = new Map<string, CacheEntry<LocalChapter[]>>();
  static readonly #TTL_MS = 30_000;

  constructor(root: string, maxEntryBytes: number) {
    this.#root = path.resolve(root);
    this.#maxEntryBytes = maxEntryBytes;
  }

  proxyHosts(): readonly string[] {
    return []; // everything is local; the proxy never leaves the machine
  }

  async health(): Promise<boolean> {
    try {
      const st = await fs.stat(this.#root);
      return st.isDirectory();
    } catch {
      return false;
    }
  }

  /**
   * Resolve a library-relative path to an absolute one, refusing anything that
   * escapes the root. Ids come from URLs, so a crafted id must not be able to
   * turn into `../../etc/passwd`. `path.resolve` collapses the traversal and
   * the prefix check then rejects it.
   */
  #safeResolve(relPath: string): string {
    const abs = path.resolve(this.#root, relPath);
    const rootWithSep = this.#root.endsWith(path.sep) ? this.#root : this.#root + path.sep;
    if (abs !== this.#root && !abs.startsWith(rootWithSep)) {
      throw new AppError('FORBIDDEN', 'path escapes the library root');
    }
    return abs;
  }

  async #scanLibrary(): Promise<LocalComicSummary[]> {
    const now = Date.now();
    if (this.#index && this.#index.expiresAt > now) return this.#index.value;

    let dirents: import('node:fs').Dirent[];
    try {
      dirents = await fs.readdir(this.#root, { withFileTypes: true });
    } catch (err) {
      throw new AppError(
        'UPSTREAM_UNAVAILABLE',
        `local library "${this.#root}" is not readable: ${String(err)}`,
      );
    }

    const items: LocalComicSummary[] = [];

    for (const dirent of dirents) {
      if (dirent.name.startsWith('.')) continue;
      const relPath = dirent.name;

      if (dirent.isDirectory()) {
        const cover = await this.#findSeriesCover(relPath);
        const chapterCount = await this.#countArchives(relPath);
        if (chapterCount === 0) continue; // a directory with no readable archives is not a series
        items.push({
          id: encodeId(relPath),
          title: dirent.name,
          cover,
          authors: [],
          genres: [],
          status: 'unknown',
          year: null,
          chapterCount,
        });
      } else if (ARCHIVE_EXT.test(dirent.name)) {
        items.push({
          id: encodeId(relPath),
          title: dirent.name.replace(ARCHIVE_EXT, ''),
          cover: { kind: 'zip-entry', archivePath: relPath, entryName: '' }, // '' = first image
          authors: [],
          genres: [],
          status: 'completed',
          year: null,
          chapterCount: 1,
        });
      }
    }

    const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
    items.sort((a, b) => collator.compare(a.title, b.title));

    this.#index = { value: items, expiresAt: now + LocalAdapter.#TTL_MS };
    return items;
  }

  async #findSeriesCover(relDir: string): Promise<ImageSource | null> {
    for (const name of COVER_NAMES) {
      const rel = path.join(relDir, name);
      try {
        await fs.access(this.#safeResolve(rel));
        return { kind: 'file', path: rel };
      } catch {
        // try the next candidate
      }
    }
    // Fall back to the first page of the first chapter.
    const archives = await this.#listArchives(relDir);
    const first = archives[0];
    return first ? { kind: 'zip-entry', archivePath: first, entryName: '' } : null;
  }

  async #listArchives(relDir: string): Promise<string[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.#safeResolve(relDir));
    } catch {
      return [];
    }
    const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
    return names
      .filter((n) => ARCHIVE_EXT.test(n) && !n.startsWith('.'))
      .sort(collator.compare)
      .map((n) => path.join(relDir, n));
  }

  async #countArchives(relDir: string): Promise<number> {
    return (await this.#listArchives(relDir)).length;
  }

  async search({ q, page }: SearchArgs): Promise<{ items: LocalComicSummary[]; hasMore: boolean }> {
    const all = await this.#scanLibrary();
    const needle = q.trim().toLowerCase();
    const matched = needle ? all.filter((c) => c.title.toLowerCase().includes(needle)) : all;
    const PER_PAGE = 30;
    const start = page * PER_PAGE;
    return { items: matched.slice(start, start + PER_PAGE), hasMore: matched.length > start + PER_PAGE };
  }

  async featured(): Promise<LocalComicSummary[]> {
    return (await this.#scanLibrary()).slice(0, 20);
  }

  async getComic(id: string): Promise<LocalComicDetail> {
    const all = await this.#scanLibrary();
    const found = all.find((c) => c.id === id);
    if (!found) throw new AppError('NOT_FOUND', 'no such comic in the local library');

    const relPath = decodeId(id);
    let updatedAt: string | null = null;
    try {
      updatedAt = (await fs.stat(this.#safeResolve(relPath))).mtime.toISOString();
    } catch {
      // A stat failure is not fatal; the entry just loses its timestamp.
    }
    return { ...found, description: '', updatedAt };
  }

  async getChapters(comicId: string): Promise<LocalChapter[]> {
    const now = Date.now();
    const cached = this.#chapterCache.get(comicId);
    if (cached && cached.expiresAt > now) return cached.value;

    const relPath = decodeId(comicId);
    const abs = this.#safeResolve(relPath);

    let stat: import('node:fs').Stats;
    try {
      stat = await fs.stat(abs);
    } catch {
      throw new AppError('NOT_FOUND', 'comic path no longer exists');
    }

    const chapters: LocalChapter[] = [];

    if (stat.isFile()) {
      // Bare archive: the series is its single chapter.
      const entries = await listImageEntries(abs);
      chapters.push({
        id: encodeId(relPath),
        comicId,
        number: 1,
        title: path.basename(relPath).replace(ARCHIVE_EXT, ''),
        volume: null,
        pageCount: entries.length,
        publishedAt: stat.mtime.toISOString(),
        coverUrl: null,
      });
    } else {
      const archives = await this.#listArchives(relPath);
      if (archives.length === 0) {
        // Surface the CBR/PDF case explicitly instead of returning an empty list.
        const names = await fs.readdir(abs).catch(() => [] as string[]);
        if (names.some((n) => UNSUPPORTED_EXT.test(n))) {
          throw new AppError(
            'UPSTREAM_MALFORMED',
            'this series contains only CBR/PDF files, which need conversion to CBZ first',
          );
        }
        throw new AppError('NOT_FOUND', 'no readable archives in this series');
      }

      for (const [i, archiveRel] of archives.entries()) {
        const archiveAbs = this.#safeResolve(archiveRel);
        const base = path.basename(archiveRel).replace(ARCHIVE_EXT, '');
        // Prefer a number embedded in the filename; fall back to position.
        const match = /(\d+(?:\.\d+)?)/.exec(base);
        const entries = await listImageEntries(archiveAbs).catch(() => []);
        const st = await fs.stat(archiveAbs).catch(() => null);
        chapters.push({
          id: encodeId(archiveRel),
          comicId,
          number: match?.[1] ? Number(match[1]) : i + 1,
          title: base,
          volume: null,
          pageCount: entries.length,
          publishedAt: st ? st.mtime.toISOString() : null,
          coverUrl: null,
        });
      }
    }

    chapters.sort((a, b) => a.number - b.number);
    this.#chapterCache.set(comicId, { value: chapters, expiresAt: now + LocalAdapter.#TTL_MS });
    return chapters;
  }

  async getPages(chapterId: string): Promise<LocalPageRef[]> {
    const archiveRel = decodeId(chapterId);
    const abs = this.#safeResolve(archiveRel);
    const entries = await listImageEntries(abs);
    if (entries.length === 0) {
      throw new AppError('UPSTREAM_MALFORMED', 'archive contains no readable images');
    }

    return entries.map((entry, index) => ({
      // The page id carries the entry name so resolveImage needs no index lookup.
      id: encodeId(`${archiveRel}\u0000${entry.name}`),
      chapterId,
      index,
      width: null,
      height: null,
      source: { kind: 'zip-entry', archivePath: archiveRel, entryName: entry.name },
    }));
  }

  async resolveImage(ref: string): Promise<ImageSource> {
    const decoded = decodeId(ref);

    // Composite ref: "<archive>\0<entry>"
    const nul = decoded.indexOf('\u0000');
    if (nul >= 0) {
      const archivePath = decoded.slice(0, nul);
      const entryName = decoded.slice(nul + 1);
      this.#safeResolve(archivePath); // validate, throws on traversal
      return { kind: 'zip-entry', archivePath, entryName };
    }

    const abs = this.#safeResolve(decoded);
    let stat: import('node:fs').Stats;
    try {
      stat = await fs.stat(abs);
    } catch {
      throw new AppError('NOT_FOUND', 'image path does not exist');
    }

    /*
     * A bare id with no entry suffix is a cover request, and the id is the
     * comic's own id. Covers therefore have to resolve the same way the
     * catalog listing chose them, or the URL the listing handed out will not
     * resolve back to anything.
     */
    if (stat.isDirectory()) {
      const cover = await this.#findSeriesCover(decoded);
      if (!cover) throw new AppError('NOT_FOUND', 'this series has no usable cover image');
      return cover;
    }

    if (stat.isFile() && ARCHIVE_EXT.test(decoded)) {
      // Cover request for a bare archive: hand back its first image.
      const entries = await listImageEntries(abs);
      const first = entries[0];
      if (!first) throw new AppError('NOT_FOUND', 'archive has no images to use as a cover');
      return { kind: 'zip-entry', archivePath: decoded, entryName: first.name };
    }
    return { kind: 'file', path: decoded };
  }

  /** Absolute path for an adapter-relative one. Used by the image loader. */
  absolutePath(relPath: string): string {
    return this.#safeResolve(relPath);
  }

  get maxEntryBytes(): number {
    return this.#maxEntryBytes;
  }

  /** Resolve `entryName: ''` (meaning "first image") to a concrete entry. */
  async firstEntryName(archiveRel: string): Promise<string> {
    const entries = await listImageEntries(this.#safeResolve(archiveRel));
    const first = entries[0];
    if (!first) throw new AppError('NOT_FOUND', 'archive has no images');
    return first.name;
  }
}
