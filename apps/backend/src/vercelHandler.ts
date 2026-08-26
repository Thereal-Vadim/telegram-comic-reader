/**
 * Vercel serverless entry for the Fastify API.
 *
 * Cold-starts build the app once per isolate; subsequent invocations reuse it.
 * Image cache lives under /tmp (ephemeral, per-isolate).
 */
import { buildServer } from './server.js';

type NodeReq = import('node:http').IncomingMessage;
type NodeRes = import('node:http').ServerResponse;

const appPromise = buildServer({
  IMAGE_CACHE_DIR: process.env.IMAGE_CACHE_DIR || '/tmp/comic-images',
  // Vercel /tmp is small; keep the image cache well under the isolate limit.
  IMAGE_CACHE_MAX_BYTES: process.env.IMAGE_CACHE_MAX_BYTES || String(200 * 1024 * 1024),
  // Local CBZ library is not shipped in the Vercel image; com-x is the source.
  LOCAL_LIBRARY_DIR: process.env.LOCAL_LIBRARY_DIR || '',
}).then(async ({ app }) => {
  await app.ready();
  return app;
});

export const config = {
  maxDuration: 60,
};

export default async function handler(req: NodeReq, res: NodeRes): Promise<void> {
  const app = await appPromise;
  // Prefer the public URL when a rewrite stripped the path (safety net).
  const original =
    (typeof req.headers['x-forwarded-uri'] === 'string' && req.headers['x-forwarded-uri']) ||
    (typeof req.headers['x-invoke-path'] === 'string' && req.headers['x-invoke-path']);
  if (original && (!req.url || req.url === '/' || req.url.startsWith('/api/[['))) {
    const q = req.url?.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    req.url = original.includes('?') ? original : `${original}${q}`;
  }
  app.server.emit('request', req, res);
}
