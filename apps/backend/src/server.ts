import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { AppError } from '@comic/shared';
import { loadConfig, type Config } from './config.js';
import { buildRegistry, type AdapterRegistry } from './adapters/registry.js';
import { ImageCache } from './images/cache.js';
import { resolveSafeTarget, safeFetch, safeFetchFollowingRedirects, type GuardOptions } from './net/ssrf.js';
import { registerAuthRoutes, requireSession } from './routes/auth.js';
import { registerCatalogRoutes } from './routes/catalog.js';
import { registerImageRoutes } from './routes/image.js';
import { registerComxRoutes } from './routes/comxRoutes.js';

export interface BuiltServer {
  readonly app: FastifyInstance;
  readonly cfg: Config;
  readonly registry: AdapterRegistry;
  readonly cache: ImageCache;
}

export async function buildServer(overrides?: Partial<NodeJS.ProcessEnv>): Promise<BuiltServer> {
  const cfg = loadConfig({ ...process.env, ...overrides });

  const app = Fastify({
    // Structured JSON logs in every environment. Pretty-printing is left to
    // the operator piping through `pino-pretty`, which keeps the transport
    // dependency out of the production image.
    logger: { level: cfg.env === 'test' ? 'silent' : 'info' },
    // com-x image refs embed two URLs as base64url; keep headroom above 8 KB.
    maxParamLength: 4096,
    bodyLimit: 64 * 1024,
  });

  /*
   * The proxy allowlist has a bootstrapping problem: the registry derives it
   * from its adapters, but the OPDS adapters need a guarded fetch to be
   * constructed. We break the cycle with a late-bound reference that the
   * guard closure reads at call time, after the registry exists.
   */
  let guardOptions: GuardOptions = {
    allowedHosts: new Set<string>(),
    allowPrivate: cfg.allowPrivateUpstream,
  };

  const guardedFetch = async (url: string, headers: Record<string, string> = {}) => {
    const target = await resolveSafeTarget(url, guardOptions);
    return safeFetch(target, {
      headers,
      timeoutMs: 20_000,
      maxBytes: cfg.imageMaxSourceBytes,
      accept: headers['accept'] ?? headers['Accept'] ?? 'image/*',
    });
  };

  // OPDS acquisition: CBZ bodies are large and may 302 onto a CDN.
  const opdsFetch = async (url: string, headers: Record<string, string> = {}) => {
    const accept = headers['accept'] ?? headers['Accept'] ?? '*/*';
    const wantsArchive =
      accept.includes('zip') || accept.includes('comicbook') || accept === '*/*';
    if (wantsArchive && !accept.startsWith('image/')) {
      return safeFetchFollowingRedirects(url, guardOptions, {
        headers,
        timeoutMs: 120_000,
        maxBytes: cfg.archiveMaxBytes,
        accept,
      });
    }
    return guardedFetch(url, headers);
  };

  // com-x HTML + CDN images: any public host, private ranges still blocked.
  // The adapter owns a cookie jar + PoW solver on top of this guard.
  const comxGuard: GuardOptions = {
    allowedHosts: new Set<string>(),
    allowPrivate: false,
    allowAnyPublicHost: true,
  };

  const { registry, comx } = buildRegistry(cfg, opdsFetch, comxGuard);
  guardOptions = { allowedHosts: registry.proxyHosts, allowPrivate: cfg.allowPrivateUpstream };

  const cache = new ImageCache(cfg.imageCacheDir, cfg.imageCacheMaxBytes);
  await cache.init();

  await app.register(cors, {
    origin: cfg.corsOrigins,
    credentials: false,
    // The reader reads ETag off image responses to drive conditional requests.
    exposedHeaders: ['etag', 'x-cache'],
  });

  await app.register(rateLimit, {
    max: cfg.rateLimitMax,
    timeWindow: cfg.rateLimitWindowMs,
    // A chapter is a burst of image requests from one client, so the limiter
    // has to be generous enough not to throttle ordinary reading.
    allowList: () => false,
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      // Expected failures are logged at warn; they are not defects.
      request.log.warn({ code: error.code, msg: error.message }, 'request failed');
      if (error.retryAfterMs !== undefined) {
        reply.header('retry-after', Math.ceil(error.retryAfterMs / 1000));
      }
      return reply.code(error.status).send(error.toBody());
    }

    if ((error as { statusCode?: number }).statusCode === 429) {
      return reply.code(429).send({
        error: { code: 'RATE_LIMITED', message: 'too many requests', retryAfterMs: 60_000 },
      });
    }

    request.log.error({ err: error }, 'unhandled error');
    return reply
      .code(500)
      .send({ error: { code: 'INTERNAL', message: 'internal server error' } });
  });

  app.setNotFoundHandler((_request, reply) =>
    reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'no such route' } }),
  );

  app.get('/api/health', async () => ({
    ok: true,
    adapters: registry.size,
    cache: { entries: cache.entryCount, bytes: cache.totalBytes },
  }));

  const sessionGuard = requireSession(cfg);
  registerAuthRoutes(app, cfg);
  registerCatalogRoutes(app, registry, sessionGuard);
  registerImageRoutes(app, registry, {
    cache,
    quality: cfg.imageWebpQuality,
    maxSourceBytes: cfg.imageMaxSourceBytes,
    guard: guardOptions,
  });

  if (comx) {
    registerComxRoutes(app, comx, sessionGuard);
  }

  if (registry.size === 0) {
    app.log.warn(
      'no content sources configured — set LOCAL_LIBRARY_DIR, OPDS_CATALOGS, ' +
        'and/or COMX_ENABLED=true, then restart',
    );
  } else {
    app.log.info(
      { adapters: registry.size, cacheDir: path.relative(process.cwd(), cfg.imageCacheDir) },
      'content sources ready',
    );
  }

  return { app, cfg, registry, cache };
}
