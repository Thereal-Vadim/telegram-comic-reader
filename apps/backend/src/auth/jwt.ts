import crypto from 'node:crypto';
import { AppError } from '@comic/shared';

/**
 * Minimal HS256 JWT implementation.
 *
 * We issue exactly one token shape to our own Mini App and verify it in one
 * place, so pulling in a general-purpose JWT library would add a dependency
 * (and its algorithm-confusion footguns) for about forty lines of work. The
 * algorithm is fixed at HS256 and the header is never consulted when
 * verifying, which structurally rules out `alg: none` and RS/HS confusion.
 */

export interface SessionClaims {
  /** Telegram user id. */
  sub: number;
  username: string | undefined;
  /** Issued-at and expiry, epoch seconds. */
  iat: number;
  exp: number;
}

const b64url = (buf: Buffer): string => buf.toString('base64url');
const b64urlJson = (value: unknown): string => b64url(Buffer.from(JSON.stringify(value), 'utf8'));

const FIXED_HEADER = b64urlJson({ alg: 'HS256', typ: 'JWT' });

function sign(secret: string, payload: string): string {
  return b64url(crypto.createHmac('sha256', secret).update(payload).digest());
}

export function issueToken(
  claims: Omit<SessionClaims, 'iat' | 'exp'>,
  secret: string,
  ttlSeconds: number,
  now: () => number = Date.now,
): { token: string; expiresAt: number } {
  const iat = Math.floor(now() / 1000);
  const exp = iat + ttlSeconds;
  const body = b64urlJson({ ...claims, iat, exp } satisfies SessionClaims);
  const signingInput = `${FIXED_HEADER}.${body}`;
  return { token: `${signingInput}.${sign(secret, signingInput)}`, expiresAt: exp * 1000 };
}

export function verifyToken(
  token: string,
  secret: string,
  now: () => number = Date.now,
): SessionClaims {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new AppError('UNAUTHORIZED', 'session token is malformed');
  }
  const [header, body, signature] = parts as [string, string, string];

  // The header is compared to our own constant rather than parsed, so a token
  // claiming a different algorithm simply fails to match.
  if (header !== FIXED_HEADER) {
    throw new AppError('UNAUTHORIZED', 'unsupported session token header');
  }

  const expected = Buffer.from(sign(secret, `${header}.${body}`), 'utf8');
  const provided = Buffer.from(signature, 'utf8');
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
    throw new AppError('UNAUTHORIZED', 'session token signature does not verify');
  }

  let claims: SessionClaims;
  try {
    claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SessionClaims;
  } catch {
    throw new AppError('UNAUTHORIZED', 'session token payload is not valid JSON');
  }

  if (typeof claims.sub !== 'number' || typeof claims.exp !== 'number') {
    throw new AppError('UNAUTHORIZED', 'session token is missing required claims');
  }
  if (Math.floor(now() / 1000) >= claims.exp) {
    throw new AppError('UNAUTHORIZED', 'session token has expired');
  }
  return claims;
}
