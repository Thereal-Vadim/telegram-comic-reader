import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { verifyInitData } from '../src/auth/initData.js';
import { issueToken, verifyToken } from '../src/auth/jwt.js';
import { AppError } from '@comic/shared';

/**
 * These tests are the reason the auth code is worth having at all: an
 * initData verifier that accepts everything looks identical to one that works
 * until someone forges a request. Each case below is a way the check can be
 * silently wrong.
 */

const BOT_TOKEN = '123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

/** Produce a correctly signed initData string, the way Telegram would. */
function signInitData(
  fields: Record<string, string>,
  botToken = BOT_TOKEN,
): string {
  const dataCheckString = Object.keys(fields)
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join('\n');

  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');

  const params = new URLSearchParams(fields);
  params.set('hash', hash);
  return params.toString();
}

const validUser = JSON.stringify({ id: 42, first_name: 'Ada', username: 'ada' });
const nowSeconds = (): number => Math.floor(Date.now() / 1000);

describe('verifyInitData', () => {
  it('accepts a correctly signed payload and extracts the user', () => {
    const initData = signInitData({
      auth_date: String(nowSeconds()),
      query_id: 'AAF',
      user: validUser,
    });

    const result = verifyInitData(initData, { botToken: BOT_TOKEN, maxAgeSeconds: 86400 });

    expect(result.user.id).toBe(42);
    expect(result.user.firstName).toBe('Ada');
    expect(result.user.username).toBe('ada');
    expect(result.queryId).toBe('AAF');
  });

  it('rejects a payload whose hash was tampered with', () => {
    const initData = signInitData({ auth_date: String(nowSeconds()), user: validUser });
    // Flip one hex digit of the signature.
    const tampered = initData.replace(/hash=([0-9a-f])/, (_m, c: string) =>
      `hash=${c === 'a' ? 'b' : 'a'}`,
    );

    expect(() => verifyInitData(tampered, { botToken: BOT_TOKEN, maxAgeSeconds: 86400 })).toThrow(
      AppError,
    );
  });

  it('rejects a payload whose fields were edited after signing', () => {
    // The classic attack: keep a valid signature but swap the user id.
    const initData = signInitData({ auth_date: String(nowSeconds()), user: validUser });
    const forged = initData.replace(
      encodeURIComponent(validUser),
      encodeURIComponent(JSON.stringify({ id: 99999, first_name: 'Mallory' })),
    );

    expect(() => verifyInitData(forged, { botToken: BOT_TOKEN, maxAgeSeconds: 86400 })).toThrow(
      /signature does not verify/,
    );
  });

  it('rejects a payload signed with a different bot token', () => {
    const initData = signInitData(
      { auth_date: String(nowSeconds()), user: validUser },
      '999:DIFFERENTTOKEN',
    );

    expect(() => verifyInitData(initData, { botToken: BOT_TOKEN, maxAgeSeconds: 86400 })).toThrow(
      /signature does not verify/,
    );
  });

  it('rejects a payload older than the freshness window', () => {
    const initData = signInitData({
      auth_date: String(nowSeconds() - 7200),
      user: validUser,
    });

    expect(() => verifyInitData(initData, { botToken: BOT_TOKEN, maxAgeSeconds: 3600 })).toThrow(
      /expired/,
    );
  });

  it('rejects an auth_date far in the future', () => {
    // A valid signature over a future date would otherwise never expire.
    const initData = signInitData({
      auth_date: String(nowSeconds() + 99999),
      user: validUser,
    });

    expect(() => verifyInitData(initData, { botToken: BOT_TOKEN, maxAgeSeconds: 3600 })).toThrow(
      /in the future/,
    );
  });

  it('rejects a missing hash without throwing a length error', () => {
    const params = new URLSearchParams({ auth_date: String(nowSeconds()), user: validUser });
    expect(() =>
      verifyInitData(params.toString(), { botToken: BOT_TOKEN, maxAgeSeconds: 3600 }),
    ).toThrow(/missing its hash/);
  });

  it('rejects a non-hex hash rather than letting Buffer truncate it', () => {
    const initData = `auth_date=${nowSeconds()}&user=${encodeURIComponent(validUser)}&hash=zzzz`;
    expect(() => verifyInitData(initData, { botToken: BOT_TOKEN, maxAgeSeconds: 3600 })).toThrow(
      /sha256 hex digest/,
    );
  });

  it('rejects a signed payload that carries no user', () => {
    const initData = signInitData({ auth_date: String(nowSeconds()) });
    expect(() => verifyInitData(initData, { botToken: BOT_TOKEN, maxAgeSeconds: 3600 })).toThrow(
      /no user/,
    );
  });
});

describe('session tokens', () => {
  const SECRET = 'a-test-secret-that-is-at-least-32-characters-long';

  it('round-trips claims', () => {
    const { token, expiresAt } = issueToken({ sub: 42, username: 'ada' }, SECRET, 3600);
    const claims = verifyToken(token, SECRET);

    expect(claims.sub).toBe(42);
    expect(claims.username).toBe('ada');
    expect(expiresAt).toBeGreaterThan(Date.now());
  });

  it('rejects a token signed with a different secret', () => {
    const { token } = issueToken({ sub: 1, username: undefined }, SECRET, 3600);
    expect(() => verifyToken(token, 'another-secret-that-is-also-32-chars-long')).toThrow(AppError);
  });

  it('rejects an expired token', () => {
    const { token } = issueToken({ sub: 1, username: undefined }, SECRET, 60);
    // Verify as though two minutes have passed.
    expect(() => verifyToken(token, SECRET, () => Date.now() + 120_000)).toThrow(/expired/);
  });

  it('rejects an alg:none token', () => {
    // The header is compared against a fixed constant, so a token claiming a
    // different algorithm cannot match regardless of its payload.
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify({ sub: 1, exp: 9999999999 })).toString('base64url');

    expect(() => verifyToken(`${header}.${body}.`, SECRET)).toThrow(/unsupported/);
  });

  it('rejects a token with a mangled payload', () => {
    const { token } = issueToken({ sub: 1, username: undefined }, SECRET, 3600);
    const [header, , signature] = token.split('.');
    const swapped = Buffer.from(JSON.stringify({ sub: 999, exp: 9999999999 })).toString(
      'base64url',
    );

    expect(() => verifyToken(`${header}.${swapped}.${signature}`, SECRET)).toThrow(AppError);
  });
});
