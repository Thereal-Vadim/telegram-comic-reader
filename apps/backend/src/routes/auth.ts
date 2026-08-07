import type { FastifyInstance } from 'fastify';
import { AppError, AuthRequest, type AuthResponse, type TelegramUser } from '@comic/shared';
import { verifyInitData } from '../auth/initData.js';
import { issueToken, verifyToken, type SessionClaims } from '../auth/jwt.js';
import type { Config } from '../config.js';

declare module 'fastify' {
  interface FastifyRequest {
    session?: SessionClaims;
  }
}

export function registerAuthRoutes(app: FastifyInstance, cfg: Config): void {
  /**
   * Exchange a Telegram launch payload for a session token.
   *
   * initData is verified once here and then discarded; every later request
   * carries our own short-lived JWT instead. That keeps the bot-token HMAC off
   * the hot path and means a stolen token expires on its own.
   */
  app.post('/api/auth/telegram', async (request, reply) => {
    const parsed = AuthRequest.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError('BAD_REQUEST', 'expected a JSON body with an initData string');
    }

    let user: TelegramUser;

    if (cfg.telegramBotToken) {
      const verified = verifyInitData(parsed.data.initData, {
        botToken: cfg.telegramBotToken,
        maxAgeSeconds: cfg.initDataMaxAgeSeconds,
      });
      user = verified.user;
    } else if (cfg.insecureDevAuth) {
      // Development only. loadConfig refuses to reach this state in production.
      app.log.warn('TELEGRAM_BOT_TOKEN is unset - issuing an unverified development session');
      user = { id: 0, firstName: 'Dev', username: 'dev' };
    } else {
      throw new AppError('INTERNAL', 'server is missing its Telegram bot token');
    }

    const { token, expiresAt } = issueToken(
      { sub: user.id, username: user.username },
      cfg.jwtSecret,
      cfg.jwtTtlSeconds,
    );

    const body: AuthResponse = { token, expiresAt, user };
    return reply.send(body);
  });
}

/**
 * Bearer-token guard for the catalog routes.
 *
 * Image requests are deliberately exempt: `<img>` and `createImageBitmap`
 * cannot attach an Authorization header, so gating them on a bearer token
 * would mean rewriting every image load into a fetch-plus-blob dance. The
 * image route is instead protected by the proxy allowlist and rate limiting,
 * and serves only content the configured adapters already expose.
 */
export function requireSession(cfg: Config) {
  return async function (request: import('fastify').FastifyRequest): Promise<void> {
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new AppError('UNAUTHORIZED', 'missing bearer token');
    }
    request.session = verifyToken(header.slice('Bearer '.length), cfg.jwtSecret);
  };
}
