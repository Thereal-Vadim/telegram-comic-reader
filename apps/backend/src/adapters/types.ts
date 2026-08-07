import type { Chapter, ComicDetail, ComicSummary, PageRef } from '@comic/shared';

/**
 * The single seam between the app and wherever comics actually live.
 *
 * Adapters return ids that are *local* to themselves; the registry namespaces
 * them on the way out and strips the namespace on the way in, so an adapter
 * never has to know its own id or think about collisions with other adapters.
 */

/** How the registry should fetch the bytes for a page or cover. */
export type ImageSource =
  | {
      /** Read from disk. Path is validated against the adapter's root. */
      readonly kind: 'file';
      readonly path: string;
    }
  | {
      /** Read an entry out of a zip container without extracting the whole archive. */
      readonly kind: 'zip-entry';
      readonly archivePath: string;
      readonly entryName: string;
    }
  | {
      /** Fetch over HTTP, subject to the proxy allowlist and SSRF checks. */
      readonly kind: 'http';
      readonly url: string;
      readonly headers?: Record<string, string>;
    };

/** Adapter-local shapes: same fields as the wire types minus the namespacing. */
export type LocalComicSummary = Omit<ComicSummary, 'id' | 'coverUrl'> & {
  id: string;
  /** Resolved by the registry into a proxy URL. */
  cover: ImageSource | null;
};

export type LocalComicDetail = Omit<ComicDetail, 'id' | 'coverUrl'> & {
  id: string;
  cover: ImageSource | null;
};

export type LocalChapter = Omit<Chapter, 'id' | 'comicId'> & {
  id: string;
  comicId: string;
};

export type LocalPageRef = Omit<PageRef, 'id' | 'chapterId' | 'url'> & {
  id: string;
  chapterId: string;
  source: ImageSource;
};

export interface SearchArgs {
  readonly q: string;
  readonly page: number;
  readonly genre: string | undefined;
}

export interface ProviderAdapter {
  readonly id: string;
  readonly label: string;
  readonly kind: 'local' | 'opds';

  /**
   * Hostnames this adapter needs the image proxy to reach. Contributed to the
   * global allowlist at boot; an adapter cannot widen it later at request time.
   */
  proxyHosts(): readonly string[];

  /** Cheap reachability probe for the adapter list endpoint. */
  health(): Promise<boolean>;

  search(args: SearchArgs): Promise<{ items: LocalComicSummary[]; hasMore: boolean }>;
  /** Editorial or recently-updated rows for the home feed. */
  featured(): Promise<LocalComicSummary[]>;
  getComic(id: string): Promise<LocalComicDetail>;
  getChapters(comicId: string): Promise<LocalChapter[]>;
  getPages(chapterId: string): Promise<LocalPageRef[]>;
  /** Resolve an opaque image ref (from a proxy URL) back to a fetchable source. */
  resolveImage(ref: string): Promise<ImageSource>;
}
