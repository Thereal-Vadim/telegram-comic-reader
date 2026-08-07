import * as cheerio from 'cheerio';
import { AppError } from '@comic/shared';

/**
 * Generative page extractor for a comic chapter hosted as a plain HTML page.
 *
 * Strategy (kept deliberately conservative):
 *  1. Collect candidate image URLs from <img>, srcset, and common lazy-load attrs.
 *  2. Drop known ad / tracker / icon hosts and tiny decorative assets by URL shape.
 *  3. Prefer images that share a common path prefix (chapter folders usually do),
 *     so a single hero/cover elsewhere on the page does not pollute the strip.
 *  4. Preserve document order — that is the reading order for nearly every
 *     open webcomic layout.
 */

const SKIP_HOST_FRAGMENTS = [
  'doubleclick',
  'googlesyndication',
  'google-analytics',
  'facebook.com',
  'twitter.com',
  'adservice',
  'adnxs',
  'scorecardresearch',
  'amazon-adsystem',
  'gravatar.com',
];

const SKIP_PATH_FRAGMENTS = [
  '/avatar',
  '/emoji',
  '/icon',
  '/logo',
  '/sprite',
  '/badge',
  '/button',
  '/pixel',
  '1x1',
  'spacer',
  'advert',
  '/ads/',
  'banner',
];

const IMAGE_EXT = /\.(jpe?g|png|webp|gif|avif)(?:$|[?#])/i;

function absolutize(base: URL, raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith('data:') || trimmed.startsWith('blob:')) return null;
  try {
    return new URL(trimmed, base).toString();
  } catch {
    return null;
  }
}

function firstFromSrcset(srcset: string): string | null {
  // "a.jpg 1x, b.jpg 2x" → pick the last (usually highest density) candidate.
  const parts = srcset
    .split(',')
    .map((p) => p.trim().split(/\s+/)[0])
    .filter((p): p is string => Boolean(p));
  return parts.at(-1) ?? null;
}

function shouldSkip(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  if (SKIP_HOST_FRAGMENTS.some((f) => host.includes(f))) return true;
  const path = `${url.pathname}${url.search}`.toLowerCase();
  if (SKIP_PATH_FRAGMENTS.some((f) => path.includes(f))) return true;
  // Favicon-sized naming conventions.
  if (/favicon|apple-touch-icon/i.test(path)) return true;
  return false;
}

function pathDepthKey(url: URL): string {
  const parts = url.pathname.split('/').filter(Boolean);
  // Group by directory, not filename — pages of one chapter share a folder.
  return `${url.hostname}/${parts.slice(0, -1).join('/')}`;
}

export interface ExtractedWebPages {
  readonly title: string;
  readonly imageUrls: string[];
}

export function extractComicImages(html: string, pageUrl: string): ExtractedWebPages {
  let base: URL;
  try {
    base = new URL(pageUrl);
  } catch {
    throw new AppError('BAD_REQUEST', 'web page url is not parseable');
  }

  const $ = cheerio.load(html);
  const title =
    $('meta[property="og:title"]').attr('content')?.trim() ||
    $('title').first().text().trim() ||
    base.hostname;

  const ordered: string[] = [];
  const seen = new Set<string>();

  const push = (raw: string | undefined): void => {
    if (!raw) return;
    const abs = absolutize(base, raw);
    if (!abs || seen.has(abs)) return;
    let parsed: URL;
    try {
      parsed = new URL(abs);
    } catch {
      return;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return;
    if (shouldSkip(parsed)) return;
    // Prefer URLs that look like images; still allow extension-less CDN paths
    // (many readers serve `/page/12` without a suffix).
    const looksLikeImage = IMAGE_EXT.test(parsed.pathname) || !/\.[a-z0-9]{2,5}$/i.test(parsed.pathname);
    if (!looksLikeImage) return;
    seen.add(abs);
    ordered.push(abs);
  };

  $('img').each((_, el) => {
    const node = $(el);
    push(node.attr('src'));
    push(node.attr('data-src'));
    push(node.attr('data-original'));
    push(node.attr('data-lazy-src'));
    push(node.attr('data-url'));
    const srcset = node.attr('srcset') || node.attr('data-srcset');
    if (srcset) push(firstFromSrcset(srcset) ?? undefined);
  });

  // Some readers put pages in <a href="page.jpg"> thumbnails.
  $('a').each((_, el) => {
    const href = $(el).attr('href');
    if (href && IMAGE_EXT.test(href)) push(href);
  });

  if (ordered.length === 0) {
    throw new AppError(
      'UPSTREAM_MALFORMED',
      'no comic page images were found on that page — try a direct link to a CBZ/ZIP file instead',
    );
  }

  // Prefer the largest cluster of images that share a directory. A lone cover
  // in /assets and 24 pages in /chapter/3/… should keep the chapter cluster.
  const groups = new Map<string, string[]>();
  for (const u of ordered) {
    const key = pathDepthKey(new URL(u));
    const list = groups.get(key) ?? [];
    list.push(u);
    groups.set(key, list);
  }

  let best = ordered;
  let bestSize = 0;
  for (const list of groups.values()) {
    if (list.length > bestSize) {
      best = list;
      bestSize = list.length;
    }
  }

  // A single image is rarely a readable chapter; require at least two pages
  // unless the page only exposed one candidate at all.
  if (best.length < 2 && ordered.length >= 2) {
    best = ordered;
  }

  if (best.length > 400) {
    throw new AppError(
      'UPSTREAM_MALFORMED',
      'page lists too many images to import safely (limit is 400)',
    );
  }

  return { title: title.slice(0, 200) || base.hostname, imageUrls: best };
}
