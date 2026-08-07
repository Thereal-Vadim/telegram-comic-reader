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
import type { ImageSource, ProviderAdapter, SearchArgs } from './types.js';

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
    const { results, degraded } = await this.#fanOut(targets, async (a) => ({
      adapter: a,
      items: await a.featured(),
    }));

    const shelves = results
      .filter((r) => r.items.length > 0)
      .map((r) => ({
        id: r.adapter.id,
        title: r.adapter.label,
        items: r.items.map((s) => this.#toSummary(r.adapter, s)),
      }));

    // The hero row is the head of each shelf, interleaved so one large source
    // does not crowd out the others.
    const hero: ComicSummary[] = [];
    for (let i = 0; i < 5; i++) {
      for (const shelf of shelves) {
        const item = shelf.items[i];
        if (item && hero.length < 8) hero.push(item);
      }
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

  async resolveImage(adapterId: string, ref: string): Promise<ImageSource> {
    return this.get(adapterId).resolveImage(ref);
  }
}

/** Build the registry from configuration. Returns an empty registry if nothing is configured. */
export function buildRegistry(cfg: Config, guardedFetch: GuardedFetch): AdapterRegistry {
  const adapters: ProviderAdapter[] = [];

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

  return new AdapterRegistry(adapters, cfg.proxyExtraHosts);
}
