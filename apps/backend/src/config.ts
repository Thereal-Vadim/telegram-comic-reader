import { z } from 'zod';
import path from 'node:path';

/**
 * Configuration is parsed once at boot and the process refuses to start on a
 * bad value. A misconfigured proxy allowlist or a missing bot token are both
 * security-relevant, so failing loudly here beats discovering it at request
 * time when the failure mode is "everything is allowed".
 */

const csv = (raw: string | undefined): string[] =>
  (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const RawConfig = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),

  /**
   * Telegram bot token. Required in production because it is the only thing
   * that makes initData verification meaningful; in development we allow it to
   * be absent and fall back to an explicitly-labelled insecure dev identity.
   */
  TELEGRAM_BOT_TOKEN: z.string().min(1).optional(),
  /** Signing key for our own session JWTs. Must not be the bot token. */
  JWT_SECRET: z.string().min(32).optional(),
  JWT_TTL_SECONDS: z.coerce.number().int().min(60).max(86400).default(3600),
  /**
   * initData older than this is rejected even if the HMAC is valid, so a
   * leaked initData string is not a permanent credential.
   */
  INIT_DATA_MAX_AGE_SECONDS: z.coerce.number().int().min(60).default(86400),

  /** Browser origins permitted to call the API (the Mini App's own origin). */
  CORS_ORIGINS: z.string().default('*'),

  /** Root of the local CBZ/CBR/PDF library. Empty disables the local adapter. */
  LOCAL_LIBRARY_DIR: z.string().default(''),
  /**
   * OPDS catalog roots, comma separated. Each becomes its own adapter and its
   * origin is added to the image proxy allowlist.
   * Format: `label|url|username|password` (credentials optional).
   *
   * Point this at YOUR catalog (Kavita, Komga, Calibre-Web, …). The app does
   * not ship with any third-party content source.
   */
  OPDS_CATALOGS: z.string().default(''),

  /**
   * Enable the com-x.life HTML adapter (catalog, search, chapters, pages).
   * Off by default — turn on explicitly when you want that source.
   */
  COMX_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  /**
   * Optional DLE credentials. com-x.life currently gates the catalog behind
   * a login wall after the anti-bot challenge; without these the adapter
   * can solve the PoW gate but cannot read comics.
   */
  COMX_LOGIN: z.string().default(''),
  COMX_PASSWORD: z.string().default(''),

  /**
   * Ceiling for a whole CBZ download from an OPDS acquisition link (individual
   * pages stay under IMAGE_MAX_SOURCE_BYTES).
   */
  ARCHIVE_MAX_BYTES: z.coerce
    .number()
    .int()
    .min(8 * 1024 * 1024)
    .default(150 * 1024 * 1024),

  /** Transcoded image cache location and ceiling. */
  IMAGE_CACHE_DIR: z.string().default(''),
  IMAGE_CACHE_MAX_BYTES: z.coerce
    .number()
    .int()
    .min(64 * 1024 * 1024)
    .default(2 * 1024 * 1024 * 1024),
  /** WebP quality for transcoded pages. 82 is near-transparent for line art. */
  IMAGE_WEBP_QUALITY: z.coerce.number().int().min(1).max(100).default(82),
  /** Hard ceiling on a source image before we refuse to decode it. */
  IMAGE_MAX_SOURCE_BYTES: z.coerce
    .number()
    .int()
    .min(1024 * 1024)
    .default(64 * 1024 * 1024),

  /**
   * Extra hosts allowed through the image proxy beyond those implied by the
   * configured adapters. Kept separate so adapter config alone cannot silently
   * widen the proxy's reach.
   */
  PROXY_EXTRA_HOSTS: z.string().default(''),
  /**
   * Escape hatch for running against an OPDS server on a LAN address. Off by
   * default: with it off, any upstream resolving to a private range is refused,
   * which is what stops the proxy being an SSRF pivot into the host network.
   */
  ALLOW_PRIVATE_UPSTREAM: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(300),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).default(60_000),
});

export interface OpdsCatalogConfig {
  readonly id: string;
  readonly label: string;
  readonly url: string;
  readonly username: string | undefined;
  readonly password: string | undefined;
}

function parseOpdsCatalogs(raw: string): OpdsCatalogConfig[] {
  const out: OpdsCatalogConfig[] = [];
  for (const [i, entry] of csv(raw).entries()) {
    const [label, url, username, password] = entry.split('|').map((s) => s?.trim());
    if (!label || !url) {
      throw new Error(`OPDS_CATALOGS entry ${i} must be "label|url[|user|pass]", got "${entry}"`);
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`OPDS_CATALOGS entry ${i} has an unparseable url: "${url}"`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`OPDS_CATALOGS entry ${i} must be http(s), got "${parsed.protocol}"`);
    }
    // Slugify the label into an adapter id; ids appear in every namespaced id.
    const id = `opds-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
    out.push({
      id,
      label,
      url,
      username: username || undefined,
      password: password || undefined,
    });
  }

  const ids = new Set<string>();
  for (const c of out) {
    if (ids.has(c.id)) throw new Error(`duplicate OPDS adapter id "${c.id}" - labels must differ`);
    ids.add(c.id);
  }
  return out;
}

export interface Config {
  readonly env: 'development' | 'production' | 'test';
  readonly host: string;
  readonly port: number;
  readonly telegramBotToken: string | undefined;
  readonly jwtSecret: string;
  readonly jwtTtlSeconds: number;
  readonly initDataMaxAgeSeconds: number;
  readonly corsOrigins: string[] | true;
  readonly localLibraryDir: string | undefined;
  readonly opdsCatalogs: OpdsCatalogConfig[];
  readonly comxEnabled: boolean;
  readonly comxLogin: string | undefined;
  readonly comxPassword: string | undefined;
  readonly archiveMaxBytes: number;
  readonly imageCacheDir: string;
  readonly imageCacheMaxBytes: number;
  readonly imageWebpQuality: number;
  readonly imageMaxSourceBytes: number;
  readonly proxyExtraHosts: string[];
  readonly allowPrivateUpstream: boolean;
  readonly rateLimitMax: number;
  readonly rateLimitWindowMs: number;
  /** True when no bot token is set and we are not in production. */
  readonly insecureDevAuth: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const raw = RawConfig.parse(env);
  const isProd = raw.NODE_ENV === 'production';

  if (isProd && !raw.TELEGRAM_BOT_TOKEN) {
    throw new Error('TELEGRAM_BOT_TOKEN is required when NODE_ENV=production');
  }
  if (isProd && !raw.JWT_SECRET) {
    throw new Error('JWT_SECRET is required when NODE_ENV=production');
  }
  if (raw.JWT_SECRET && raw.TELEGRAM_BOT_TOKEN && raw.JWT_SECRET === raw.TELEGRAM_BOT_TOKEN) {
    // Reusing the bot token as the session key means anyone who can mint a
    // session can also forge initData, collapsing two trust boundaries into one.
    throw new Error('JWT_SECRET must not be the same value as TELEGRAM_BOT_TOKEN');
  }

  const opdsCatalogs = parseOpdsCatalogs(raw.OPDS_CATALOGS);
  const cacheDir = raw.IMAGE_CACHE_DIR || path.resolve(process.cwd(), '.cache/images');

  return {
    env: raw.NODE_ENV,
    host: raw.HOST,
    port: raw.PORT,
    telegramBotToken: raw.TELEGRAM_BOT_TOKEN,
    // Dev fallback is a fixed string so restarts do not invalidate open sessions.
    jwtSecret: raw.JWT_SECRET ?? 'insecure-development-jwt-secret-do-not-use-in-production',
    jwtTtlSeconds: raw.JWT_TTL_SECONDS,
    initDataMaxAgeSeconds: raw.INIT_DATA_MAX_AGE_SECONDS,
    corsOrigins: raw.CORS_ORIGINS === '*' ? true : csv(raw.CORS_ORIGINS),
    localLibraryDir: raw.LOCAL_LIBRARY_DIR ? path.resolve(raw.LOCAL_LIBRARY_DIR) : undefined,
    opdsCatalogs,
    comxEnabled: raw.COMX_ENABLED,
    comxLogin: raw.COMX_LOGIN || undefined,
    comxPassword: raw.COMX_PASSWORD || undefined,
    archiveMaxBytes: raw.ARCHIVE_MAX_BYTES,
    imageCacheDir: path.resolve(cacheDir),
    imageCacheMaxBytes: raw.IMAGE_CACHE_MAX_BYTES,
    imageWebpQuality: raw.IMAGE_WEBP_QUALITY,
    imageMaxSourceBytes: raw.IMAGE_MAX_SOURCE_BYTES,
    proxyExtraHosts: csv(raw.PROXY_EXTRA_HOSTS).map((h) => h.toLowerCase()),
    allowPrivateUpstream: raw.ALLOW_PRIVATE_UPSTREAM,
    rateLimitMax: raw.RATE_LIMIT_MAX,
    rateLimitWindowMs: raw.RATE_LIMIT_WINDOW_MS,
    insecureDevAuth: !raw.TELEGRAM_BOT_TOKEN && !isProd,
  };
}
