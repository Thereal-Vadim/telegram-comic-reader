import { z } from 'zod';

/**
 * The wire contract between the Mini App and the backend.
 *
 * Both sides import these schemas: the backend validates its responses against
 * them before serializing, the frontend parses every response through them.
 * A field that changes shape therefore fails typecheck on both sides at once
 * rather than becoming a runtime `undefined` in the reader.
 */

/* -------------------------------------------------------------------------- */
/* Identifiers                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Ids are namespaced by the adapter that produced them (`local:foo`, `opds:bar`)
 * so the registry can route a bare id back to its source without a lookup table,
 * and so two adapters exposing the same underlying series never collide.
 */
export const NamespacedId = z
  .string()
  .min(3)
  .max(512)
  .regex(/^[a-z0-9_-]+:.+$/, 'expected "<adapterId>:<localId>"');
export type NamespacedId = z.infer<typeof NamespacedId>;

export const AdapterId = z.string().regex(/^[a-z0-9_-]+$/);
export type AdapterId = z.infer<typeof AdapterId>;

/** Split `adapter:rest` without losing colons inside the local portion. */
export function splitNamespacedId(id: string): { adapterId: string; localId: string } {
  const sep = id.indexOf(':');
  if (sep <= 0 || sep === id.length - 1) {
    throw new Error(`malformed namespaced id: ${id}`);
  }
  return { adapterId: id.slice(0, sep), localId: id.slice(sep + 1) };
}

export function makeNamespacedId(adapterId: string, localId: string): string {
  return `${adapterId}:${localId}`;
}

/* -------------------------------------------------------------------------- */
/* Images                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Three fixed rungs rather than arbitrary widths. A closed set means the disk
 * cache has a bounded number of entries per page and cannot be used to make the
 * backend transcode an unbounded number of variants.
 */
export const ImageVariant = z.enum(['thumb', 'screen', 'zoom']);
export type ImageVariant = z.infer<typeof ImageVariant>;

export const VARIANT_WIDTH: Record<ImageVariant, number> = {
  thumb: 300,
  screen: 1080,
  zoom: 2160,
};

/* -------------------------------------------------------------------------- */
/* Catalog                                                                    */
/* -------------------------------------------------------------------------- */

export const ComicSummary = z.object({
  id: NamespacedId,
  title: z.string(),
  /** Proxy URL for the cover, already namespaced and variant-parameterized. */
  coverUrl: z.string().nullable(),
  authors: z.array(z.string()).default([]),
  genres: z.array(z.string()).default([]),
  /** Publication state where the source reports it. */
  status: z.enum(['ongoing', 'completed', 'hiatus', 'unknown']).default('unknown'),
  year: z.number().int().min(1800).max(2200).nullable().default(null),
  chapterCount: z.number().int().nonnegative().nullable().default(null),
});
export type ComicSummary = z.infer<typeof ComicSummary>;

export const ComicDetail = ComicSummary.extend({
  description: z.string().default(''),
  /** Source-reported update time, ISO 8601. Used to invalidate cached chapter lists. */
  updatedAt: z.iso.datetime().nullable().default(null),
});
export type ComicDetail = z.infer<typeof ComicDetail>;

export const Chapter = z.object({
  id: NamespacedId,
  comicId: NamespacedId,
  /**
   * Sort key. Sources number chapters inconsistently (decimals for side
   * stories, gaps for skipped releases), so this is a float and is only ever
   * used for ordering, never for arithmetic.
   */
  number: z.number(),
  title: z.string(),
  volume: z.number().int().nullable().default(null),
  pageCount: z.number().int().nonnegative(),
  publishedAt: z.iso.datetime().nullable().default(null),
  /**
   * First-page / issue cover proxy URL when the source (or a later preview
   * fetch) has one. Null on list responses that have not resolved a preview yet.
   */
  coverUrl: z.string().nullable().default(null),
});
export type Chapter = z.infer<typeof Chapter>;

export const ChapterPreviewResponse = z.object({
  chapterId: NamespacedId,
  title: z.string().optional(),
  pageCount: z.number().int().nonnegative(),
  /** Proxy URL for the first page (issue cover), thumb-ready. */
  coverUrl: z.string().nullable(),
});
export type ChapterPreviewResponse = z.infer<typeof ChapterPreviewResponse>;

export const PageRef = z.object({
  id: NamespacedId,
  chapterId: NamespacedId,
  index: z.number().int().nonnegative(),
  /** Backend proxy URL, variant chosen by the client via query string. */
  url: z.string(),
  /**
   * Intrinsic dimensions when the adapter knows them without decoding. The
   * reader uses these to size the page mesh before the texture arrives, which
   * avoids a visible reflow on the first frame of a turn.
   */
  width: z.number().int().positive().nullable().default(null),
  height: z.number().int().positive().nullable().default(null),
});
export type PageRef = z.infer<typeof PageRef>;

/* -------------------------------------------------------------------------- */
/* Requests and responses                                                     */
/* -------------------------------------------------------------------------- */

export const SearchQuery = z.object({
  q: z.string().trim().max(200).default(''),
  page: z.coerce.number().int().min(0).max(1000).default(0),
  /** Restrict to one adapter; omitted means fan out across all of them. */
  adapter: AdapterId.optional(),
  genre: z.string().max(100).optional(),
});
export type SearchQuery = z.infer<typeof SearchQuery>;

export const SearchResponse = z.object({
  items: z.array(ComicSummary),
  page: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  /**
   * Adapters that failed while the others succeeded. Partial results beat a
   * blanket 502 when one of several configured sources is down.
   */
  degraded: z.array(z.object({ adapterId: AdapterId, reason: z.string() })).default([]),
});
export type SearchResponse = z.infer<typeof SearchResponse>;

export const HomeFeedResponse = z.object({
  hero: z.array(ComicSummary),
  shelves: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      items: z.array(ComicSummary),
    }),
  ),
  degraded: z.array(z.object({ adapterId: AdapterId, reason: z.string() })).default([]),
});
export type HomeFeedResponse = z.infer<typeof HomeFeedResponse>;

export const ChapterListResponse = z.object({
  comic: ComicDetail,
  chapters: z.array(Chapter),
});
export type ChapterListResponse = z.infer<typeof ChapterListResponse>;

/**
 * Pages carry only their chapter id, not the whole Chapter. The client reaches
 * this endpoint from the detail page and already holds the chapter metadata, so
 * echoing it back would force the backend to re-derive a comic id it cannot
 * recover from a chapter id alone.
 */
export const PageListResponse = z.object({
  chapterId: NamespacedId,
  pages: z.array(PageRef),
});
export type PageListResponse = z.infer<typeof PageListResponse>;

export const AdapterInfo = z.object({
  id: AdapterId,
  label: z.string(),
  kind: z.enum(['local', 'opds', 'comx']),
  /** False when the adapter is configured but its source is unreachable. */
  healthy: z.boolean(),
});
export type AdapterInfo = z.infer<typeof AdapterInfo>;

export const AdapterListResponse = z.object({ adapters: z.array(AdapterInfo) });
export type AdapterListResponse = z.infer<typeof AdapterListResponse>;

/* -------------------------------------------------------------------------- */
/* com-x.life session                                                         */
/* -------------------------------------------------------------------------- */

export const ComxSessionStatus = z.object({
  connected: z.boolean(),
  login: z.string().nullable(),
  cookieCount: z.number().int().nonnegative(),
});
export type ComxSessionStatus = z.infer<typeof ComxSessionStatus>;

export const ComxConnectRequest = z.object({
  login: z.string().trim().min(1).max(128),
  password: z.string().min(1).max(256),
});
export type ComxConnectRequest = z.infer<typeof ComxConnectRequest>;

/* -------------------------------------------------------------------------- */
/* Auth                                                                       */
/* -------------------------------------------------------------------------- */

export const AuthRequest = z.object({
  /** Raw `window.Telegram.WebApp.initData` query string, verified server-side. */
  initData: z.string().min(1).max(8192),
});
export type AuthRequest = z.infer<typeof AuthRequest>;

export const TelegramUser = z.object({
  id: z.number().int(),
  firstName: z.string(),
  lastName: z.string().optional(),
  username: z.string().optional(),
  languageCode: z.string().optional(),
  photoUrl: z.string().optional(),
  isPremium: z.boolean().optional(),
});
export type TelegramUser = z.infer<typeof TelegramUser>;

export const AuthResponse = z.object({
  token: z.string(),
  expiresAt: z.number().int(),
  user: TelegramUser,
});
export type AuthResponse = z.infer<typeof AuthResponse>;
