import type { FastifyInstance } from 'fastify';
import { AppError, ComxConnectRequest, ComxSessionStatus } from '@comic/shared';
import type { ComxAdapter } from '../adapters/comxAdapter.js';

/**
 * Dedicated com-x.life endpoints (session / catalog / search / comic / chapter).
 *
 * The same adapter also implements ProviderAdapter, so Home / Search / Reader
 * work through the normal `/api/home`, `/api/search`, `/api/comics/:id` routes.
 * These paths are for direct clients and connecting an account from the Mini App.
 */
export function registerComxRoutes(
  app: FastifyInstance,
  adapter: ComxAdapter,
  guard: (req: import('fastify').FastifyRequest) => Promise<void>,
): void {
  app.get('/api/comx/session', { preHandler: guard }, async (_request, reply) => {
    return reply.send(ComxSessionStatus.parse(adapter.sessionStatus()));
  });

  app.post('/api/comx/session', { preHandler: guard }, async (request, reply) => {
    const parsed = ComxConnectRequest.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError('BAD_REQUEST', `invalid comx credentials: ${parsed.error.message}`);
    }
    const status = await adapter.connectAccount(parsed.data);
    return reply.send(ComxSessionStatus.parse(status));
  });

  app.delete('/api/comx/session', { preHandler: guard }, async (_request, reply) => {
    return reply.send(ComxSessionStatus.parse(adapter.disconnectAccount()));
  });

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
      return reply.send({ items: [], currentPage: 1, totalPages: 1, hasNextPage: false });
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
