import type { FastifyInstance } from 'fastify';
import { AppError } from '@comic/shared';
import type { ComxAdapter } from '../adapters/comxAdapter.js';

/**
 * Dedicated com-x.life endpoints (catalog / search / comic / chapter).
 *
 * The same adapter also implements ProviderAdapter, so Home / Search / Reader
 * work through the normal `/api/home`, `/api/search`, `/api/comics/:id` routes.
 * These paths are for direct clients and debugging.
 */
export function registerComxRoutes(
  app: FastifyInstance,
  adapter: ComxAdapter,
  guard: (req: import('fastify').FastifyRequest) => Promise<void>,
): void {
  app.get('/api/comx/catalog', { preHandler: guard }, async (request, reply) => {
    const query = request.query as { page?: string; category?: string };
    const pageNum = Number.parseInt(query.page || '1', 10);
    if (!Number.isFinite(pageNum) || pageNum < 1) {
      throw new AppError('BAD_REQUEST', 'page must be a positive integer');
    }
    const result = await adapter.getCatalog(pageNum, query.category);
    return reply.send(result);
  });

  app.get('/api/comx/search', { preHandler: guard }, async (request, reply) => {
    const query = request.query as { q?: string; page?: string };
    if (!query.q?.trim()) {
      throw new AppError('BAD_REQUEST', 'query parameter "q" is required');
    }
    const pageNum = Number.parseInt(query.page || '1', 10);
    if (!Number.isFinite(pageNum) || pageNum < 1) {
      throw new AppError('BAD_REQUEST', 'page must be a positive integer');
    }
    const result = await adapter.searchCatalog(query.q.trim(), pageNum);
    return reply.send(result);
  });

  app.get('/api/comx/comic', { preHandler: guard }, async (request, reply) => {
    const query = request.query as { url?: string };
    if (!query.url?.trim()) {
      throw new AppError('BAD_REQUEST', 'query parameter "url" is required');
    }
    const result = await adapter.getComicDetails(query.url.trim());
    return reply.send(result);
  });

  app.get('/api/comx/chapter', { preHandler: guard }, async (request, reply) => {
    const query = request.query as { url?: string };
    if (!query.url?.trim()) {
      throw new AppError('BAD_REQUEST', 'query parameter "url" is required');
    }
    const result = await adapter.getChapterPages(query.url.trim());
    return reply.send(result);
  });
}
