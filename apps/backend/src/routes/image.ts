import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { AppError, ImageVariant } from '@comic/shared';
import type { AdapterRegistry } from '../adapters/registry.js';
import { LocalAdapter } from '../adapters/local.js';
import { ImportAdapter } from '../adapters/import.js';
import { getTranscodedImage, type PipelineDeps } from '../images/pipeline.js';

/**
 * The single origin every image in the app is loaded from.
 *
 * Deliberately unauthenticated: browsers cannot attach an Authorization header
 * to an `<img>` or to `createImageBitmap`, and routing every page through a
 * fetch-plus-object-URL dance to add one would double the memory traffic in
 * the reader for no real gain. What actually bounds this route is the adapter
 * allowlist (it can only ever serve content a configured adapter exposes) and
 * the rate limiter.
 */
export function registerImageRoutes(
  app: FastifyInstance,
  registry: AdapterRegistry,
  deps: PipelineDeps,
): void {
  app.get<{ Params: { adapterId: string; ref: string }; Querystring: { v?: string } }>(
    '/api/image/:adapterId/:ref',
    async (request, reply) => {
      const adapterId = decodeURIComponent(request.params.adapterId);
      const ref = decodeURIComponent(request.params.ref);

      const variant = ImageVariant.safeParse(request.query.v ?? 'screen');
      if (!variant.success) {
        throw new AppError('BAD_REQUEST', 'v must be one of thumb, screen, zoom');
      }

      const adapter = registry.get(adapterId);
      const source = await adapter.resolveImage(ref);

      // Local + import adapters own a root to resolve relative paths against;
      // every other adapter deals in absolute paths it created itself.
      const resolveFilePath = (p: string): string => {
        if (path.isAbsolute(p)) {
          if (adapter instanceof ImportAdapter) return adapter.absolutePath(p);
          return p;
        }
        if (adapter instanceof LocalAdapter) return adapter.absolutePath(p);
        throw new AppError('INTERNAL', 'relative path from an adapter without a library root');
      };

      // A zip-entry source with an empty name means "whatever the first image
      // is", which local/import adapters emit for covers.
      let resolved = source;
      if (source.kind === 'zip-entry' && source.entryName === '') {
        if (adapter instanceof LocalAdapter) {
          resolved = {
            ...source,
            entryName: await adapter.firstEntryName(source.archivePath),
          };
        } else if (adapter instanceof ImportAdapter) {
          resolved = {
            ...source,
            entryName: await adapter.firstEntryName(source.archivePath),
          };
        }
      }

      const cacheRef = `${adapterId}\u0000${ref}`;
      // Web imports may pull page images from arbitrary public hosts (and their
      // CDN redirects). Private ranges stay blocked; the catalog proxy allowlist
      // does not apply to user-initiated import content.
      const effectiveDeps =
        adapter instanceof ImportAdapter
          ? { ...deps, guard: { ...deps.guard, allowAnyPublicHost: true } }
          : deps;

      const result = await getTranscodedImage(
        resolved,
        variant.data,
        cacheRef,
        effectiveDeps,
        resolveFilePath,
      );

      // Conditional request support: the reader re-requests pages on remount,
      // and a 304 saves re-sending a few hundred KB each time.
      if (request.headers['if-none-match'] === result.etag) {
        return reply.code(304).send();
      }

      return reply
        .header('content-type', 'image/webp')
        .header('etag', result.etag)
        // Content is addressed by a hash of its source and settings, so a given
        // URL's bytes never change and the client may keep them indefinitely.
        .header('cache-control', 'public, max-age=31536000, immutable')
        .header('x-cache', result.fromCache ? 'HIT' : 'MISS')
        // Stops a crafted upload being sniffed as HTML and run on our origin.
        .header('x-content-type-options', 'nosniff')
        .send(result.body);
    },
  );
}
