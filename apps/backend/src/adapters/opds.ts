import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';
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
import type { OpdsCatalogConfig } from '../config.js';

/**
 * OPDS 1.2 (Atom) catalog client. Targets Kavita, Komga, Calibre-Web and any
 * other server speaking the standard, which is what most people with a legally
 * owned digital library already run.
 *
 * The awkward part of OPDS for a page-turning reader: the spec exposes
 * *acquisition* (download the whole EPUB/CBZ) and has no notion of an
 * individual page. Vendor page-streaming APIs exist but differ per server, so
 * instead of picking one we download the acquisition archive once into a local
 * cache and then read pages out of it with the same zip reader the local
 * adapter uses. That keeps one code path for page extraction and means offline
 * download and online reading share the same bytes.
 */

const ATOM_NS_LINK = 'link';
const REL_ACQUISITION = 'http://opds-spec.org/acquisition';
const REL_IMAGE = 'http://opds-spec.org/image';
const REL_THUMB = 'http://opds-spec.org/image/thumbnail';
const ARCHIVE_TYPES = ['application/vnd.comicbook+zip', 'application/zip', 'application/x-cbz'];

interface AtomLink {
  rel?: string;
  href?: string;
  type?: string;
  title?: string;
}

interface AtomEntry {
  id?: string;
  title?: string | { '#text'?: string };
  summary?: string | { '#text'?: string };
  content?: string | { '#text'?: string };
  updated?: string;
  author?: { name?: string } | { name?: string }[];
  category?: { term?: string } | { term?: string }[];
  link?: AtomLink | AtomLink[];
}

interface AtomFeed {
  feed?: {
    title?: string;
    entry?: AtomEntry | AtomEntry[];
    link?: AtomLink | AtomLink[];
  };
}

const asArray = <T,>(v: T | T[] | undefined): T[] =>
  v === undefined ? [] : Array.isArray(v) ? v : [v];

const asText = (v: string | { '#text'?: string } | undefined): string => {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && typeof v['#text'] === 'string') return v['#text'];
  return '';
};

/** Injected by the registry so all outbound traffic goes through the SSRF guard. */
export type GuardedFetch = (
  url: string,
  headers?: Record<string, string>,
) => Promise<{ body: Buffer; contentType: string | null }>;

const encodeId = (s: string): string => Buffer.from(s, 'utf8').toString('base64url');
const decodeId = (s: string): string => Buffer.from(s, 'base64url').toString('utf8');

export class OpdsAdapter implements ProviderAdapter {
  readonly id: string;
  readonly label: string;
  readonly kind = 'opds' as const;

  readonly #cfg: OpdsCatalogConfig;
  readonly #fetch: GuardedFetch;
  readonly #archiveDir: string;
  readonly #maxEntryBytes: number;
  readonly #parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    // Atom mixes attributes and text; keeping both accessible avoids surprises.
    textNodeName: '#text',
    trimValues: true,
  });

  /** Feed responses are cached briefly; catalogs are slow and rarely change. */
  readonly #feedCache = new Map<string, { value: AtomFeed; expiresAt: number }>();
  static readonly #FEED_TTL_MS = 60_000;

  constructor(
    cfg: OpdsCatalogConfig,
    deps: { fetch: GuardedFetch; archiveDir: string; maxEntryBytes: number },
  ) {
    this.id = cfg.id;
    this.label = cfg.label;
    this.#cfg = cfg;
    this.#fetch = deps.fetch;
    this.#archiveDir = deps.archiveDir;
    this.#maxEntryBytes = deps.maxEntryBytes;
  }

  proxyHosts(): readonly string[] {
    return [new URL(this.#cfg.url).hostname.toLowerCase()];
  }

  #headers(): Record<string, string> {
    const h: Record<string, string> = { accept: 'application/atom+xml, application/xml, */*' };
    if (this.#cfg.username) {
      const raw = `${this.#cfg.username}:${this.#cfg.password ?? ''}`;
      h['authorization'] = `Basic ${Buffer.from(raw, 'utf8').toString('base64')}`;
    }
    return h;
  }

  /** Resolve a possibly-relative OPDS href against the catalog root. */
  #absolute(href: string): string {
    return new URL(href, this.#cfg.url).toString();
  }

  async #getFeed(url: string): Promise<AtomFeed> {
    const now = Date.now();
    const cached = this.#feedCache.get(url);
    if (cached && cached.expiresAt > now) return cached.value;

    const { body } = await this.#fetch(url, this.#headers());
    let parsed: AtomFeed;
    try {
      parsed = this.#parser.parse(body.toString('utf8')) as AtomFeed;
    } catch (err) {
      throw new AppError('UPSTREAM_MALFORMED', `OPDS feed is not valid XML: ${String(err)}`);
    }
    if (!parsed.feed) {
      throw new AppError('UPSTREAM_MALFORMED', 'OPDS response has no <feed> element');
    }

    this.#feedCache.set(url, { value: parsed, expiresAt: now + OpdsAdapter.#FEED_TTL_MS });
    return parsed;
  }

  async health(): Promise<boolean> {
    try {
      await this.#getFeed(this.#cfg.url);
      return true;
    } catch {
      return false;
    }
  }

  #entryToSummary(entry: AtomEntry): LocalComicSummary | null {
    const links = asArray(entry[ATOM_NS_LINK]);
    const title = asText(entry.title);
    if (!title) return null;

    // An entry is a publication if it offers acquisition; otherwise it is a
    // navigation node and belongs in the browse tree, not the catalog list.
    const acquisition = links.find(
      (l) => l.rel?.startsWith(REL_ACQUISITION) && l.href !== undefined,
    );
    const subFeed = links.find(
      (l) => l.type?.includes('application/atom+xml') && l.href !== undefined,
    );
    if (!acquisition && !subFeed) return null;

    const coverLink =
      links.find((l) => l.rel === REL_IMAGE && l.href) ??
      links.find((l) => l.rel === REL_THUMB && l.href);

    // The entry id is our local id; where absent, fall back to the sub-feed or
    // acquisition href, which is stable enough to round-trip.
    const localId = entry.id ?? subFeed?.href ?? acquisition?.href;
    if (!localId) return null;

    const authors = asArray(entry.author)
      .map((a) => a?.name)
      .filter((n): n is string => typeof n === 'string' && n.length > 0);
    const genres = asArray(entry.category)
      .map((c) => c?.term)
      .filter((t): t is string => typeof t === 'string' && t.length > 0);

    return {
      id: encodeId(localId),
      title,
      cover: coverLink?.href
        ? { kind: 'http', url: this.#absolute(coverLink.href), headers: this.#headers() }
        : null,
      authors,
      genres,
      status: 'unknown',
      year: null,
      chapterCount: null,
    };
  }

  /**
   * Find the browsable feed for an entry id. OPDS ids are opaque, so we walk
   * the catalog looking for the entry rather than assuming a URL scheme.
   */
  async #findEntry(localId: string): Promise<{ entry: AtomEntry; feedUrl: string }> {
    const visited = new Set<string>();
    const queue: string[] = [this.#cfg.url];
    // Bounded walk: a misconfigured catalog can otherwise be an infinite tree.
    let budget = 25;

    while (queue.length > 0 && budget-- > 0) {
      const url = queue.shift()!;
      if (visited.has(url)) continue;
      visited.add(url);

      const feed = await this.#getFeed(url).catch(() => null);
      if (!feed?.feed) continue;

      for (const entry of asArray(feed.feed.entry)) {
        const links = asArray(entry[ATOM_NS_LINK]);
        const acquisition = links.find((l) => l.rel?.startsWith(REL_ACQUISITION));
        const subFeed = links.find((l) => l.type?.includes('application/atom+xml'));
        const candidate = entry.id ?? subFeed?.href ?? acquisition?.href;
        if (candidate === localId) return { entry, feedUrl: url };

        // Descend into navigation nodes we have not seen.
        if (subFeed?.href && !acquisition) {
          const abs = this.#absolute(subFeed.href);
          if (!visited.has(abs)) queue.push(abs);
        }
      }
    }
    throw new AppError('NOT_FOUND', 'no such entry in this OPDS catalog');
  }

  async search({ q, page }: SearchArgs): Promise<{ items: LocalComicSummary[]; hasMore: boolean }> {
    // Prefer the catalog's own search endpoint; fall back to client filtering.
    const rootFeed = await this.#getFeed(this.#cfg.url);
    const searchLink = asArray(rootFeed.feed?.link).find((l) => l.rel === 'search' && l.href);

    let feedUrl = this.#cfg.url;
    let clientFilter = true;

    if (q && searchLink?.href) {
      const template = this.#absolute(searchLink.href);
      if (template.includes('{searchTerms}')) {
        feedUrl = template.replace('{searchTerms}', encodeURIComponent(q));
        clientFilter = false;
      }
    }

    const feed = await this.#getFeed(feedUrl);
    let items = asArray(feed.feed?.entry)
      .map((e) => this.#entryToSummary(e))
      .filter((s): s is LocalComicSummary => s !== null);

    if (clientFilter && q) {
      const needle = q.toLowerCase();
      items = items.filter((i) => i.title.toLowerCase().includes(needle));
    }

    const PER_PAGE = 30;
    const start = page * PER_PAGE;
    return { items: items.slice(start, start + PER_PAGE), hasMore: items.length > start + PER_PAGE };
  }

  async featured(): Promise<LocalComicSummary[]> {
    const feed = await this.#getFeed(this.#cfg.url);
    return asArray(feed.feed?.entry)
      .map((e) => this.#entryToSummary(e))
      .filter((s): s is LocalComicSummary => s !== null)
      .slice(0, 20);
  }

  async getComic(id: string): Promise<LocalComicDetail> {
    const { entry } = await this.#findEntry(decodeId(id));
    const summary = this.#entryToSummary(entry);
    if (!summary) throw new AppError('UPSTREAM_MALFORMED', 'OPDS entry is not a publication');
    return {
      ...summary,
      id,
      description: asText(entry.summary) || asText(entry.content),
      updatedAt: entry.updated ?? null,
    };
  }

  async getChapters(comicId: string): Promise<LocalChapter[]> {
    const { entry } = await this.#findEntry(decodeId(comicId));
    const links = asArray(entry[ATOM_NS_LINK]);
    const subFeed = links.find((l) => l.type?.includes('application/atom+xml') && l.href);

    // A series entry points at a sub-feed whose entries are the volumes.
    if (subFeed?.href) {
      const feed = await this.#getFeed(this.#absolute(subFeed.href));
      const entries = asArray(feed.feed?.entry);
      const chapters: LocalChapter[] = [];

      for (const [i, child] of entries.entries()) {
        const childLinks = asArray(child[ATOM_NS_LINK]);
        const acq = childLinks.find(
          (l) => l.rel?.startsWith(REL_ACQUISITION) && l.href && this.#isArchive(l),
        );
        if (!acq?.href) continue;

        const title = asText(child.title) || `Chapter ${i + 1}`;
        const match = /(\d+(?:\.\d+)?)/.exec(title);
        chapters.push({
          // Chapter id is the acquisition URL: everything else derives from it.
          id: encodeId(this.#absolute(acq.href)),
          comicId,
          number: match?.[1] ? Number(match[1]) : i + 1,
          title,
          volume: null,
          pageCount: 0, // unknown until the archive is fetched
          publishedAt: child.updated ?? null,
          coverUrl: null,
        });
      }

      if (chapters.length === 0) {
        throw new AppError(
          'UPSTREAM_MALFORMED',
          'no CBZ/ZIP downloads in this series; only comic archives can be read as pages',
        );
      }
      chapters.sort((a, b) => a.number - b.number);
      return chapters;
    }

    // A standalone publication is its own single chapter.
    const acq = links.find((l) => l.rel?.startsWith(REL_ACQUISITION) && l.href && this.#isArchive(l));
    if (!acq?.href) {
      throw new AppError(
        'UPSTREAM_MALFORMED',
        'this publication has no CBZ/ZIP download; only comic archives can be read as pages',
      );
    }
    return [
      {
        id: encodeId(this.#absolute(acq.href)),
        comicId,
        number: 1,
        title: asText(entry.title) || 'Chapter 1',
        volume: null,
        pageCount: 0,
        publishedAt: entry.updated ?? null,
        coverUrl: null,
      },
    ];
  }

  #isArchive(link: AtomLink): boolean {
    if (link.type && ARCHIVE_TYPES.some((t) => link.type!.includes(t))) return true;
    return /\.(cbz|zip)(\?|$)/i.test(link.href ?? '');
  }

  /**
   * Download the acquisition archive to the local cache if it is not already
   * there. Keyed by URL hash so re-reading a chapter costs nothing, and the
   * same file backs both online reading and offline download.
   */
  async #ensureArchive(acquisitionUrl: string): Promise<string> {
    const key = crypto.createHash('sha256').update(acquisitionUrl).digest('hex');
    const dest = path.join(this.#archiveDir, `${key}.cbz`);

    try {
      await fs.access(dest);
      return dest;
    } catch {
      // not cached yet
    }

    const { body } = await this.#fetch(acquisitionUrl, this.#headers());
    await fs.mkdir(this.#archiveDir, { recursive: true });
    // Write to a temp name and rename, so a crash mid-download cannot leave a
    // truncated archive that later reads would treat as valid.
    const tmp = `${dest}.${process.pid}.tmp`;
    await fs.writeFile(tmp, body);
    await fs.rename(tmp, dest);
    return dest;
  }

  async getPages(chapterId: string): Promise<LocalPageRef[]> {
    const acquisitionUrl = decodeId(chapterId);
    const archivePath = await this.#ensureArchive(acquisitionUrl);
    const entries = await listImageEntries(archivePath);
    if (entries.length === 0) {
      throw new AppError('UPSTREAM_MALFORMED', 'downloaded archive contains no readable images');
    }

    return entries.map((entry, index) => ({
      id: encodeId(`${archivePath}\u0000${entry.name}`),
      chapterId,
      index,
      width: null,
      height: null,
      source: { kind: 'zip-entry', archivePath, entryName: entry.name },
    }));
  }

  async resolveImage(ref: string): Promise<ImageSource> {
    const decoded = decodeId(ref);
    const nul = decoded.indexOf('\u0000');
    if (nul >= 0) {
      const archivePath = decoded.slice(0, nul);
      // Archive paths are ones we wrote ourselves; confirm before reading.
      if (!path.resolve(archivePath).startsWith(path.resolve(this.#archiveDir))) {
        throw new AppError('FORBIDDEN', 'archive path is outside the OPDS cache');
      }
      return { kind: 'zip-entry', archivePath, entryName: decoded.slice(nul + 1) };
    }
    // Otherwise it is a remote cover URL; the proxy re-validates the host.
    return { kind: 'http', url: decoded, headers: this.#headers() };
  }

  get maxEntryBytes(): number {
    return this.#maxEntryBytes;
  }
}
