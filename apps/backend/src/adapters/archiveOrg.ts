import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
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
import type { GuardedFetch } from './opds.js';

/**
 * Internet Archive adapter — public-domain and Creative Commons comics only.
 *
 * The archive.org `comics` collection mixes freely licensed scans with
 * user-uploaded copyrighted material. This adapter refuses to surface an item
 * unless its metadata carries an explicit open license URL (Creative Commons
 * or a public-domain mark). That keeps the catalog honest: a search for a
 * modern title returns nothing here rather than a pirated scan.
 *
 * Readable chapters are CBZ (ZIP) files only. CBR/RAR is skipped because the
 * page extractor is zip-based; PDF is skipped until a page renderer lands.
 * Acquisition works the same way as OPDS: download the archive once into the
 * local cache, then serve pages from zip entries through the shared image
 * pipeline.
 */

const SEARCH_ENDPOINT = 'https://archive.org/advancedsearch.php';
const METADATA_ENDPOINT = 'https://archive.org/metadata';
const DOWNLOAD_ENDPOINT = 'https://archive.org/download';
const COVER_ENDPOINT = 'https://archive.org/services/img';

/** Items without one of these license URL fragments are filtered out. */
const OPEN_LICENSE_FRAGMENTS = [
  'creativecommons.org/publicdomain',
  'creativecommons.org/licenses/publicdomain',
  'creativecommons.org/licenses/by/',
  'creativecommons.org/licenses/by-sa/',
  'creativecommons.org/licenses/by-nc/',
  'creativecommons.org/licenses/by-nc-sa/',
  'creativecommons.org/licenses/by-nc-nd/',
  'creativecommons.org/licenses/by-nd/',
] as const;

/**
 * Curated featured identifiers known to carry open licenses and CBZ files.
 * Hard-coded so the home shelf stays stable even when search ranking shifts.
 */
const FEATURED_IDENTIFIERS = [
  'GreenHornetComicsFromTheLate1940s',
  'HopalongCassidyComicsFromFawcettsMasterComics',
  'RodCameronComic01',
  'LoneRangerComicsAndOtherMovieWesternComics',
  'DurangoKidJohnnyMackBrownRockyLaneTimHoltComics',
] as const;

interface SearchDoc {
  identifier?: string;
  title?: string | string[];
  creator?: string | string[];
  year?: string | number;
  licenseurl?: string | string[];
  description?: string | string[];
}

interface IaFile {
  name: string;
  size?: string;
  format?: string;
}

interface IaMetadata {
  metadata?: {
    identifier?: string;
    title?: string | string[];
    creator?: string | string[];
    description?: string | string[];
    year?: string | number;
    licenseurl?: string | string[];
    subject?: string | string[];
  };
  files?: IaFile[];
  d1?: string;
  dir?: string;
}

const asList = (v: string | string[] | undefined): string[] => {
  if (v === undefined) return [];
  return Array.isArray(v) ? v.map(String) : [String(v)];
};

const firstText = (v: string | string[] | undefined): string => asList(v)[0] ?? '';

const encodeId = (s: string): string => Buffer.from(s, 'utf8').toString('base64url');
const decodeId = (s: string): string => Buffer.from(s, 'base64url').toString('utf8');

function hasOpenLicense(licenseUrls: string[]): boolean {
  return licenseUrls.some((url) => {
    const lower = url.toLowerCase();
    return OPEN_LICENSE_FRAGMENTS.some((frag) => lower.includes(frag));
  });
}

function isReadableCbz(file: IaFile): boolean {
  if (!/\.cbz$/i.test(file.name)) return false;
  // Derivatives and sidecar archives are not comic books.
  if (/_jp2|_daisy|_hocr|_spectrogram|_files\.|_meta\./i.test(file.name)) return false;
  return true;
}

function chapterTitleFromFilename(name: string): string {
  return name
    .replace(/\.cbz$/i, '')
    .replace(/[._-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export class ArchiveOrgAdapter implements ProviderAdapter {
  readonly id = 'archive';
  readonly label = 'Internet Archive (Public Domain)';
  readonly kind = 'archive' as const;

  readonly #fetch: GuardedFetch;
  readonly #fetchArchive: GuardedFetch;
  readonly #archiveDir: string;
  readonly #metaCache = new Map<string, { value: IaMetadata; expiresAt: number }>();
  static readonly #META_TTL_MS = 5 * 60_000;

  constructor(deps: {
    fetch: GuardedFetch;
    fetchArchive: GuardedFetch;
    archiveDir: string;
    maxEntryBytes: number;
  }) {
    this.#fetch = deps.fetch;
    this.#fetchArchive = deps.fetchArchive;
    this.#archiveDir = deps.archiveDir;
  }

  proxyHosts(): readonly string[] {
    // Covers, search, metadata, and the CDN hosts downloads redirect onto.
    return ['archive.org', '*.archive.org'];
  }

  async health(): Promise<boolean> {
    try {
      const { body } = await this.#fetch(
        `${SEARCH_ENDPOINT}?q=mediatype%3Atexts&rows=0&output=json`,
        { accept: 'application/json' },
      );
      const parsed = JSON.parse(body.toString('utf8')) as { response?: unknown };
      return Boolean(parsed.response);
    } catch {
      return false;
    }
  }

  async search(args: SearchArgs): Promise<{ items: LocalComicSummary[]; hasMore: boolean }> {
    const pageSize = 20;
    const page = Math.max(0, args.page) + 1; // IA pages are 1-indexed
    const terms = args.q.trim().length > 0 ? args.q.trim() : '*';

    // License filter is part of the query so the server does the cut, not us
    // after downloading a page of copyrighted hits. Keep the boolean query
    // simple: nested ORs inside collection clauses make Solr return empty
    // rather than error, which looks like "no matches" in the UI.
    const q =
      `format:"Comic Book ZIP" AND ` +
      `licenseurl:(*creativecommons.org*) AND ` +
      `(${terms})`;

    const url = new URL(SEARCH_ENDPOINT);
    url.searchParams.set('q', q);
    for (const fl of ['identifier', 'title', 'creator', 'year', 'licenseurl', 'description']) {
      url.searchParams.append('fl[]', fl);
    }
    url.searchParams.append('sort[]', 'downloads desc');
    url.searchParams.set('rows', String(pageSize));
    url.searchParams.set('page', String(page));
    url.searchParams.set('output', 'json');

    const { body } = await this.#fetch(url.toString(), { accept: 'application/json' });
    const parsed = JSON.parse(body.toString('utf8')) as {
      response?: { numFound?: number; docs?: SearchDoc[] };
    };
    const docs = parsed.response?.docs ?? [];
    const items = docs
      .filter((d) => d.identifier && hasOpenLicense(asList(d.licenseurl)))
      .map((d) => this.#summaryFromDoc(d));

    const numFound = parsed.response?.numFound ?? items.length;
    return { items, hasMore: page * pageSize < numFound };
  }

  async featured(): Promise<LocalComicSummary[]> {
    const out: LocalComicSummary[] = [];
    for (const id of FEATURED_IDENTIFIERS) {
      try {
        const meta = await this.#metadata(id);
        if (!hasOpenLicense(asList(meta.metadata?.licenseurl))) continue;
        const cbzCount = (meta.files ?? []).filter(isReadableCbz).length;
        if (cbzCount === 0) continue;
        out.push(this.#summaryFromMeta(id, meta, cbzCount));
      } catch {
        // A missing featured item must not empty the whole shelf.
      }
    }
    return out;
  }

  async getComic(id: string): Promise<LocalComicDetail> {
    const meta = await this.#metadata(id);
    if (!hasOpenLicense(asList(meta.metadata?.licenseurl))) {
      throw new AppError('FORBIDDEN', 'this item is not under an open license');
    }
    const cbz = (meta.files ?? []).filter(isReadableCbz);
    if (cbz.length === 0) {
      throw new AppError('NOT_FOUND', 'no readable CBZ files in this item');
    }
    const summary = this.#summaryFromMeta(id, meta, cbz.length);
    const license = firstText(meta.metadata?.licenseurl);
    const description = firstText(meta.metadata?.description);
    return {
      ...summary,
      description:
        (description ? `${description}\n\n` : '') +
        `Source: Internet Archive (${id}).` +
        (license ? ` License: ${license}` : ''),
      updatedAt: null,
    };
  }

  async getChapters(comicId: string): Promise<LocalChapter[]> {
    const meta = await this.#metadata(comicId);
    if (!hasOpenLicense(asList(meta.metadata?.licenseurl))) {
      throw new AppError('FORBIDDEN', 'this item is not under an open license');
    }

    const files = (meta.files ?? []).filter(isReadableCbz).sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }),
    );

    return files.map((file, index) => ({
      // Chapter id encodes identifier + filename so getPages needs no lookup table.
      id: encodeId(`${comicId}\0${file.name}`),
      comicId,
      number: index + 1,
      title: chapterTitleFromFilename(file.name),
      volume: null,
      pageCount: 0,
      publishedAt: null,
    }));
  }

  async getPages(chapterId: string): Promise<LocalPageRef[]> {
    const raw = decodeId(chapterId);
    const sep = raw.indexOf('\0');
    if (sep <= 0) throw new AppError('BAD_REQUEST', 'malformed archive chapter id');
    const identifier = raw.slice(0, sep);
    const filename = raw.slice(sep + 1);

    const meta = await this.#metadata(identifier);
    if (!hasOpenLicense(asList(meta.metadata?.licenseurl))) {
      throw new AppError('FORBIDDEN', 'this item is not under an open license');
    }

    const archivePath = await this.#ensureArchive(identifier, filename);
    const entries = await listImageEntries(archivePath);

    return entries.map((entry, index) => ({
      id: encodeId(`${archivePath}\0${entry.name}`),
      chapterId,
      index,
      // Width/height unknown until decode; the image pipeline fills them in.
      width: null,
      height: null,
      source: {
        kind: 'zip-entry' as const,
        archivePath,
        entryName: entry.name,
      },
    }));
  }

  async resolveImage(ref: string): Promise<ImageSource> {
    // Cover refs are the bare Internet Archive identifier (what #toSummary
    // passes through imageUrl). Page refs are base64url(archive\0entry).
    if (/^[A-Za-z0-9_.-]+$/.test(ref) && !ref.includes('\0')) {
      // Prefer treating short opaque ids as IA identifiers for covers.
      try {
        const decoded = decodeId(ref);
        if (decoded.includes('\0')) {
          ref = decoded;
        } else {
          return { kind: 'http', url: `${COVER_ENDPOINT}/${encodeURIComponent(ref)}` };
        }
      } catch {
        return { kind: 'http', url: `${COVER_ENDPOINT}/${encodeURIComponent(ref)}` };
      }
    }

    let decoded = ref;
    try {
      if (!ref.includes('\0')) decoded = decodeId(ref);
    } catch {
      decoded = ref;
    }

    const sep = decoded.indexOf('\0');
    if (sep <= 0) {
      return { kind: 'http', url: `${COVER_ENDPOINT}/${encodeURIComponent(decoded)}` };
    }

    const archivePath = decoded.slice(0, sep);
    const entryName = decoded.slice(sep + 1);
    const resolved = path.resolve(archivePath);
    if (!resolved.startsWith(path.resolve(this.#archiveDir) + path.sep)) {
      throw new AppError('FORBIDDEN', 'archive path escapes the cache directory');
    }
    return { kind: 'zip-entry', archivePath: resolved, entryName };
  }

  #summaryFromDoc(doc: SearchDoc): LocalComicSummary {
    const id = doc.identifier!;
    const yearRaw = doc.year !== undefined ? Number(doc.year) : NaN;
    return {
      id,
      title: firstText(doc.title) || id,
      cover: { kind: 'http', url: `${COVER_ENDPOINT}/${encodeURIComponent(id)}` },
      authors: asList(doc.creator),
      genres: ['Public domain'],
      status: 'completed',
      year: Number.isFinite(yearRaw) ? yearRaw : null,
      chapterCount: null,
    };
  }

  #summaryFromMeta(id: string, meta: IaMetadata, chapterCount: number): LocalComicSummary {
    const yearRaw = meta.metadata?.year !== undefined ? Number(meta.metadata.year) : NaN;
    return {
      id,
      title: firstText(meta.metadata?.title) || id,
      cover: { kind: 'http', url: `${COVER_ENDPOINT}/${encodeURIComponent(id)}` },
      authors: asList(meta.metadata?.creator),
      genres: ['Public domain'],
      status: 'completed',
      year: Number.isFinite(yearRaw) ? yearRaw : null,
      chapterCount,
    };
  }

  async #metadata(identifier: string): Promise<IaMetadata> {
    const cached = this.#metaCache.get(identifier);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const { body } = await this.#fetch(`${METADATA_ENDPOINT}/${encodeURIComponent(identifier)}`, {
      accept: 'application/json',
    });
    const parsed = JSON.parse(body.toString('utf8')) as IaMetadata;
    if (!parsed.metadata) {
      throw new AppError('NOT_FOUND', `Internet Archive item "${identifier}" was not found`);
    }
    this.#metaCache.set(identifier, {
      value: parsed,
      expiresAt: Date.now() + ArchiveOrgAdapter.#META_TTL_MS,
    });
    return parsed;
  }

  async #ensureArchive(identifier: string, filename: string): Promise<string> {
    await fs.mkdir(this.#archiveDir, { recursive: true });
    const key = crypto.createHash('sha256').update(`ia:${identifier}:${filename}`).digest('hex');
    const dest = path.join(this.#archiveDir, `${key}.cbz`);

    try {
      await fs.access(dest);
      return dest;
    } catch {
      // Not cached yet.
    }

    const url = `${DOWNLOAD_ENDPOINT}/${encodeURIComponent(identifier)}/${encodeURIComponent(filename)}`;
    const { body } = await this.#fetchArchive(url, {
      accept: 'application/zip, application/vnd.comicbook+zip, */*',
    });

    const tmp = `${dest}.${process.pid}.tmp`;
    await fs.writeFile(tmp, body);
    await fs.rename(tmp, dest);
    return dest;
  }
}
