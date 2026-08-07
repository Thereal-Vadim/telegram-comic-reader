import type { FastifyInstance } from 'fastify';
import {
  AppError,
  ChapterListResponse,
  HomeFeedResponse,
  NamespacedId,
  PageListResponse,
  SearchQuery,
  SearchResponse,
  type AdapterListResponse,
} from '@comic/shared';

import type { AdapterRegistry } from '../adapters/registry.js';

/**
 * Catalog endpoints. Every response is parsed through its shared schema before
 * being sent, so a shape regression fails here rather than as an undefined
 * field in the reader.
 */
export function registerCatalogRoutes(
  app: FastifyInstance,
  registry: AdapterRegistry,
  guard: (req: import('fastify').FastifyRequest) => Promise<void>,
): void {
  app.get('/api/adapters', { preHandler: guard }, async (_request, reply) => {
    const body: AdapterListResponse = { adapters: await registry.list() };
    return reply.send(body);
  });

  app.get('/api/home', { preHandler: guard }, async (_request, reply) => {
    // Import-only setups are valid: the home feed may be empty until the user
    // pastes a link on the Sources page.
    if (registry.size === 0) {
      throw new AppError(
        'INTERNAL',
        'no content sources are configured; set LOCAL_LIBRARY_DIR or OPDS_CATALOGS',
      );
    }
    const feed = await registry.homeFeed();
    return reply.send(HomeFeedResponse.parse(feed));
  });

  app.get('/api/search', { preHandler: guard }, async (request, reply) => {
    const parsed = SearchQuery.safeParse(request.query);
    if (!parsed.success) {
      throw new AppError('BAD_REQUEST', `invalid search query: ${parsed.error.message}`);
    }
    const { q, page, adapter, genre } = parsed.data;

    const result = await registry.search({ q, page, genre, adapterId: adapter });
    return reply.send(
      SearchResponse.parse({
        items: result.items,
        page,
        hasMore: result.hasMore,
        degraded: result.degraded,
      }),
    );
  });

  app.get<{ Params: { id: string } }>(
    '/api/comics/:id',
    { preHandler: guard },
    async (request, reply) => {
      const id = NamespacedId.safeParse(decodeURIComponent(request.params.id));
      if (!id.success) throw new AppError('BAD_REQUEST', 'malformed comic id');

      const [comic, chapters] = await Promise.all([
        registry.getComic(id.data),
        registry.getChapters(id.data),
      ]);
      return reply.send(ChapterListResponse.parse({ comic, chapters }));
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/chapters/:id/pages',
    { preHandler: guard },
    async (request, reply) => {
      const id = NamespacedId.safeParse(decodeURIComponent(request.params.id));
      if (!id.success) throw new AppError('BAD_REQUEST', 'malformed chapter id');

      const pages = await registry.getPages(id.data);
      return reply.send(PageListResponse.parse({ chapterId: id.data, pages }));
    },
  );
}
