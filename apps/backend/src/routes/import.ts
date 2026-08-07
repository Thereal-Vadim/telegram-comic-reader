import type { FastifyInstance } from 'fastify';
import {
  AppError,
  ChapterListResponse,
  ImportListResponse,
  ImportRequest,
  ImportResult,
  makeNamespacedId,
  NamespacedId,
} from '@comic/shared';
import type { ImportAdapter } from '../adapters/import.js';
import type { AdapterRegistry } from '../adapters/registry.js';

/**
 * Personal URL import endpoints.
 *
 * Authenticated: every import is owned by the Telegram user in the session.
 * After a successful import the client is expected to enqueue an offline
 * download so subsequent opens never touch the origin again.
 */
export function registerImportRoutes(
  app: FastifyInstance,
  deps: {
    imports: ImportAdapter;
    registry: AdapterRegistry;
    guard: (req: import('fastify').FastifyRequest) => Promise<void>;
  },
): void {
  const { imports, registry, guard } = deps;

  app.get('/api/import', { preHandler: guard }, async (request, reply) => {
    const ownerId = request.session?.sub;
    if (ownerId === undefined) throw new AppError('UNAUTHORIZED', 'missing session');

    const records = await imports.listForOwner(ownerId);
    const items = [];
    for (const rec of records) {
      const encodedId = Buffer.from(rec.id, 'utf8').toString('base64url');
      const comic = await registry.getComic(makeNamespacedId('import', encodedId));
      items.push({
        comic,
        kind: rec.kind,
        sourceUrl: rec.sourceUrl,
        createdAt: rec.createdAt,
        pageCount: rec.pageCount,
      });
    }
    return reply.send(ImportListResponse.parse({ items }));
  });

  app.post('/api/import', { preHandler: guard }, async (request, reply) => {
    const ownerId = request.session?.sub;
    if (ownerId === undefined) throw new AppError('UNAUTHORIZED', 'missing session');

    const parsed = ImportRequest.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError('BAD_REQUEST', `invalid import body: ${parsed.error.message}`);
    }

    // Imports pull potentially large archives; tighten the per-route budget.
    // The global rate limiter still applies on top.
    const { record, encodedId } = await imports.importUrl({
      ownerId,
      url: parsed.data.url,
      ...(parsed.data.title !== undefined ? { title: parsed.data.title } : {}),
    });

    const namespacedId = makeNamespacedId('import', encodedId);
    const [comic, chapters] = await Promise.all([
      registry.getComic(namespacedId),
      registry.getChapters(namespacedId),
    ]);

    return reply.send(
      ImportResult.parse({
        comic,
        chapters,
        kind: record.kind,
        sourceUrl: record.sourceUrl,
        offlineQueued: false,
      }),
    );
  });

  app.delete<{ Params: { id: string } }>(
    '/api/import/:id',
    { preHandler: guard },
    async (request, reply) => {
      const ownerId = request.session?.sub;
      if (ownerId === undefined) throw new AppError('UNAUTHORIZED', 'missing session');

      const id = NamespacedId.safeParse(decodeURIComponent(request.params.id));
      if (!id.success) {
        // Also accept a bare local (base64url) id from the Sources UI.
        const bare = decodeURIComponent(request.params.id);
        if (!bare || bare.includes(':')) {
          throw new AppError('BAD_REQUEST', 'malformed import id');
        }
        await imports.deleteForOwner(ownerId, bare);
        return reply.code(204).send();
      }

      const { adapterId, localId } = (() => {
        const sep = id.data.indexOf(':');
        return { adapterId: id.data.slice(0, sep), localId: id.data.slice(sep + 1) };
      })();
      if (adapterId !== 'import') {
        throw new AppError('BAD_REQUEST', 'id is not an import');
      }
      await imports.deleteForOwner(ownerId, localId);
      return reply.code(204).send();
    },
  );

  // Convenience: comic+chapters shape for a single import (mirrors catalog).
  app.get<{ Params: { id: string } }>(
    '/api/import/:id',
    { preHandler: guard },
    async (request, reply) => {
      const ownerId = request.session?.sub;
      if (ownerId === undefined) throw new AppError('UNAUTHORIZED', 'missing session');

      const raw = decodeURIComponent(request.params.id);
      const namespaced = raw.includes(':') ? raw : makeNamespacedId('import', raw);
      const id = NamespacedId.safeParse(namespaced);
      if (!id.success) throw new AppError('BAD_REQUEST', 'malformed import id');

      // Ownership check before serving.
      const localId = id.data.slice(id.data.indexOf(':') + 1);
      const owned = await imports.listForOwner(ownerId);
      const match = owned.find(
        (r) => Buffer.from(r.id, 'utf8').toString('base64url') === localId,
      );
      if (!match) throw new AppError('NOT_FOUND', 'no such import');

      const [comic, chapters] = await Promise.all([
        registry.getComic(id.data),
        registry.getChapters(id.data),
      ]);
      return reply.send(ChapterListResponse.parse({ comic, chapters }));
    },
  );
}
