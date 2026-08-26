import { createHash } from 'node:crypto';
import { AppError } from '@comic/shared';
import {
  resolveSafeTarget,
  safeRequest,
  type GuardOptions,
  type SafeRequestResult,
} from '../net/ssrf.js';
import { loginComxWithBrowser } from './comxBrowserLogin.js';

const BASE_URL = 'https://com-x.life';

const BROWSER_HEADERS: Record<string, string> = {
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'accept-language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
  'cache-control': 'no-cache',
  pragma: 'no-cache',
  referer: `${BASE_URL}/`,
  'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'same-origin',
  'upgrade-insecure-requests': '1',
};

export interface ComxCredentials {
  readonly login: string;
  readonly password: string;
}

export interface ComxFetchInit {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  /** Skip login-wall auto-auth for this call (used internally). */
  skipAuth?: boolean;
  /** Override the default body size ceiling (e.g. CBZ downloads). */
  maxBytes?: number;
}

export interface ComxSessionStatus {
  connected: boolean;
  login: string | null;
  cookieCount: number;
}

/**
 * Solve the com-x.life `/_c` proof-of-work challenge (SHA-256 prefix `00`).
 * Exported for unit tests.
 */
export function solveComxPow(token: string): { nonce: number; hash: string } {
  let nonce = 0;
  for (;;) {
    const hash = createHash('sha256').update(`${token}:${nonce}`).digest('hex');
    if (hash.startsWith('00')) return { nonce, hash };
    nonce += 1;
    if (nonce > 5_000_000) {
      throw new AppError('UPSTREAM_UNAVAILABLE', 'com-x anti-bot PoW could not be solved');
    }
  }
}

function parseSetCookie(
  header: string | string[] | undefined,
): Array<{ name: string; value: string; deleted?: boolean }> {
  if (!header) return [];
  const lines = Array.isArray(header) ? header : [header];
  const out: Array<{ name: string; value: string; deleted?: boolean }> = [];
  for (const line of lines) {
    const first = line.split(';')[0]?.trim();
    if (!first) continue;
    const eq = first.indexOf('=');
    if (eq <= 0) continue;
    const name = first.slice(0, eq);
    const value = first.slice(eq + 1);
    const deleted =
      value === 'deleted' ||
      /expires=Thu,\s*01[-\s]Jan[-\s]1970/i.test(line) ||
      /Max-Age=0/i.test(line);
    out.push({ name, value, ...(deleted ? { deleted: true } : {}) });
  }
  return out;
}

function isChallengeHtml(html: string): boolean {
  return html.includes('"/_v"') && /token:\s*"/.test(html) && html.includes('pow_nonce');
}

function isLoginWallHtml(html: string): boolean {
  const hasForm =
    html.includes('name="login_name"') && html.includes('name="login_password"');
  if (!hasForm) return false;
  // The public catalog embeds a login modal. Real gates have no comic cards.
  if (
    html.includes('class="poster') ||
    html.includes('readed__title') ||
    html.includes('latest__title')
  ) {
    return false;
  }
  return html.includes('Com-X.life — вход') || html.includes('sandev-auth-magic');
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Cookie-aware HTML/binary client for com-x.life.
 *
 * Login goes through real Chrome (human pacing). The resulting cookies are
 * reused for catalog/search/chapters/pages and later file downloads — so one
 * “go inside” session covers the whole adapter surface.
 */
export class ComxSession {
  readonly #guard: GuardOptions;
  #credentials: ComxCredentials | undefined;
  readonly #timeoutMs: number;
  readonly #maxBytes: number;
  readonly #downloadMaxBytes: number;
  readonly #cookies = new Map<string, string>();
  #loginOk = false;
  #loginInFlight: Promise<void> | null = null;

  constructor(
    guard: GuardOptions,
    opts: {
      credentials?: ComxCredentials;
      timeoutMs?: number;
      maxBytes?: number;
      /** Ceiling for CBZ / archive downloads (defaults to maxBytes). */
      downloadMaxBytes?: number;
    } = {},
  ) {
    this.#guard = guard;
    this.#credentials = opts.credentials;
    this.#timeoutMs = opts.timeoutMs ?? 45_000;
    this.#maxBytes = opts.maxBytes ?? 8 * 1024 * 1024;
    this.#downloadMaxBytes = opts.downloadMaxBytes ?? this.#maxBytes;
  }

  status(): ComxSessionStatus {
    return {
      connected: this.#loginOk && this.#cookies.size > 0,
      login: this.#credentials?.login ?? null,
      cookieCount: this.#cookies.size,
    };
  }

  setCredentials(credentials: ComxCredentials): void {
    this.#credentials = credentials;
    this.#loginOk = false;
    this.#cookies.clear();
  }

  clearSession(): void {
    this.#loginOk = false;
    this.#cookies.clear();
  }

  /**
   * Browser + Cookie headers for authenticated fetches outside this session
   * (image proxy, future CBZ download URLs). Empty Cookie when not logged in.
   */
  authHeaders(extra: Record<string, string> = {}): Record<string, string> {
    const cookie = this.#cookieHeader();
    return {
      ...BROWSER_HEADERS,
      ...extra,
      ...(cookie ? { cookie } : {}),
    };
  }

  /** Ensure we have a logged-in browser session (idempotent, single-flight). */
  async ensureAuthenticated(): Promise<ComxSessionStatus> {
    if (this.#loginOk && this.#cookies.size > 0) return this.status();
    await this.#loginWithBrowser();
    return this.status();
  }

  /** Adapter-facing fetch that returns a successful HTML/binary body. */
  async fetch(
    url: string,
    headers: Record<string, string> = {},
    opts: { maxBytes?: number } = {},
  ): Promise<{ body: Buffer; contentType: string | null }> {
    const result = await this.request(url, {
      headers,
      ...(opts.maxBytes !== undefined ? { maxBytes: opts.maxBytes } : {}),
    });
    if (result.statusCode < 200 || result.statusCode >= 300) {
      throw new AppError(
        'UPSTREAM_UNAVAILABLE',
        `comx is unavailable: upstream responded ${result.statusCode}`,
      );
    }
    return { body: result.body, contentType: result.contentType };
  }

  /**
   * Authenticated download of a larger binary (e.g. site CBZ bulk export).
   * Uses the same cookie jar as catalog browsing — one “go inside” session.
   */
  async download(
    url: string,
    headers: Record<string, string> = {},
  ): Promise<{ body: Buffer; contentType: string | null }> {
    return this.fetch(url, headers, { maxBytes: this.#downloadMaxBytes });
  }

  async request(url: string, init: ComxFetchInit = {}): Promise<SafeRequestResult> {
    const maxBytes = init.maxBytes ?? this.#maxBytes;
    let current = url;
    let method: 'GET' | 'POST' = init.method ?? 'GET';
    let body = init.body;
    let hopHeaders: Record<string, string> = { ...BROWSER_HEADERS, ...init.headers };
    let guardSolves = 0;
    let loginTries = 0;

    for (let hop = 0; hop < 10; hop++) {
      // Light pacing between hops so we do not look like a scrape burst.
      if (hop > 0) await sleep(250 + Math.floor(Math.random() * 400));

      const result = await this.#raw(
        current,
        {
          method,
          headers: hopHeaders,
          ...(body !== undefined ? { body } : {}),
        },
        maxBytes,
      );
      this.#absorbCookies(result.headers['set-cookie']);

      if (
        (result.statusCode === 404 || result.statusCode === 200) &&
        isChallengeHtml(result.body.toString('utf8'))
      ) {
        if (guardSolves++ > 2) {
          throw new AppError('UPSTREAM_UNAVAILABLE', 'comx anti-bot challenge loop');
        }
        const challengeUrl = current;
        const targetUrl = await this.#solveChallenge(challengeUrl, result.body.toString('utf8'));
        current = targetUrl;
        method = 'GET';
        body = undefined;
        hopHeaders = {
          ...BROWSER_HEADERS,
          ...init.headers,
          referer: challengeUrl,
        };
        continue;
      }

      if (result.redirectLocation && result.statusCode >= 300 && result.statusCode < 400) {
        const previous = current;
        const next = new URL(result.redirectLocation, current).toString();
        current = next;
        method = 'GET';
        body = undefined;
        hopHeaders = {
          ...BROWSER_HEADERS,
          ...init.headers,
          referer: previous,
        };
        continue;
      }

      const html = result.body.toString('utf8');
      if (
        !init.skipAuth &&
        (result.statusCode === 401 || isLoginWallHtml(html)) &&
        loginTries < 1
      ) {
        loginTries += 1;
        this.#loginOk = false;
        await this.#loginWithBrowser();
        current = url;
        method = init.method ?? 'GET';
        body = init.body;
        hopHeaders = { ...BROWSER_HEADERS, ...init.headers };
        await sleep(1000 + Math.floor(Math.random() * 800));
        continue;
      }

      if (!init.skipAuth && (result.statusCode === 401 || isLoginWallHtml(html))) {
        throw new AppError(
          'UPSTREAM_UNAVAILABLE',
          'comx session expired — reconnect your com-x account in Library',
        );
      }

      return result;
    }

    throw new AppError('ORIGIN_NOT_ALLOWED', 'too many upstream redirects on com-x');
  }

  async #loginWithBrowser(): Promise<void> {
    if (this.#loginInFlight) {
      await this.#loginInFlight;
      return;
    }
    if (!this.#credentials?.login || !this.#credentials.password) {
      throw new AppError(
        'UPSTREAM_UNAVAILABLE',
        'comx requires login: connect your account in Library (or set COMX_LOGIN / COMX_PASSWORD)',
      );
    }

    this.#loginInFlight = (async () => {
      const { cookies } = await loginComxWithBrowser(this.#credentials!);
      this.#cookies.clear();
      for (const cookie of cookies) {
        this.#cookies.set(cookie.name, cookie.value);
      }
      this.#loginOk = true;
    })();

    try {
      await this.#loginInFlight;
    } finally {
      this.#loginInFlight = null;
    }
  }

  async #raw(
    url: string,
    init: { method: 'GET' | 'POST'; body?: string; headers: Record<string, string> },
    maxBytes: number = this.#maxBytes,
  ): Promise<SafeRequestResult> {
    const target = await resolveSafeTarget(url, this.#guard);
    const cookie = this.#cookieHeader();
    const headers: Record<string, string> = { ...init.headers };
    if (cookie) headers.cookie = cookie;
    if (init.method === 'POST' && init.body !== undefined && !headers['content-type']) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
    }
    const accept = headers.accept ?? headers.Accept ?? BROWSER_HEADERS.accept ?? '*/*';
    return safeRequest(target, {
      method: init.method,
      headers,
      timeoutMs: this.#timeoutMs,
      maxBytes,
      accept,
      ...(init.body !== undefined ? { body: init.body } : {}),
    });
  }

  #cookieHeader(): string {
    return [...this.#cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  #absorbCookies(setCookie: string | string[] | undefined): void {
    for (const cookie of parseSetCookie(setCookie)) {
      if (cookie.deleted) this.#cookies.delete(cookie.name);
      else this.#cookies.set(cookie.name, cookie.value);
    }
  }

  async #solveChallenge(challengeUrl: string, html: string): Promise<string> {
    const tokenRaw = html.match(/token:\s*"([^"]+)"/)?.[1];
    const targetEnc = html.match(/decodeURIComponent\("([^"]+)"\)/)?.[1];
    if (!tokenRaw || !targetEnc) {
      throw new AppError('UPSTREAM_MALFORMED', 'com-x challenge page missing token/target');
    }
    const token = decodeURIComponent(tokenRaw);
    const targetUrl = decodeURIComponent(targetEnc);
    const started = Date.now();
    const { nonce, hash } = solveComxPow(token);
    const workTime = Math.max(12, Date.now() - started);

    const form = new URLSearchParams({
      token,
      mode: 'modern',
      workTime: String(workTime),
      iterations: String(nonce + 80),
      hasCrypto: '1',
      pow_nonce: String(nonce),
      pow_hash: hash,
      webdriver: '0',
      touch: '0',
      screen_w: '1920',
      screen_h: '1080',
      screen_cd: '24',
      tz: String(new Date().getTimezoneOffset()),
      dpr: '1',
      cdp: '0',
      cdpf: '',
    });

    await sleep(200 + Math.floor(Math.random() * 300));

    const verify = await this.#raw(`${BASE_URL}/_v`, {
      method: 'POST',
      body: form.toString(),
      headers: {
        ...BROWSER_HEADERS,
        accept: '*/*',
        origin: BASE_URL,
        referer: challengeUrl,
        'content-type': 'application/x-www-form-urlencoded',
        'x-requested-with': 'XMLHttpRequest',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin',
      },
    });
    this.#absorbCookies(verify.headers['set-cookie']);

    if (verify.statusCode !== 200 || verify.body.toString('utf8').trim() !== 'OK') {
      throw new AppError(
        'UPSTREAM_UNAVAILABLE',
        `comx anti-bot verify failed: HTTP ${verify.statusCode}`,
      );
    }
    return targetUrl;
  }
}

export { BASE_URL as COMX_BASE_URL, BROWSER_HEADERS as COMX_BROWSER_HEADERS, isLoginWallHtml };
