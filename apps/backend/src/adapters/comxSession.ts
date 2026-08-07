import { createHash } from 'node:crypto';
import { AppError } from '@comic/shared';
import {
  resolveSafeTarget,
  safeRequest,
  type GuardOptions,
  type SafeRequestResult,
} from '../net/ssrf.js';

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

function parseSetCookie(header: string | string[] | undefined): Array<{ name: string; value: string }> {
  if (!header) return [];
  const lines = Array.isArray(header) ? header : [header];
  const out: Array<{ name: string; value: string }> = [];
  for (const line of lines) {
    const first = line.split(';')[0]?.trim();
    if (!first) continue;
    const eq = first.indexOf('=');
    if (eq <= 0) continue;
    out.push({ name: first.slice(0, eq), value: first.slice(eq + 1) });
  }
  return out;
}

function isChallengeHtml(html: string): boolean {
  return html.includes('"/_v"') && /token:\s*"/.test(html) && html.includes('pow_nonce');
}

function isLoginWallHtml(html: string): boolean {
  return (
    html.includes('name="login_name"') &&
    html.includes('name="login_password"') &&
    (html.includes('Com-X.life — вход') || html.includes('sandev-auth-magic'))
  );
}

/**
 * Cookie-aware HTML client for com-x.life.
 *
 * Handles the site’s `/_c` → PoW → `/_v` anti-bot gate and optional DLE login
 * when the whole catalog is behind the “вход” wall.
 */
export class ComxSession {
  readonly #guard: GuardOptions;
  readonly #credentials: ComxCredentials | undefined;
  readonly #timeoutMs: number;
  readonly #maxBytes: number;
  readonly #cookies = new Map<string, string>();
  #loginAttempted = false;
  #loginOk = false;

  constructor(
    guard: GuardOptions,
    opts: {
      credentials?: ComxCredentials;
      timeoutMs?: number;
      maxBytes?: number;
    } = {},
  ) {
    this.#guard = guard;
    this.#credentials = opts.credentials;
    this.#timeoutMs = opts.timeoutMs ?? 30_000;
    this.#maxBytes = opts.maxBytes ?? 8 * 1024 * 1024;
  }

  /** Adapter-facing fetch that returns a successful HTML/binary body. */
  async fetch(
    url: string,
    headers: Record<string, string> = {},
  ): Promise<{ body: Buffer; contentType: string | null }> {
    const result = await this.request(url, { headers });
    if (result.statusCode < 200 || result.statusCode >= 300) {
      throw new AppError(
        'UPSTREAM_UNAVAILABLE',
        `comx is unavailable: upstream responded ${result.statusCode}`,
      );
    }
    return { body: result.body, contentType: result.contentType };
  }

  async request(url: string, init: ComxFetchInit = {}): Promise<SafeRequestResult> {
    let current = url;
    let method: 'GET' | 'POST' = init.method ?? 'GET';
    let body = init.body;
    let hopHeaders: Record<string, string> = { ...BROWSER_HEADERS, ...init.headers };
    let guardSolves = 0;
    let loginTries = 0;

    for (let hop = 0; hop < 10; hop++) {
      const result = await this.#raw(current, {
        method,
        headers: hopHeaders,
        ...(body !== undefined ? { body } : {}),
      });
      this.#absorbCookies(result.headers['set-cookie']);

      // Anti-bot challenge pages are served as HTTP 404 on `/_c`.
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
        await this.#login(current);
        // Retry the original request after auth.
        current = url;
        method = init.method ?? 'GET';
        body = init.body;
        hopHeaders = { ...BROWSER_HEADERS, ...init.headers };
        continue;
      }

      if (!init.skipAuth && (result.statusCode === 401 || isLoginWallHtml(html))) {
        throw new AppError(
          'UPSTREAM_UNAVAILABLE',
          'comx requires login: set COMX_LOGIN and COMX_PASSWORD',
        );
      }

      return result;
    }

    throw new AppError('ORIGIN_NOT_ALLOWED', 'too many upstream redirects on com-x');
  }

  async #raw(
    url: string,
    init: { method: 'GET' | 'POST'; body?: string; headers: Record<string, string> },
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
      maxBytes: this.#maxBytes,
      accept,
      ...(init.body !== undefined ? { body: init.body } : {}),
    });
  }

  #cookieHeader(): string {
    return [...this.#cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  #absorbCookies(setCookie: string | string[] | undefined): void {
    for (const { name, value } of parseSetCookie(setCookie)) {
      this.#cookies.set(name, value);
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
    const { nonce, hash } = solveComxPow(token);

    const form = new URLSearchParams({
      token,
      mode: 'modern',
      workTime: '18',
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

  async #login(refererUrl: string): Promise<void> {
    if (this.#loginOk) return;
    if (this.#loginAttempted) {
      throw new AppError(
        'UPSTREAM_UNAVAILABLE',
        'comx login failed: check COMX_LOGIN / COMX_PASSWORD',
      );
    }
    this.#loginAttempted = true;

    if (!this.#credentials?.login || !this.#credentials.password) {
      throw new AppError(
        'UPSTREAM_UNAVAILABLE',
        'comx requires login: set COMX_LOGIN and COMX_PASSWORD',
      );
    }

    const form = new URLSearchParams({
      login_name: this.#credentials.login,
      login_password: this.#credentials.password,
      login: 'submit',
      login_not_save: '1',
    });

    const result = await this.request(`${BASE_URL}/`, {
      method: 'POST',
      body: form.toString(),
      headers: {
        ...BROWSER_HEADERS,
        'content-type': 'application/x-www-form-urlencoded',
        origin: BASE_URL,
        referer: refererUrl,
      },
      skipAuth: true,
    });

    const html = result.body.toString('utf8');
    if (result.statusCode === 401 || isLoginWallHtml(html)) {
      throw new AppError(
        'UPSTREAM_UNAVAILABLE',
        'comx login failed: check COMX_LOGIN / COMX_PASSWORD',
      );
    }
    this.#loginOk = true;
  }
}

export { BASE_URL as COMX_BASE_URL, BROWSER_HEADERS as COMX_BROWSER_HEADERS };
