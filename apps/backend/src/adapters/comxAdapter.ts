import * as cheerio from 'cheerio';
import { AppError } from '@comic/shared';
import type { GuardedFetch } from './opds.js';
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
 * Operator-configured adapter for com-x.life.
 *
 * Parsing logic follows the site’s HTML structure (catalog cards, story info,
 * chapter lists, reader image containers / inline JS page arrays). Outbound
 * HTTP always goes through the injected guarded fetch so private ranges stay
 * blocked even though the site’s CDNs are not on a fixed allowlist.
 */

export interface ComicListItem {
  id: string;
  title: string;
  url: string;
  coverUrl: string;
  year?: string;
  rating?: string;
  latestChapter?: string;
}

export interface CatalogResponse {
  items: ComicListItem[];
  currentPage: number;
  totalPages: number;
  hasNextPage: boolean;
}

export interface ChapterItem {
  id: string;
  title: string;
  url: string;
  dateAdded?: string;
  chapterNumber?: number;
}

export interface ComicDetails {
  id: string;
  url: string;
  title: string;
  originalTitle?: string;
  coverUrl: string;
  description: string;
  publisher?: string;
  author?: string;
  artist?: string;
  year?: string;
  status?: string;
  genres: string[];
  rating?: string;
  chapters: ChapterItem[];
}

export interface ChapterPagesResponse {
  chapterId: string;
  title?: string;
  pages: string[];
  totalPages: number;
}

const encodeId = (s: string): string => Buffer.from(s, 'utf8').toString('base64url');
const decodeId = (s: string): string => Buffer.from(s, 'base64url').toString('utf8');

const BROWSER_HEADERS: Record<string, string> = {
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'accept-language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
  referer: 'https://com-x.life/',
};

function mapStatus(raw: string | undefined): LocalComicSummary['status'] {
  if (!raw) return 'unknown';
  const lower = raw.toLowerCase();
  if (lower.includes('заверш') || lower.includes('complet')) return 'completed';
  if (lower.includes('выход') || lower.includes('онгоин') || lower.includes('ongoing')) return 'ongoing';
  if (lower.includes('пауз') || lower.includes('hiatus')) return 'hiatus';
  return 'unknown';
}

export class ComxAdapter implements ProviderAdapter {
  readonly id = 'comx';
  readonly label = 'com-x.life';
  readonly kind = 'comx' as const;

  readonly #baseUrl = 'https://com-x.life';
  readonly #fetch: GuardedFetch;
  /** Short-lived detail cache so chapter/page routes do not re-scrape every time. */
  readonly #detailCache = new Map<string, { value: ComicDetails; expiresAt: number }>();
  static readonly #DETAIL_TTL_MS = 5 * 60_000;

  constructor(fetchHtml: GuardedFetch) {
    this.#fetch = fetchHtml;
  }

  proxyHosts(): readonly string[] {
    // Page images often live on third-party CDNs; the image route loosens the
    // allowlist for this adapter. Boot-time hosts cover HTML + same-origin assets.
    return ['com-x.life', '*.com-x.life'];
  }

  async health(): Promise<boolean> {
    try {
      await this.#fetchHtml(this.#baseUrl);
      return true;
    } catch {
      return false;
    }
  }

  async #fetchHtml(targetUrl: string): Promise<string> {
    try {
      const { body, contentType } = await this.#fetch(targetUrl, BROWSER_HEADERS);
      if (contentType && !contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
        // Some endpoints still return usable HTML with odd content-types.
      }
      return body.toString('utf8');
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError('UPSTREAM_UNAVAILABLE', `com-x fetch failed: ${String(err)}`);
    }
  }

  fixUrl(path?: string): string {
    if (!path) return '';
    if (path.startsWith('http://') || path.startsWith('https://')) return path;
    if (path.startsWith('//')) return `https:${path}`;
    return `${this.#baseUrl}${path.startsWith('/') ? '' : '/'}${path}`;
  }

  extractIdFromUrl(url: string): string {
    const cleanUrl = url.split('?')[0]!.replace(/\/$/, '');
    const parts = cleanUrl.split('/');
    return parts[parts.length - 1] || encodeURIComponent(url);
  }

  async searchCatalog(query: string, page = 1): Promise<CatalogResponse> {
    const searchUrl = `${this.#baseUrl}/index.php?do=search&subaction=search&story=${encodeURIComponent(query)}&search_start=${page}`;
    const html = await this.#fetchHtml(searchUrl);
    return this.parseCatalogPage(html, page);
  }

  async getCatalog(page = 1, categoryUrl?: string): Promise<CatalogResponse> {
    const candidates = categoryUrl
      ? [
          categoryUrl.includes('/page/')
            ? categoryUrl
            : `${categoryUrl.replace(/\/$/, '')}/page/${page}/`,
          categoryUrl,
        ]
      : [
          `${this.#baseUrl}/comix/page/${page}/`,
          `${this.#baseUrl}/comix/`,
          `${this.#baseUrl}/`,
        ];

    let lastError: unknown;
    for (const targetUrl of candidates) {
      try {
        const html = await this.#fetchHtml(targetUrl);
        const parsed = this.parseCatalogPage(html, page);
        if (parsed.items.length > 0 || targetUrl === candidates[candidates.length - 1]) {
          return parsed;
        }
      } catch (err) {
        lastError = err;
      }
    }
    if (lastError instanceof AppError) throw lastError;
    throw new AppError(
      'UPSTREAM_UNAVAILABLE',
      `com-x catalog unavailable: ${String(lastError ?? 'unknown')}`,
    );
  }

  parseCatalogPage(html: string, page: number): CatalogResponse {
    const $ = cheerio.load(html);
    const items: ComicListItem[] = [];

    $('.short-story, .story-item, article.story').each((_, el) => {
      const $el = $(el);
      const $link = $el.find('.story-title a, h2.title a, .title a').first();
      const title = $link.text().trim();
      const href = $link.attr('href') || '';

      const $img = $el.find('.story-img img, .poster img, img').first();
      const coverSrc = $img.attr('data-src') || $img.attr('src') || '';

      const rating = $el.find('.rating-val, .rate-num').text().trim();
      const year = $el.find('.story-info .year, .year').text().trim();
      const latestChapter = $el.find('.latest-chapter, .new-chap').text().trim();

      if (title && href) {
        items.push({
          id: this.extractIdFromUrl(href),
          title,
          url: this.fixUrl(href),
          coverUrl: this.fixUrl(coverSrc),
          ...(year ? { year } : {}),
          ...(rating ? { rating } : {}),
          ...(latestChapter ? { latestChapter } : {}),
        });
      }
    });

    let totalPages = page;
    const $pagination = $('.navigation, .pagination, .page-nav');
    if ($pagination.length > 0) {
      $pagination.find('a, span').each((_, el) => {
        const num = Number.parseInt($(el).text().trim(), 10);
        if (!Number.isNaN(num) && num > totalPages) totalPages = num;
      });
    }

    return {
      items,
      currentPage: page,
      totalPages,
      hasNextPage: page < totalPages,
    };
  }

  async getComicDetails(comicUrlOrPath: string): Promise<ComicDetails> {
    const fullUrl = this.fixUrl(comicUrlOrPath);
    const cached = this.#detailCache.get(fullUrl);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const html = await this.#fetchHtml(fullUrl);
    const $ = cheerio.load(html);

    const title =
      $('.full-story-title, h1.title, .story-full-title').first().text().trim() ||
      $('h1').first().text().trim();
    const originalTitle = $('.orig-title, .sub-title').text().trim() || undefined;

    const $coverImg = $('.full-story-img img, .poster-full img, .story-posters img').first();
    const coverSrc = $coverImg.attr('data-src') || $coverImg.attr('src') || '';

    const description = $('.story-description, .full-text, #full-story-text').text().trim();
    const rating =
      $('.rating-value, .rate-count, .current-rating').text().trim() || undefined;

    let publisher: string | undefined;
    let author: string | undefined;
    let artist: string | undefined;
    let year: string | undefined;
    let status: string | undefined;
    const genres: string[] = [];

    $('.story-info-list li, .full-info p, .info-list div').each((_, el) => {
      const text = $(el).text().trim();
      if (text.includes('Издатель') || text.includes('Издательство')) {
        publisher = $(el).find('a').text().trim() || text.split(':')[1]?.trim();
      } else if (text.includes('Автор')) {
        author = $(el).find('a').text().trim() || text.split(':')[1]?.trim();
      } else if (text.includes('Художник')) {
        artist = $(el).find('a').text().trim() || text.split(':')[1]?.trim();
      } else if (text.includes('Год')) {
        year = text.replace(/[^0-9]/g, '');
      } else if (text.includes('Статус')) {
        status = text.split(':')[1]?.trim();
      } else if (text.includes('Жанр')) {
        $(el)
          .find('a')
          .each((__, g) => {
            const genreName = $(g).text().trim();
            if (genreName) genres.push(genreName);
          });
      }
    });

    const chapters: ChapterItem[] = [];
    $('.chapters-list a, .read-list a, .files-list a, .read-online-list a').each((index, el) => {
      const $chLink = $(el);
      const chHref = $chLink.attr('href') || '';
      const chTitle = $chLink.text().trim() || `Глава ${index + 1}`;
      const chDate = $chLink.find('.date, .time').text().trim() || undefined;

      if (chHref) {
        chapters.push({
          id: this.extractIdFromUrl(chHref),
          title: chTitle,
          url: this.fixUrl(chHref),
          ...(chDate ? { dateAdded: chDate } : {}),
          chapterNumber: chapters.length + 1,
        });
      }
    });

    if (!title) {
      throw new AppError('UPSTREAM_MALFORMED', 'com-x page did not contain a comic title');
    }

    const details: ComicDetails = {
      id: this.extractIdFromUrl(fullUrl),
      url: fullUrl,
      title,
      ...(originalTitle ? { originalTitle } : {}),
      coverUrl: this.fixUrl(coverSrc),
      description,
      ...(publisher ? { publisher } : {}),
      ...(author ? { author } : {}),
      ...(artist ? { artist } : {}),
      ...(year ? { year } : {}),
      ...(status ? { status } : {}),
      genres,
      ...(rating ? { rating } : {}),
      chapters,
    };

    this.#detailCache.set(fullUrl, {
      value: details,
      expiresAt: Date.now() + ComxAdapter.#DETAIL_TTL_MS,
    });
    return details;
  }

  async getChapterPages(chapterUrlOrPath: string): Promise<ChapterPagesResponse> {
    const fullUrl = this.fixUrl(chapterUrlOrPath);
    const html = await this.#fetchHtml(fullUrl);
    const $ = cheerio.load(html);

    const pages: string[] = [];

    $('.reader-images img, .read-comic img, #comic-pages img, .page-image').each((_, el) => {
      const src = $(el).attr('data-src') || $(el).attr('src') || $(el).attr('data-original');
      if (src) pages.push(this.fixUrl(src));
    });

    if (pages.length === 0) {
      const scripts = $('script')
        .map((_, el) => $(el).html())
        .get();
      for (const scriptContent of scripts) {
        if (!scriptContent) continue;
        const arrayMatch =
          scriptContent.match(/pages\s*=\s*(\[[^\]]+\])/i) ||
          scriptContent.match(/images\s*=\s*(\[[^\]]+\])/i);
        if (!arrayMatch?.[1]) continue;
        try {
          const parsedArray = JSON.parse(arrayMatch[1].replace(/'/g, '"')) as unknown;
          if (Array.isArray(parsedArray)) {
            for (const imgUrl of parsedArray) {
              if (typeof imgUrl === 'string') pages.push(this.fixUrl(imgUrl));
            }
          }
        } catch {
          // Ignore non-JSON JS literals.
        }
      }
    }

    if (pages.length === 0) {
      throw new AppError('UPSTREAM_MALFORMED', 'no page images found on that com-x chapter');
    }

    const title = $('.chapter-title, .reader-header h1').text().trim() || undefined;

    return {
      chapterId: this.extractIdFromUrl(fullUrl),
      ...(title ? { title } : {}),
      pages,
      totalPages: pages.length,
    };
  }

  /* ------------------------------------------------------------------ */
  /* ProviderAdapter surface                                            */
  /* ------------------------------------------------------------------ */

  #toSummary(item: ComicListItem): LocalComicSummary {
    const yearNum = item.year ? Number.parseInt(item.year, 10) : NaN;
    return {
      id: encodeId(item.url),
      title: item.title,
      cover: item.coverUrl
        ? { kind: 'http', url: item.coverUrl, headers: BROWSER_HEADERS }
        : null,
      authors: [],
      genres: [],
      status: 'unknown',
      year: Number.isFinite(yearNum) && yearNum >= 1800 ? yearNum : null,
      chapterCount: null,
    };
  }

  async search(args: SearchArgs): Promise<{ items: LocalComicSummary[]; hasMore: boolean }> {
    const page = Math.max(1, args.page + 1); // wire uses 0-based pages
    const result = args.q.trim()
      ? await this.searchCatalog(args.q.trim(), page)
      : await this.getCatalog(page);
    return {
      items: result.items.map((i) => this.#toSummary(i)),
      hasMore: result.hasNextPage,
    };
  }

  async featured(): Promise<LocalComicSummary[]> {
    const result = await this.getCatalog(1);
    return result.items.slice(0, 20).map((i) => this.#toSummary(i));
  }

  async getComic(id: string): Promise<LocalComicDetail> {
    const url = decodeId(id);
    const details = await this.getComicDetails(url);
    const yearNum = details.year ? Number.parseInt(details.year, 10) : NaN;
    const authors = [details.author, details.artist].filter((v): v is string => Boolean(v));

    return {
      id,
      title: details.title,
      cover: details.coverUrl
        ? { kind: 'http', url: details.coverUrl, headers: BROWSER_HEADERS }
        : null,
      authors,
      genres: details.genres,
      status: mapStatus(details.status),
      year: Number.isFinite(yearNum) && yearNum >= 1800 ? yearNum : null,
      chapterCount: details.chapters.length,
      description: details.description,
      updatedAt: null,
    };
  }

  async getChapters(comicId: string): Promise<LocalChapter[]> {
    const url = decodeId(comicId);
    const details = await this.getComicDetails(url);
    return details.chapters.map((ch, index) => ({
      id: encodeId(ch.url),
      comicId,
      number: ch.chapterNumber ?? index + 1,
      title: ch.title,
      volume: null,
      pageCount: 0, // unknown until the chapter is opened
      publishedAt: null,
    }));
  }

  async getPages(chapterId: string): Promise<LocalPageRef[]> {
    const url = decodeId(chapterId);
    const result = await this.getChapterPages(url);
    return result.pages.map((pageUrl, index) => ({
      id: encodeId(`${url}\u0000${index}\u0000${pageUrl}`),
      chapterId,
      index,
      width: null,
      height: null,
      source: { kind: 'http' as const, url: pageUrl, headers: BROWSER_HEADERS },
    }));
  }

  async resolveImage(ref: string): Promise<ImageSource> {
    const decoded = decodeId(ref);
    const parts = decoded.split('\u0000');
    if (parts.length >= 3) {
      const url = parts.slice(2).join('\u0000');
      return { kind: 'http', url, headers: BROWSER_HEADERS };
    }
    // Cover: comic id encodes the comic URL; re-fetch details for cover, or
    // treat the decoded string itself as an image URL when it looks like one.
    if (/^https?:\/\//i.test(decoded) && /\.(jpe?g|png|webp|gif|avif)(\?|$)/i.test(decoded)) {
      return { kind: 'http', url: decoded, headers: BROWSER_HEADERS };
    }
    const details = await this.getComicDetails(decoded);
    if (!details.coverUrl) throw new AppError('NOT_FOUND', 'comic has no cover image');
    return { kind: 'http', url: details.coverUrl, headers: BROWSER_HEADERS };
  }
}
