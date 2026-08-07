import * as cheerio from 'cheerio';
import { AppError } from '@comic/shared';
import type { GuardedFetch } from './opds.js';
import {
  COMX_BASE_URL,
  COMX_BROWSER_HEADERS,
  ComxSession,
  type ComxCredentials,
  type ComxSessionStatus,
} from './comxSession.js';
import type { GuardOptions } from '../net/ssrf.js';
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
 * Catalog URLs follow current DLE layout (`/comix-read/`, never `/page/1/`).
 * Outbound HTTP goes through {@link ComxSession} (SSRF-pinned, cookie jar,
 * anti-bot PoW, optional DLE login).
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
  volume?: number;
  pageCount?: number;
}

/** Turn bare "# 163" style labels into readable issue titles. */
export function formatComxChapterTitle(ch: {
  title?: string;
  number?: number;
  volume?: number;
  posi?: number;
}): string {
  const raw = (ch.title || '').replace(/\s+/g, ' ').trim();
  const issueNo = ch.number && ch.number > 0 ? ch.number : undefined;
  const vol = ch.volume && ch.volume > 0 ? ch.volume : undefined;

  const hashOnly = raw.match(/^#\s*(\d+)\s*$/);
  if (hashOnly) {
    const n = hashOnly[1];
    return vol ? `Том ${vol} · Выпуск № ${n}` : `Выпуск № ${n}`;
  }

  if (raw) {
    // "# 51 Annual" → "Выпуск № 51 Annual"; leave narrative titles alone.
    const wasHashIssue = /^#\s*\d+/.test(raw);
    const normalized = raw.replace(/^#\s*(\d+)\b/, 'Выпуск № $1');
    if (vol && wasHashIssue && !/том\s*\d+/i.test(normalized)) {
      return `Том ${vol} · ${normalized}`;
    }
    return normalized;
  }

  if (issueNo !== undefined) {
    return vol ? `Том ${vol} · Выпуск № ${issueNo}` : `Выпуск № ${issueNo}`;
  }
  if (ch.posi !== undefined) return `Выпуск ${ch.posi}`;
  return 'Выпуск';
}

function parseComxDate(raw: string | undefined): string | null {
  if (!raw) return null;
  // "5.06.2026" or "05.06.2026"
  const m = raw.trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (!m) return null;
  const day = Number(m[1]);
  const month = Number(m[2]);
  const year = Number(m[3]);
  if (!day || !month || !year) return null;
  const iso = new Date(Date.UTC(year, month - 1, day)).toISOString();
  return iso;
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

function mapStatus(raw: string | undefined): LocalComicSummary['status'] {
  if (!raw) return 'unknown';
  const lower = raw.toLowerCase();
  if (lower.includes('заверш') || lower.includes('complet')) return 'completed';
  if (lower.includes('выход') || lower.includes('онгоин') || lower.includes('ongoing')) {
    return 'ongoing';
  }
  if (lower.includes('пауз') || lower.includes('hiatus')) return 'hiatus';
  return 'unknown';
}

export interface ComxAdapterOptions {
  /** Preferred: full session with guard + cookies + PoW. */
  session?: ComxSession;
  /** Legacy/test injection: plain guarded GET fetch. */
  fetch?: GuardedFetch;
  credentials?: ComxCredentials;
  guard?: GuardOptions;
  maxBytes?: number;
}

export class ComxAdapter implements ProviderAdapter {
  readonly id = 'comx';
  readonly label = 'com-x.life';
  readonly kind = 'comx' as const;

  readonly #baseUrl = COMX_BASE_URL;
  readonly #session: ComxSession | null;
  readonly #fetch: GuardedFetch | null;
  /** Short-lived detail cache so chapter/page routes do not re-scrape every time. */
  readonly #detailCache = new Map<string, { value: ComicDetails; expiresAt: number }>();
  static readonly #DETAIL_TTL_MS = 5 * 60_000;

  constructor(fetchOrOpts: GuardedFetch | ComxAdapterOptions) {
    if (typeof fetchOrOpts === 'function') {
      this.#fetch = fetchOrOpts;
      this.#session = null;
    } else if (fetchOrOpts.session) {
      this.#session = fetchOrOpts.session;
      this.#fetch = null;
    } else if (fetchOrOpts.fetch) {
      this.#fetch = fetchOrOpts.fetch;
      this.#session = null;
    } else if (fetchOrOpts.guard) {
      this.#session = new ComxSession(fetchOrOpts.guard, {
        ...(fetchOrOpts.credentials ? { credentials: fetchOrOpts.credentials } : {}),
        ...(fetchOrOpts.maxBytes !== undefined ? { maxBytes: fetchOrOpts.maxBytes } : {}),
      });
      this.#fetch = null;
    } else {
      throw new Error('ComxAdapter requires session, fetch, or guard options');
    }
  }

  sessionStatus(): ComxSessionStatus {
    return (
      this.#session?.status() ?? {
        connected: false,
        login: null,
        cookieCount: 0,
      }
    );
  }

  async connectAccount(credentials: ComxCredentials): Promise<ComxSessionStatus> {
    if (!this.#session) {
      throw new AppError('INTERNAL', 'comx session is not configured');
    }
    this.#session.setCredentials(credentials);
    return this.#session.ensureAuthenticated();
  }

  disconnectAccount(): ComxSessionStatus {
    this.#session?.clearSession();
    return this.sessionStatus();
  }

  /**
   * Headers for covers / reader pages / future CBZ URLs. Includes the live
   * session Cookie when we are logged in so the image proxy and downloads
   * share the same “inside” session as catalog scraping.
   */
  #httpHeaders(): Record<string, string> {
    return this.#session?.authHeaders() ?? { ...COMX_BROWSER_HEADERS };
  }

  /**
   * Authenticated binary download through the com-x cookie jar (site CBZ bulk
   * export and similar). Catalog login is enough — no second sign-in.
   */
  async downloadAuthenticated(
    url: string,
  ): Promise<{ body: Buffer; contentType: string | null }> {
    if (!this.#session) {
      throw new AppError('INTERNAL', 'comx session is not configured');
    }
    await this.#session.ensureAuthenticated();
    return this.#session.download(url, this.#httpHeaders());
  }

  proxyHosts(): readonly string[] {
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
      const result = this.#session
        ? await this.#session.fetch(targetUrl, this.#httpHeaders())
        : await this.#fetch!(targetUrl, COMX_BROWSER_HEADERS);
      return result.body.toString('utf8');
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError('UPSTREAM_UNAVAILABLE', `com-x fetch failed: ${String(err)}`);
    }
  }

  async #postHtml(targetUrl: string, body: string): Promise<string> {
    if (!this.#session) {
      // Tests / legacy inject only support GET; fall back to GET search URL.
      throw new AppError('UPSTREAM_UNAVAILABLE', 'comx POST requires ComxSession');
    }
    try {
      const result = await this.#session.request(targetUrl, {
        method: 'POST',
        body,
        headers: {
          ...this.#httpHeaders(),
          'content-type': 'application/x-www-form-urlencoded',
          origin: this.#baseUrl,
        },
      });
      if (result.statusCode < 200 || result.statusCode >= 300) {
        throw new AppError(
          'UPSTREAM_UNAVAILABLE',
          `comx is unavailable: upstream responded ${result.statusCode}`,
        );
      }
      return result.body.toString('utf8');
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError('UPSTREAM_UNAVAILABLE', `com-x post failed: ${String(err)}`);
    }
  }

  /**
   * DLE catalog URLs: page 1 must NOT contain `/page/1/` (404).
   * Current public path is `/comix-read/` ( `/comix/` redirects there ).
   */
  getCatalogUrl(page = 1, categoryUrl?: string): string {
    if (categoryUrl) {
      const cleanCat = categoryUrl.replace(/\/$/, '');
      if (page <= 1) {
        return cleanCat.replace(/\/page\/\d+$/, '');
      }
      return cleanCat.includes('/page/') ? cleanCat : `${cleanCat}/page/${page}/`;
    }

    if (page <= 1) {
      return `${this.#baseUrl}/comix-read/`;
    }
    return `${this.#baseUrl}/comix-read/page/${page}/`;
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

  /**
   * Site search via DLE POST form (GET search URLs are unreliable).
   */
  async searchCatalog(query: string, page = 1): Promise<CatalogResponse> {
    const searchUrl = `${this.#baseUrl}/index.php?do=search`;
    const formData = new URLSearchParams({
      do: 'search',
      subaction: 'search',
      search_start: String(page),
      full_search: '0',
      result_from: '1',
      story: query,
    });

    if (this.#session) {
      const html = await this.#postHtml(searchUrl, formData.toString());
      return this.parseCatalogPage(html, page);
    }

    // Legacy GET fallback for unit tests without a session.
    const getUrl = `${this.#baseUrl}/index.php?do=search&subaction=search&story=${encodeURIComponent(query)}&search_start=${page}`;
    const html = await this.#fetchHtml(getUrl);
    return this.parseCatalogPage(html, page);
  }

  async getCatalog(page = 1, categoryUrl?: string): Promise<CatalogResponse> {
    const targetUrl = this.getCatalogUrl(page, categoryUrl);
    try {
      const html = await this.#fetchHtml(targetUrl);
      return this.parseCatalogPage(html, page);
    } catch (err) {
      if (err instanceof AppError) {
        // Preserve the exact upstream wording the Mini App already surfaces.
        if (err.message.startsWith('comx is unavailable:')) throw err;
        if (err.message.startsWith('upstream responded')) {
          throw new AppError('UPSTREAM_UNAVAILABLE', `comx is unavailable: ${err.message}`);
        }
        throw err;
      }
      throw new AppError('UPSTREAM_UNAVAILABLE', `comx is unavailable: ${String(err)}`);
    }
  }

  parseCatalogPage(html: string, page: number): CatalogResponse {
    const $ = cheerio.load(html);
    const items: ComicListItem[] = [];
    const seen = new Set<string>();

    const pushItem = (partial: {
      title: string;
      href: string;
      coverSrc?: string;
      year?: string;
      rating?: string;
      latestChapter?: string;
    }): void => {
      const title = partial.title.trim();
      const href = partial.href.trim();
      if (!title || !href) return;
      // Skip publisher folders / utility pages.
      if (href.includes('/folder/') || href.includes('/genre/') || href.endsWith('/addnews.html')) {
        return;
      }
      const url = this.fixUrl(href);
      if (seen.has(url)) return;
      seen.add(url);

      const coverSrc = partial.coverSrc || '';
      const coverUrl = coverSrc.startsWith('data:') ? '' : this.fixUrl(coverSrc);

      items.push({
        id: this.extractIdFromUrl(href),
        title,
        url,
        coverUrl,
        ...(partial.year ? { year: partial.year } : {}),
        ...(partial.rating ? { rating: partial.rating } : {}),
        ...(partial.latestChapter ? { latestChapter: partial.latestChapter } : {}),
      });
    };

    // Current com-x.life catalog cards (2026 skin).
    $('#dle-content .readed.short, #dle-content .readed, .readed.short').each((_, el) => {
      const $el = $(el);
      const $link = $el.find('.readed__title a, h3 a, a.readed__img').first();
      const title = $link.text().trim() || $el.find('img').attr('alt') || '';
      const href = $link.attr('href') || $el.find('a[href*=".html"]').first().attr('href') || '';
      const $img = $el.find('img').first();
      const coverSrc =
        $img.attr('data-src') || $img.attr('data-original') || $img.attr('src') || '';
      const yearText = $el.find('.readed__meta-item').text();
      const yearMatch = yearText.match(/\b(19|20)\d{2}\b/);
      pushItem({
        title,
        href,
        coverSrc,
        ...(yearMatch?.[0] ? { year: yearMatch[0] } : {}),
      });
    });

    // Sidebar / hot lists.
    $('a.popular').each((_, el) => {
      const $el = $(el);
      const href = $el.attr('href') || '';
      const title = $el.find('.popular__title').text().trim();
      const $img = $el.find('img').first();
      const coverSrc =
        $img.attr('data-src') || $img.attr('data-original') || $img.attr('src') || '';
      pushItem({ title, href, coverSrc });
    });

    // Legacy DLE skins (keep for search / older templates).
    if (items.length === 0) {
      const cardSelectors = [
        '#dle-content .short-story',
        '#dle-content .comix-item',
        '#dle-content .story-item',
        '#dle-content article',
        '.short-story',
        '.story-item',
        '.comix-grid-item',
        'article.story',
      ].join(', ');

      $(cardSelectors).each((_, el) => {
        const $el = $(el);
        const $link = $el
          .find('.story-title a, h2 a, h3 a, .title a, a[href*=".html"]')
          .first();
        const title = $link.text().trim();
        const href = $link.attr('href') || '';
        const $img = $el.find('img').first();
        const coverSrc =
          $img.attr('data-src') || $img.attr('src') || $img.attr('data-original') || '';
        const rating = $el.find('.rating-val, .rate-num, .vote-count').text().trim();
        const yearMatch = $el.find('.year, .story-info').text().match(/\b(19|20)\d{2}\b/);
        const latestChapter = $el.find('.latest-chapter, .new-chap, .chap-num').text().trim();
        pushItem({
          title,
          href,
          coverSrc,
          ...(yearMatch?.[0] ? { year: yearMatch[0] } : {}),
          ...(rating ? { rating } : {}),
          ...(latestChapter ? { latestChapter } : {}),
        });
      });
    }

    let totalPages = page;
    const $pagination = $('#dle-content .navigation, .pagination, .page-nav, .navigation');
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
      $('article.page h1, .page__header h1, .full-story-title, h1.title, .story-full-title')
        .first()
        .text()
        .trim() || $('h1').first().text().trim();
    const originalTitle =
      $('.page__title-original, .orig-title, .sub-title').first().text().trim() || undefined;

    const $coverImg = $(
      '.page__poster img, .full-story-img img, .poster-full img, .story-posters img',
    ).first();
    const coverSrc = $coverImg.attr('data-src') || $coverImg.attr('src') || '';

    const description = (
      $('.page__text.full-text, .story-description, .full-text, #full-story-text, .comic-description')
        .first()
        .text() || ''
    )
      .replace(/\s+/g, ' ')
      .trim();
    const rating =
      $('[data-vote-num-id]').first().text().trim() ||
      $('.rating-value, .rate-count, .current-rating').text().trim() ||
      undefined;

    let publisher: string | undefined;
    let author: string | undefined;
    let artist: string | undefined;
    let year: string | undefined;
    let status: string | undefined;
    const genres: string[] = [];

    $('.page__list li, .story-info-list li, .full-info p, .info-list div').each((_, el) => {
      const text = $(el).text().replace(/\s+/g, ' ').trim();
      if (text.includes('Издатель') || text.includes('Издательство')) {
        publisher = $(el).find('a').text().trim() || text.split(':')[1]?.trim();
      } else if (text.includes('Автор')) {
        author = $(el).find('a').text().trim() || text.split(':')[1]?.trim();
      } else if (text.includes('Художник')) {
        artist = $(el).find('a').text().trim() || text.split(':')[1]?.trim();
      } else if (text.includes('Год')) {
        const y = text.replace(/[^0-9]/g, '');
        if (y) year = y;
      } else if (text.includes('Статус')) {
        status = text.replace(/^.*?Статус:\s*/i, '').trim() || text.split(':')[1]?.trim();
      } else if (text.includes('Жанр')) {
        $(el)
          .find('a')
          .each((__, g) => {
            const genreName = $(g).text().trim();
            if (genreName) genres.push(genreName);
          });
      }
    });

    $('.page__tags a').each((_, g) => {
      const genreName = $(g).text().trim();
      if (genreName && !genres.includes(genreName)) genres.push(genreName);
    });

    const chapters: ChapterItem[] = [];
    const dataMatch = html.match(/window\.__DATA__\s*=\s*(\{[\s\S]*?\});/);
    if (dataMatch?.[1]) {
      try {
        const data = JSON.parse(dataMatch[1]) as {
          news_id?: number | string;
          chapters?: Array<{
            id: number | string;
            title?: string;
            number?: number;
            posi?: number;
            pages?: number;
            volume?: number;
            date?: string;
          }>;
        };
        const newsId = data.news_id;
        for (const ch of data.chapters ?? []) {
          if (newsId === undefined || ch.id === undefined) continue;
          const chUrl = this.fixUrl(`/reader/${newsId}/${ch.id}`);
          const volume = Number(ch.volume);
          const pageCount = Number(ch.pages);
          chapters.push({
            id: String(ch.id),
            title: formatComxChapterTitle(ch),
            url: chUrl,
            ...(ch.date ? { dateAdded: ch.date } : {}),
            chapterNumber: Number(ch.number ?? ch.posi ?? chapters.length + 1),
            ...(Number.isFinite(volume) && volume > 0 ? { volume } : {}),
            ...(Number.isFinite(pageCount) && pageCount > 0 ? { pageCount } : {}),
          });
        }
      } catch {
        // Fall through to legacy link scraping.
      }
    }

    if (chapters.length === 0) {
      $('.chapters-list a, .read-list a, .files-list a, .read-online-list a, a.page__btn-read').each(
        (index, el) => {
          const $chLink = $(el);
          const chHref = $chLink.attr('href') || '';
          const chTitle = $chLink.text().trim() || `Глава ${index + 1}`;
          const chDate = $chLink.find('.date, .time').text().trim() || undefined;
          if (!chHref || chHref === '#') return;
          chapters.push({
            id: this.extractIdFromUrl(chHref),
            title: formatComxChapterTitle({
              title: chTitle,
              number: chapters.length + 1,
              posi: chapters.length + 1,
            }),
            url: this.fixUrl(chHref),
            ...(chDate ? { dateAdded: chDate } : {}),
            chapterNumber: chapters.length + 1,
          });
        },
      );
    }

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
    let title: string | undefined;

    // Modern reader: Vue shell + window.__DATA__.{images,host,pages}.
    const dataMatch = html.match(/window\.__DATA__\s*=\s*(\{[\s\S]*?\});/);
    if (dataMatch?.[1]) {
      try {
        const data = JSON.parse(dataMatch[1]) as {
          images?: unknown;
          host?: string;
          host_ru?: string;
          pages?: number;
          chapter_id?: number | string;
          chapters?: Array<{ id?: number | string; title?: string }>;
        };
        const host = (data.host || data.host_ru || 'img.com-x.life').replace(/^https?:\/\//, '');
        if (Array.isArray(data.images)) {
          for (const entry of data.images) {
            if (typeof entry !== 'string' || !entry.trim()) continue;
            if (/^https?:\/\//i.test(entry) || entry.startsWith('//')) {
              pages.push(this.fixUrl(entry));
            } else {
              const path = entry.replace(/^\/+/, '');
              pages.push(`https://${host}/comix/${path.replace(/^comix\//, '')}`);
            }
          }
        }
        const current = data.chapters?.find((c) => String(c.id) === String(data.chapter_id));
        if (current?.title) title = formatComxChapterTitle(current);
      } catch {
        // Fall through to DOM / legacy script scraping.
      }
    }

    if (pages.length === 0) {
      const firstImage =
        html.match(/window\.__FIRST_IMAGE__\s*=\s*'([^']+)'/)?.[1] ||
        html.match(/"image"\s*:\s*"(https:[^"]+\.(?:jpe?g|png|webp))"/i)?.[1];
      if (firstImage) pages.push(this.fixUrl(firstImage));
    }

    if (pages.length === 0) {
      $(
        '.reader-images img, .read-comic img, #comic-pages img, .page-image, #ssr-first-image',
      ).each((_, el) => {
        const src = $(el).attr('data-src') || $(el).attr('src') || $(el).attr('data-original');
        if (src) pages.push(this.fixUrl(src));
      });
    }

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

    title =
      title ||
      $('.chapter-title, .reader-header h1, title').first().text().trim() ||
      undefined;

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
        ? { kind: 'http', url: item.coverUrl, headers: this.#httpHeaders() }
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
        ? { kind: 'http', url: details.coverUrl, headers: this.#httpHeaders() }
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
      volume: ch.volume ?? null,
      pageCount: ch.pageCount ?? 0,
      publishedAt: parseComxDate(ch.dateAdded),
      coverUrl: null,
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
      source: { kind: 'http' as const, url: pageUrl, headers: this.#httpHeaders() },
    }));
  }

  /**
   * First page of a chapter — used as the issue cover in the chapter grid.
   * Reuses the chapter HTML parse (and short-lived detail cache upstream).
   */
  async getChapterPreview(
    chapterId: string,
  ): Promise<{ coverUrl: string | null; pageCount: number; title?: string }> {
    const url = decodeId(chapterId);
    const result = await this.getChapterPages(url);
    return {
      coverUrl: result.pages[0] ?? null,
      pageCount: result.totalPages,
      ...(result.title ? { title: result.title } : {}),
    };
  }

  async resolveImage(ref: string): Promise<ImageSource> {
    const decoded = decodeId(ref);
    const parts = decoded.split('\u0000');
    if (parts.length >= 3) {
      const url = parts.slice(2).join('\u0000');
      return { kind: 'http', url, headers: this.#httpHeaders() };
    }
    if (/^https?:\/\//i.test(decoded) && /\.(jpe?g|png|webp|gif|avif)(\?|$)/i.test(decoded)) {
      return { kind: 'http', url: decoded, headers: this.#httpHeaders() };
    }
    const details = await this.getComicDetails(decoded);
    if (!details.coverUrl) throw new AppError('NOT_FOUND', 'comic has no cover image');
    return { kind: 'http', url: details.coverUrl, headers: this.#httpHeaders() };
  }
}
