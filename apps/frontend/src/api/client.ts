import {
  ApiError,
  AdapterListResponse,
  AuthResponse,
  ChapterListResponse,
  HomeFeedResponse,
  PageListResponse,
  SearchResponse,
  type ApiErrorCode,
  type ImageVariant,
} from '@comic/shared';
import type { z } from 'zod';
import { getWebApp } from '../telegram/webapp';

/**
 * Typed API client.
 *
 * Every response is parsed through its shared schema. That costs a little on
 * large chapter lists but means a backend contract change surfaces as one
 * clear error here rather than as an undefined field somewhere in the reader,
 * where the symptom would be a blank page with no explanation.
 */

export class ApiClientError extends Error {
  readonly code: ApiErrorCode | 'NETWORK' | 'OFFLINE' | 'MALFORMED';
  readonly status: number;
  readonly retryAfterMs: number | undefined;

  constructor(
    code: ApiClientError['code'],
    message: string,
    status = 0,
    retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'ApiClientError';
    this.code = code;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }

  /** True when retrying the identical request could plausibly succeed. */
  get retryable(): boolean {
    return (
      this.code === 'NETWORK' ||
      this.code === 'OFFLINE' ||
      this.code === 'RATE_LIMITED' ||
      this.code === 'UPSTREAM_UNAVAILABLE' ||
      this.status >= 500
    );
  }
}

const TOKEN_STORAGE_KEY = 'comic.session';

interface CachedSession {
  token: string;
  expiresAt: number;
}

export class ApiClient {
  readonly #baseUrl: string;
  #session: CachedSession | null = null;
  /** In-flight auth, shared so a burst of 401s triggers one re-auth, not many. */
  #authInFlight: Promise<CachedSession> | null = null;

  constructor(baseUrl = '') {
    this.#baseUrl = baseUrl.replace(/\/$/, '');
    this.#session = this.#loadSession();
  }

  #loadSession(): CachedSession | null {
    try {
      const raw = sessionStorage.getItem(TOKEN_STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as CachedSession;
      // Treat anything within a minute of expiry as already gone, so we do not
      // start a request that will 401 halfway through.
      return parsed.expiresAt > Date.now() + 60_000 ? parsed : null;
    } catch {
      return null;
    }
  }

  #saveSession(session: CachedSession): void {
    this.#session = session;
    try {
      sessionStorage.setItem(TOKEN_STORAGE_KEY, JSON.stringify(session));
    } catch {
      // Private browsing can reject sessionStorage writes; the in-memory copy
      // still works for this page lifetime.
    }
  }

  /** Authenticate with the current Telegram launch payload. */
  async #authenticate(): Promise<CachedSession> {
    this.#authInFlight ??= (async () => {
      const initData = getWebApp().initData;

      const res = await fetch(`${this.#baseUrl}/api/auth/telegram`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ initData: initData || 'dev' }),
      }).catch(() => {
        throw new ApiClientError('NETWORK', 'could not reach the server to sign in');
      });

      if (!res.ok) {
        throw new ApiClientError('UNAUTHORIZED', 'sign-in was rejected; relaunch the app', res.status);
      }

      const parsed = AuthResponse.safeParse(await res.json());
      if (!parsed.success) {
        throw new ApiClientError('MALFORMED', 'sign-in response did not match the expected shape');
      }

      const session = { token: parsed.data.token, expiresAt: parsed.data.expiresAt };
      this.#saveSession(session);
      return session;
    })().finally(() => {
      this.#authInFlight = null;
    });

    return this.#authInFlight;
  }

  async #token(): Promise<string> {
    if (this.#session && this.#session.expiresAt > Date.now() + 60_000) {
      return this.#session.token;
    }
    return (await this.#authenticate()).token;
  }

  async #request<T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> {
    // Fail fast when the platform already knows there is no connection; the
    // caller can then fall back to IndexedDB without waiting for a timeout.
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      throw new ApiClientError('OFFLINE', 'device is offline');
    }

    const send = async (token: string): Promise<Response> =>
      fetch(`${this.#baseUrl}${path}`, {
        ...init,
        headers: {
          ...init?.headers,
          authorization: `Bearer ${token}`,
        },
      });

    let res: Response;
    try {
      res = await send(await this.#token());
      // A 401 after a valid-looking token means the server restarted with a
      // new secret or the clock drifted. Re-auth once before giving up.
      if (res.status === 401) {
        this.#session = null;
        res = await send((await this.#authenticate()).token);
      }
    } catch (err) {
      if (err instanceof ApiClientError) throw err;
      throw new ApiClientError('NETWORK', 'network request failed');
    }

    if (!res.ok) {
      const body = await res.json().catch(() => null);
      const parsed = ApiError.safeParse(body);
      if (parsed.success) {
        throw new ApiClientError(
          parsed.data.error.code,
          parsed.data.error.message,
          res.status,
          parsed.data.error.retryAfterMs,
        );
      }
      throw new ApiClientError('NETWORK', `request failed with status ${res.status}`, res.status);
    }

    const json = await res.json().catch(() => {
      throw new ApiClientError('MALFORMED', 'response was not valid JSON');
    });

    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new ApiClientError('MALFORMED', `response did not match schema: ${parsed.error.message}`);
    }
    return parsed.data;
  }

  home(): Promise<HomeFeedResponse> {
    return this.#request('/api/home', HomeFeedResponse);
  }

  adapters(): Promise<AdapterListResponse> {
    return this.#request('/api/adapters', AdapterListResponse);
  }

  search(params: { q: string; page?: number; adapter?: string; genre?: string }): Promise<SearchResponse> {
    const qs = new URLSearchParams({ q: params.q, page: String(params.page ?? 0) });
    if (params.adapter) qs.set('adapter', params.adapter);
    if (params.genre) qs.set('genre', params.genre);
    return this.#request(`/api/search?${qs}`, SearchResponse);
  }

  comic(id: string): Promise<ChapterListResponse> {
    return this.#request(`/api/comics/${encodeURIComponent(id)}`, ChapterListResponse);
  }

  pages(chapterId: string): Promise<PageListResponse> {
    return this.#request(`/api/chapters/${encodeURIComponent(chapterId)}/pages`, PageListResponse);
  }

  /**
   * Absolute URL for an image at a given variant.
   *
   * Page URLs come back from the API already pointing at `screen`; this
   * rewrites the variant so the reader can request `zoom` for the page under a
   * pinch without another round trip to the catalog.
   */
  imageUrl(url: string, variant: ImageVariant): string {
    const absolute = url.startsWith('http') ? url : `${this.#baseUrl}${url}`;
    const parsed = new URL(absolute, window.location.origin);
    parsed.searchParams.set('v', variant);
    return parsed.toString();
  }
}

export const api = new ApiClient(import.meta.env['VITE_API_BASE'] ?? '');
