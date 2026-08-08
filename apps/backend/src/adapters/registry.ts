import path from 'node:path';
import {
  AppError,
  makeNamespacedId,
  splitNamespacedId,
  type AdapterInfo,
  type Chapter,
  type ComicDetail,
  type ComicSummary,
  type ImageVariant,
  type PageRef,
} from '@comic/shared';
import type { Config } from '../config.js';
import { LocalAdapter } from './local.js';
import { OpdsAdapter, type GuardedFetch } from './opds.js';
import { ComxAdapter } from './comxAdapter.js';
import { ComxSession } from './comxSession.js';
import type { ImageSource, ProviderAdapter, SearchArgs } from './types.js';
import type { GuardOptions } from '../net/ssrf.js';

/**
 * Owns the set of configured adapters and is the only place that knows about
 * namespacing. Routes handle namespaced ids exclusively; adapters handle local
 * ids exclusively; this class is the translation layer between them.
 */

export interface DegradedAdapter {
  adapterId: string;
  reason: string;
}

/** Result of a fan-out: whatever succeeded, plus who failed and why. */
interface FanOut<T> {
  results: T[];
  degraded: DegradedAdapter[];
}

export class AdapterRegistry {
  readonly #adapters = new Map<string, ProviderAdapter>();
  readonly #proxyHosts = new Set<string>();

  constructor(adapters: ProviderAdapter[], extraProxyHosts: readonly string[]) {
    for (const a of adapters) {
      if (this.#adapters.has(a.id)) throw new Error(`duplicate adapter id "${a.id}"`);
      this.#adapters.set(a.id, a);
      for (const h of a.proxyHosts()) this.#proxyHosts.add(h.toLowerCase());
    }
    for (const h of extraProxyHosts) this.#proxyHosts.add(h.toLowerCase());
  }

  /** Hostnames the image proxy may contact. Fixed at boot. */
  get proxyHosts(): ReadonlySet<string> {
    return this.#proxyHosts;
  }

  get size(): number {
    return this.#adapters.size;
  }

  get(adapterId: string): ProviderAdapter {
    const a = this.#adapters.get(adapterId);
    if (!a) throw new AppError('NOT_FOUND', `no adapter "${adapterId}" is configured`);
    return a;
  }

  /** Route a namespaced id to its adapter and hand back the local portion. */
  resolve(namespacedId: string): { adapter: ProviderAdapter; localId: string } {
    let parts: { adapterId: string; localId: string };
    try {
      parts = splitNamespacedId(namespacedId);
    } catch {
      throw new AppError('BAD_REQUEST', `malformed id "${namespacedId}"`);
    }
    return { adapter: this.get(parts.adapterId), localId: parts.localId };
  }

  async list(): Promise<AdapterInfo[]> {
    return Promise.all(
      [...this.#adapters.values()].map(async (a) => ({
        id: a.id,
        label: a.label,
        kind: a.kind,
        healthy: await a.health().catch(() => false),
      })),
    );
  }

  /**
   * Run an operation across adapters, tolerating individual failures.
   * One dead source should degrade the feed, not blank it.
   */
  async #fanOut<T>(
    adapters: ProviderAdapter[],
    op: (a: ProviderAdapter) => Promise<T>,
  ): Promise<FanOut<T>> {
    const settled = await Promise.allSettled(adapters.map(op));
    const results: T[] = [];
    const degraded: DegradedAdapter[] = [];

    for (const [i, outcome] of settled.entries()) {
      const adapter = adapters[i]!;
      if (outcome.status === 'fulfilled') {
        results.push(outcome.value);
      } else {
        const reason =
          outcome.reason instanceof AppError
            ? outcome.reason.message
            : String(outcome.reason ?? 'unknown failure');
        degraded.push({ adapterId: adapter.id, reason });
      }
    }
    return { results, degraded };
  }

  #targets(adapterId: string | undefined): ProviderAdapter[] {
    return adapterId ? [this.get(adapterId)] : [...this.#adapters.values()];
  }

  /* ------------------------------------------------------------------ */
  /* Namespacing helpers                                                */
  /* ------------------------------------------------------------------ */

  #toSummary(adapter: ProviderAdapter, s: Awaited<ReturnType<ProviderAdapter['featured']>>[number]): ComicSummary {
    return {
      id: makeNamespacedId(adapter.id, s.id),
      title: s.title,
      coverUrl: s.cover ? this.imageUrl(adapter.id, s.id, 'thumb') : null,
      authors: s.authors,
      genres: s.genres,
      status: s.status,
      year: s.year,
      chapterCount: s.chapterCount,
    };
  }

  /**
   * Proxy URL for an image. The ref is the adapter-local id; `resolveImage`
   * turns it back into a source at request time, so no server-side session
   * state is needed between listing a page and fetching its bytes.
   */
  imageUrl(adapterId: string, ref: string, variant: ImageVariant): string {
    return `/api/image/${encodeURIComponent(adapterId)}/${encodeURIComponent(ref)}?v=${variant}`;
  }

  /* ------------------------------------------------------------------ */
  /* Catalog operations                                                 */
  /* ------------------------------------------------------------------ */

  async search(
    args: SearchArgs & { adapterId: string | undefined },
  ): Promise<{ items: ComicSummary[]; hasMore: boolean; degraded: DegradedAdapter[] }> {
    const targets = this.#targets(args.adapterId);
    const { results, degraded } = await this.#fanOut(targets, async (a) => ({
      adapter: a,
      page: await a.search(args),
    }));

    const items: ComicSummary[] = [];
    let hasMore = false;
    for (const r of results) {
      hasMore ||= r.page.hasMore;
      for (const s of r.page.items) items.push(this.#toSummary(r.adapter, s));
    }

    if (results.length === 0 && degraded.length > 0) {
      // Nothing succeeded: a partial response would be indistinguishable from
      // "no matches", which would be a lie.
      throw new AppError('UPSTREAM_UNAVAILABLE', `all sources failed: ${degraded[0]!.reason}`);
    }
    return { items, hasMore, degraded };
  }

  async homeFeed(): Promise<{
    hero: ComicSummary[];
    shelves: { id: string; title: string; items: ComicSummary[] }[];
    degraded: DegradedAdapter[];
  }> {
    const targets = [...this.#adapters.values()];
    const { results, degraded } = await this.#fanOut(targets, async (a) => {
      if (typeof a.featuredShelves === 'function') {
        const sections = await a.featuredShelves();
        return {
          adapter: a,
          shelves: sections
            .filter((s) => s.items.length > 0)
            .map((s) => ({
              id: s.id,
              title: s.title,
              items: s.items.map((item) => this.#toSummary(a, item)),
            })),
        };
      }
      const items = await a.featured();
      return {
        adapter: a,
        shelves:
          items.length > 0
            ? [
                {
                  id: a.id,
                  title: a.label,
                  items: items.map((item) => this.#toSummary(a, item)),
                },
              ]
            : [],
      };
    });

    const shelves = results.flatMap((r) => r.shelves);

    // Prefer the first shelf (popular) for hero, then fill from the rest.
    const hero: ComicSummary[] = [];
    const seen = new Set<string>();
    for (const shelf of shelves) {
      for (const item of shelf.items) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        hero.push(item);
        if (hero.length >= 8) break;
      }
      if (hero.length >= 8) break;
    }

    return { hero, shelves, degraded };
  }

  async getComic(namespacedId: string): Promise<ComicDetail> {
    const { adapter, localId } = this.resolve(namespacedId);
    const d = await adapter.getComic(localId);
    return {
      ...this.#toSummary(adapter, d),
      description: d.description,
      updatedAt: d.updatedAt,
    };
  }

  async getChapters(namespacedComicId: string): Promise<Chapter[]> {
    const { adapter, localId } = this.resolve(namespacedComicId);
    const chapters = await adapter.getChapters(localId);
    return chapters.map((c) => ({
      id: makeNamespacedId(adapter.id, c.id),
      comicId: makeNamespacedId(adapter.id, c.comicId),
      number: c.number,
      title: c.title,
      volume: c.volume,
      pageCount: c.pageCount,
      publishedAt: c.publishedAt,
      coverUrl: c.coverUrl ?? null,
    }));
  }

  async getPages(namespacedChapterId: string): Promise<PageRef[]> {
    const { adapter, localId } = this.resolve(namespacedChapterId);
    const pages = await adapter.getPages(localId);
    return pages.map((p) => ({
      id: makeNamespacedId(adapter.id, p.id),
      chapterId: makeNamespacedId(adapter.id, p.chapterId),
      index: p.index,
      url: this.imageUrl(adapter.id, p.id, 'screen'),
      width: p.width,
      height: p.height,
    }));
  }

  /**
   * First-page preview for a chapter card. Uses getPages so every adapter
   * works; only the first page is exposed as a thumb proxy URL.
   */
  async getChapterPreview(namespacedChapterId: string): Promise<{
    chapterId: string;
    pageCount: number;
    coverUrl: string | null;
  }> {
    const { adapter, localId } = this.resolve(namespacedChapterId);
    const pages = await adapter.getPages(localId);
    const first = pages[0];
    return {
      chapterId: namespacedChapterId,
      pageCount: pages.length,
      coverUrl: first ? this.imageUrl(adapter.id, first.id, 'thumb') : null,
    };
  }

  async resolveImage(adapterId: string, ref: string): Promise<ImageSource> {
    return this.get(adapterId).resolveImage(ref);
  }
}

/**
 * Build the registry from operator configuration.
 *
 * Enable the sources you want: local CBZ folder, OPDS catalogs, and/or the
 * com-x.life adapter (`COMX_ENABLED=true`). Nothing is on by default except
 * what you set in env.
 */
export function buildRegistry(
  cfg: Config,
  guardedFetch: GuardedFetch,
  comxGuard: GuardOptions = {
    allowedHosts: new Set<string>(),
    allowPrivate: false,
    allowAnyPublicHost: true,
  },
): { registry: AdapterRegistry; comx: ComxAdapter | null } {
  const adapters: ProviderAdapter[] = [];
  let comx: ComxAdapter | null = null;

  if (cfg.localLibraryDir) {
    adapters.push(new LocalAdapter(cfg.localLibraryDir, cfg.imageMaxSourceBytes));
  }

  const archiveDir = path.join(cfg.imageCacheDir, '..', 'archives');
  for (const catalog of cfg.opdsCatalogs) {
    adapters.push(
      new OpdsAdapter(catalog, {
        fetch: guardedFetch,
        archiveDir,
        maxEntryBytes: cfg.imageMaxSourceBytes,
      }),
    );
  }

  if (cfg.comxEnabled) {
    const credentials =
      cfg.comxLogin && cfg.comxPassword
        ? { login: cfg.comxLogin, password: cfg.comxPassword }
        : undefined;
    const session = new ComxSession(comxGuard, {
      ...(credentials ? { credentials } : {}),
      maxBytes: cfg.imageMaxSourceBytes,
      // Same cookie jar serves catalog HTML and later CBZ bulk downloads.
      downloadMaxBytes: cfg.archiveMaxBytes,
    });
    comx = new ComxAdapter({
      session,
      ...(credentials ? { credentials } : {}),
    });
    adapters.push(comx);
  }

  return { registry: new AdapterRegistry(adapters, cfg.proxyExtraHosts), comx };
}
