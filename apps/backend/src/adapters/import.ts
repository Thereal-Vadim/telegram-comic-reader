import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { AppError, makeNamespacedId } from '@comic/shared';
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
import type { GuardedFetch } from './opds.js';
import {
  extractDriveConfirmToken,
  extractGoogleDriveFileId,
  isArchiveContentType,
  isHtmlContentType,
  resolveImportUrl,
  sniffContainer,
  type ResolvedImportUrl,
} from '../import/resolveUrl.js';
import { extractComicImages } from '../import/webPage.js';

/**
 * Personal URL import adapter.
 *
 * Unlike catalog adapters, content here is created by an authenticated user
 * pasting a link to something they already have (Drive share, Dropbox file,
 * direct CBZ, or a page of images on their own site). Records are scoped to
 * the importing Telegram user id so one person's imports never leak into
 * another's library.
 */

export type ImportRecordKind = 'archive' | 'web';

export interface ImportRecord {
  readonly id: string;
  readonly ownerId: number;
  readonly title: string;
  readonly sourceUrl: string;
  readonly kind: ImportRecordKind;
  readonly createdAt: string;
  readonly pageCount: number;
  /** Absolute path to a downloaded CBZ/ZIP. */
  readonly archivePath?: string;
  /** Absolute image URLs for web imports, in reading order. */
  readonly pageUrls?: string[];
  readonly description: string;
}

interface ImportIndex {
  records: ImportRecord[];
}

export type ImportFetch = GuardedFetch;

const encodeId = (s: string): string => Buffer.from(s, 'utf8').toString('base64url');
const decodeId = (s: string): string => Buffer.from(s, 'base64url').toString('utf8');

function titleFromUrl(url: string, filenameHint: string | null): string {
  if (filenameHint) {
    return filenameHint.replace(/\.(cbz|zip|cbr|rar|pdf)$/i, '').replace(/[._-]+/g, ' ').trim();
  }
  try {
    const u = new URL(url);
    const seg = u.pathname.split('/').filter(Boolean).pop();
    if (seg) {
      return decodeURIComponent(seg)
        .replace(/\.(cbz|zip|cbr|rar|pdf|html?)$/i, '')
        .replace(/[._-]+/g, ' ')
        .trim();
    }
    return u.hostname;
  } catch {
    return 'Imported comic';
  }
}

export class ImportAdapter implements ProviderAdapter {
  readonly id = 'import';
  readonly label = 'My Imports';
  readonly kind = 'import' as const;

  readonly #dir: string;
  readonly #indexPath: string;
  readonly #fetch: ImportFetch;
  readonly #maxArchiveBytes: number;
  readonly #maxEntryBytes: number;
  readonly #extraHosts: Set<string>;
  #index: ImportIndex | null = null;
  #indexLoaded = false;

  constructor(deps: {
    dir: string;
    fetch: ImportFetch;
    maxArchiveBytes: number;
    maxEntryBytes: number;
    /** Mutable set shared with the image-proxy allowlist. */
    extraHosts: Set<string>;
  }) {
    this.#dir = path.resolve(deps.dir);
    this.#indexPath = path.join(this.#dir, 'index.json');
    this.#fetch = deps.fetch;
    this.#maxArchiveBytes = deps.maxArchiveBytes;
    this.#maxEntryBytes = deps.maxEntryBytes;
    this.#extraHosts = deps.extraHosts;
  }

  proxyHosts(): readonly string[] {
    // Hosts are added dynamically as web imports land; boot-time set is empty.
    return [];
  }

  /** Expose the live allowlist set so the server can share it with the proxy. */
  get hostAllowlist(): Set<string> {
    return this.#extraHosts;
  }

  async health(): Promise<boolean> {
    try {
      await fs.mkdir(this.#dir, { recursive: true });
      return true;
    } catch {
      return false;
    }
  }

  async #loadIndex(): Promise<ImportIndex> {
    if (this.#indexLoaded && this.#index) return this.#index;
    try {
      const raw = await fs.readFile(this.#indexPath, 'utf8');
      const parsed = JSON.parse(raw) as ImportIndex;
      this.#index = { records: Array.isArray(parsed.records) ? parsed.records : [] };
    } catch {
      this.#index = { records: [] };
    }
    this.#indexLoaded = true;
    // Re-contribute web-import hosts after a restart.
    for (const rec of this.#index.records) {
      if (rec.kind === 'web' && rec.pageUrls) {
        for (const u of rec.pageUrls) {
          try {
            this.#extraHosts.add(new URL(u).hostname.toLowerCase());
          } catch {
            // skip malformed
          }
        }
      }
    }
    return this.#index;
  }

  async #saveIndex(index: ImportIndex): Promise<void> {
    await fs.mkdir(this.#dir, { recursive: true });
    const tmp = `${this.#indexPath}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(index, null, 2));
    await fs.rename(tmp, this.#indexPath);
    this.#index = index;
    this.#indexLoaded = true;
  }

  #owned(records: ImportRecord[], ownerId: number | undefined): ImportRecord[] {
    if (ownerId === undefined) return [];
    return records.filter((r) => r.ownerId === ownerId);
  }

  #toSummary(rec: ImportRecord): LocalComicSummary {
    const cover: ImageSource | null =
      rec.kind === 'archive' && rec.archivePath
        ? { kind: 'zip-entry', archivePath: rec.archivePath, entryName: '' }
        : rec.pageUrls?.[0]
          ? { kind: 'http', url: rec.pageUrls[0] }
          : null;

    return {
      id: encodeId(rec.id),
      title: rec.title,
      cover,
      authors: [],
      genres: ['Imported'],
      status: 'completed',
      year: null,
      chapterCount: 1,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Catalog surface                                                    */
  /*                                                                    */
  /* Imports are personal and must not leak across users on the shared  */
  /* home/search fan-out. featured/search stay empty; the dedicated     */
  /* /api/import list filters by the session owner instead.             */
  /* ------------------------------------------------------------------ */

  async search(_args: SearchArgs): Promise<{ items: LocalComicSummary[]; hasMore: boolean }> {
    return { items: [], hasMore: false };
  }

  async featured(): Promise<LocalComicSummary[]> {
    return [];
  }

  async getComic(id: string): Promise<LocalComicDetail> {
    const rec = await this.#requireRecord(id);
    return {
      ...this.#toSummary(rec),
      description: rec.description,
      updatedAt: rec.createdAt,
    };
  }

  async getChapters(comicId: string): Promise<LocalChapter[]> {
    const rec = await this.#requireRecord(comicId);
    return [
      {
        id: encodeId(rec.id),
        comicId: encodeId(rec.id),
        number: 1,
        title: rec.title,
        volume: null,
        pageCount: rec.pageCount,
        publishedAt: rec.createdAt,
      },
    ];
  }

  async getPages(chapterId: string): Promise<LocalPageRef[]> {
    const rec = await this.#requireRecord(chapterId);

    if (rec.kind === 'archive' && rec.archivePath) {
      const entries = await listImageEntries(rec.archivePath);
      if (entries.length === 0) {
        throw new AppError('UPSTREAM_MALFORMED', 'imported archive contains no readable images');
      }
      return entries.map((entry, index) => ({
        id: encodeId(`${rec.archivePath}\u0000${entry.name}`),
        chapterId,
        index,
        width: null,
        height: null,
        source: {
          kind: 'zip-entry' as const,
          archivePath: rec.archivePath!,
          entryName: entry.name,
        },
      }));
    }

    if (rec.kind === 'web' && rec.pageUrls) {
      return rec.pageUrls.map((url, index) => ({
        id: encodeId(`${rec.id}\u0000${index}\u0000${url}`),
        chapterId,
        index,
        width: null,
        height: null,
        source: { kind: 'http' as const, url },
      }));
    }

    throw new AppError('UPSTREAM_MALFORMED', 'import record has no readable pages');
  }

  async resolveImage(ref: string): Promise<ImageSource> {
    const decoded = decodeId(ref);
    const parts = decoded.split('\u0000');

    // Composite page ref: "<archivePath>\0<entry>" or "<id>\0<index>\0<url>"
    if (parts.length === 2) {
      const [archivePath, entryName] = parts as [string, string];
      if (!path.resolve(archivePath).startsWith(this.#dir + path.sep)) {
        throw new AppError('FORBIDDEN', 'archive path is outside the import cache');
      }
      return { kind: 'zip-entry', archivePath, entryName };
    }
    if (parts.length >= 3) {
      const url = parts.slice(2).join('\u0000');
      return { kind: 'http', url };
    }

    // Cover request: ref is the comic's encoded id.
    const byId = await this.#findByEncodedId(ref);
    if (!byId) throw new AppError('NOT_FOUND', 'no such import');
    if (byId.kind === 'archive' && byId.archivePath) {
      const entries = await listImageEntries(byId.archivePath);
      const first = entries[0];
      if (!first) throw new AppError('NOT_FOUND', 'imported archive has no cover image');
      return { kind: 'zip-entry', archivePath: byId.archivePath, entryName: first.name };
    }
    if (byId.pageUrls?.[0]) return { kind: 'http', url: byId.pageUrls[0] };
    throw new AppError('NOT_FOUND', 'import has no cover');
  }

  absolutePath(p: string): string {
    const abs = path.resolve(p);
    if (!abs.startsWith(this.#dir + path.sep) && abs !== this.#dir) {
      throw new AppError('FORBIDDEN', 'path escapes the import cache');
    }
    return abs;
  }

  async firstEntryName(archivePath: string): Promise<string> {
    const entries = await listImageEntries(archivePath);
    const first = entries[0];
    if (!first) throw new AppError('NOT_FOUND', 'archive has no images');
    return first.name;
  }

  /* ------------------------------------------------------------------ */
  /* Import API                                                         */
  /* ------------------------------------------------------------------ */

  async listForOwner(ownerId: number): Promise<ImportRecord[]> {
    const index = await this.#loadIndex();
    return this.#owned(index.records, ownerId).sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
  }

  async deleteForOwner(ownerId: number, encodedId: string): Promise<void> {
    const index = await this.#loadIndex();
    const id = decodeId(encodedId);
    const rec = index.records.find((r) => r.id === id);
    if (!rec || rec.ownerId !== ownerId) {
      throw new AppError('NOT_FOUND', 'no such import');
    }
    if (rec.archivePath) {
      await fs.unlink(rec.archivePath).catch(() => undefined);
    }
    await this.#saveIndex({ records: index.records.filter((r) => r.id !== id) });
  }

  async importUrl(args: {
    ownerId: number;
    url: string;
    title?: string;
  }): Promise<{ record: ImportRecord; encodedId: string }> {
    const resolved = resolveImportUrl(args.url);

    // Dedupe: same owner + same source URL returns the existing record.
    const index = await this.#loadIndex();
    const existing = index.records.find(
      (r) => r.ownerId === args.ownerId && r.sourceUrl === resolved.sourceUrl,
    );
    if (existing) {
      return { record: existing, encodedId: encodeId(existing.id) };
    }

    const fetched = await this.#fetchResolved(resolved);

    let record: ImportRecord;

    if (fetched.mode === 'archive') {
      record = await this.#importArchive({
        ownerId: args.ownerId,
        resolved,
        body: fetched.body,
        title: args.title,
        container: fetched.container,
      });
    } else {
      record = await this.#importWeb({
        ownerId: args.ownerId,
        resolved,
        html: fetched.html,
        title: args.title,
      });
    }

    index.records.push(record);
    await this.#saveIndex(index);
    return { record, encodedId: encodeId(record.id) };
  }

  async #requireRecord(encodedOrRawId: string): Promise<ImportRecord> {
    const rec = await this.#findByEncodedId(encodedOrRawId);
    if (!rec) throw new AppError('NOT_FOUND', 'no such import');
    return rec;
  }

  async #findByEncodedId(encodedId: string): Promise<ImportRecord | null> {
    const index = await this.#loadIndex();
    let id: string;
    try {
      id = decodeId(encodedId);
    } catch {
      return null;
    }
    return index.records.find((r) => r.id === id) ?? null;
  }

  async #fetchResolved(
    resolved: ResolvedImportUrl,
  ): Promise<
    | { mode: 'archive'; body: Buffer; container: 'zip' | 'rar' | 'pdf' }
    | { mode: 'web'; html: string }
  > {
    let { body, contentType } = await this.#fetch(resolved.fetchUrl, {
      accept: '*/*',
      'user-agent': 'ComicReaderImport/0.1',
    });

    // Google Drive large-file virus-scan interstitial.
    if (
      resolved.provider === 'google-drive' &&
      isHtmlContentType(contentType) &&
      body.length < 512 * 1024
    ) {
      const fileId = extractGoogleDriveFileId(resolved.sourceUrl);
      const html = body.toString('utf8');
      if (fileId && /confirm=|download_warning|uc-download-link|virus/i.test(html)) {
        const token = extractDriveConfirmToken(html, fileId);
        const retryUrl = token
          ? `https://drive.google.com/uc?export=download&confirm=${encodeURIComponent(token)}&id=${encodeURIComponent(fileId)}`
          : `https://drive.google.com/uc?export=download&confirm=t&id=${encodeURIComponent(fileId)}`;
        ({ body, contentType } = await this.#fetch(retryUrl, {
          accept: '*/*',
          'user-agent': 'ComicReaderImport/0.1',
        }));
      }
    }

    const sniffed = sniffContainer(body);

    if (sniffed === 'rar') {
      throw new AppError(
        'UPSTREAM_MALFORMED',
        'CBR/RAR archives are not readable yet — re-save the comic as CBZ/ZIP and import again',
      );
    }
    if (sniffed === 'pdf') {
      throw new AppError(
        'UPSTREAM_MALFORMED',
        'PDF import is not supported yet — convert pages to a CBZ/ZIP and import again',
      );
    }
    if (sniffed === 'zip') {
      return { mode: 'archive', body, container: 'zip' };
    }

    const asText = body.toString('utf8');
    const looksHtml =
      isHtmlContentType(contentType) ||
      /<html[\s>]/i.test(asText) ||
      /<img[\s>]/i.test(asText);

    if (looksHtml) {
      return { mode: 'web', html: asText };
    }

    // Provider promised an archive (Drive / Dropbox / .cbz URL) but magic bytes
    // did not match — usually a permission / login HTML interstitial.
    if (resolved.expected === 'archive' || isArchiveContentType(contentType)) {
      throw new AppError(
        'UPSTREAM_MALFORMED',
        'could not download a ZIP/CBZ archive from that link — check that sharing is set to “anyone with the link”',
      );
    }

    throw new AppError(
      'UPSTREAM_MALFORMED',
      'could not recognise the link as a CBZ/ZIP archive or a page of comic images',
    );
  }

  async #importArchive(args: {
    ownerId: number;
    resolved: ResolvedImportUrl;
    body: Buffer;
    title: string | undefined;
    container: 'zip' | 'rar' | 'pdf';
  }): Promise<ImportRecord> {
    if (args.body.byteLength > this.#maxArchiveBytes) {
      throw new AppError('UPSTREAM_MALFORMED', 'archive exceeds the import size limit');
    }

    await fs.mkdir(this.#dir, { recursive: true });
    const id = crypto.randomUUID();
    const archivePath = path.join(this.#dir, `${id}.cbz`);
    const tmp = `${archivePath}.${process.pid}.tmp`;
    await fs.writeFile(tmp, args.body);
    await fs.rename(tmp, archivePath);

    let pageCount: number;
    try {
      const entries = await listImageEntries(archivePath);
      pageCount = entries.length;
      if (pageCount === 0) {
        await fs.unlink(archivePath).catch(() => undefined);
        throw new AppError('UPSTREAM_MALFORMED', 'archive contains no readable images');
      }
      // Soft-check first entry size via listed uncompressed sizes.
      const oversized = entries.find((e) => e.uncompressedSize > this.#maxEntryBytes);
      if (oversized) {
        await fs.unlink(archivePath).catch(() => undefined);
        throw new AppError('UPSTREAM_MALFORMED', 'an archive page exceeds the size limit');
      }
    } catch (err) {
      await fs.unlink(archivePath).catch(() => undefined);
      throw err;
    }

    const title =
      args.title?.trim() ||
      titleFromUrl(args.resolved.sourceUrl, args.resolved.filenameHint) ||
      'Imported comic';

    return {
      id,
      ownerId: args.ownerId,
      title,
      sourceUrl: args.resolved.sourceUrl,
      kind: 'archive',
      createdAt: new Date().toISOString(),
      pageCount,
      archivePath,
      description: `Imported from ${args.resolved.provider} link.`,
    };
  }

  async #importWeb(args: {
    ownerId: number;
    resolved: ResolvedImportUrl;
    html: string;
    title: string | undefined;
  }): Promise<ImportRecord> {
    const extracted = extractComicImages(args.html, args.resolved.fetchUrl);
    for (const u of extracted.imageUrls) {
      try {
        this.#extraHosts.add(new URL(u).hostname.toLowerCase());
      } catch {
        // skip
      }
    }

    const id = crypto.randomUUID();
    const title = args.title?.trim() || extracted.title || 'Imported comic';

    return {
      id,
      ownerId: args.ownerId,
      title,
      sourceUrl: args.resolved.sourceUrl,
      kind: 'web',
      createdAt: new Date().toISOString(),
      pageCount: extracted.imageUrls.length,
      pageUrls: extracted.imageUrls,
      description: `Imported web page with ${extracted.imageUrls.length} pages.`,
    };
  }

  /** Namespaced helpers for the import route responses. */
  namespacedComicId(encodedId: string): string {
    return makeNamespacedId(this.id, encodedId);
  }
}
