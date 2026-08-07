import crypto from 'node:crypto';
import { AppError, type TelegramUser } from '@comic/shared';

/**
 * Verification of `Telegram.WebApp.initData`.
 *
 * Telegram signs the launch payload so a backend can trust the user id without
 * a round trip. The scheme (documented under "Validating data received via the
 * Mini App"):
 *
 *   secret     = HMAC_SHA256(key = "WebAppData", message = bot_token)
 *   check_hash = HMAC_SHA256(key = secret, message = data_check_string)
 *
 * where `data_check_string` is every field except `hash`, formatted as
 * `key=value`, sorted by key, joined with newlines.
 *
 * Note the key/message inversion in the first step: the literal string
 * "WebAppData" is the *key* and the bot token is the *message*. Swapping them
 * produces a stable-looking digest that never matches, which is the usual way
 * this gets implemented wrong.
 */

export interface VerifiedInitData {
  readonly user: TelegramUser;
  readonly authDate: Date;
  readonly queryId: string | undefined;
  readonly startParam: string | undefined;
}

function deriveSecretKey(botToken: string): Buffer {
  return crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
}

/**
 * Build the check string. `URLSearchParams` has already percent-decoded the
 * values, which is what Telegram signs, so we must not re-encode them here.
 */
function buildDataCheckString(params: URLSearchParams): string {
  const pairs: string[] = [];
  for (const [key, value] of params.entries()) {
    if (key === 'hash') continue;
    pairs.push(`${key}=${value}`);
  }
  pairs.sort();
  return pairs.join('\n');
}

const TelegramUserPayload = (raw: unknown): TelegramUser => {
  if (typeof raw !== 'object' || raw === null) {
    throw new AppError('UNAUTHORIZED', 'initData user payload is not an object');
  }
  const u = raw as Record<string, unknown>;
  if (typeof u['id'] !== 'number' || typeof u['first_name'] !== 'string') {
    throw new AppError('UNAUTHORIZED', 'initData user payload is missing id or first_name');
  }
  return {
    id: u['id'],
    firstName: u['first_name'],
    ...(typeof u['last_name'] === 'string' ? { lastName: u['last_name'] } : {}),
    ...(typeof u['username'] === 'string' ? { username: u['username'] } : {}),
    ...(typeof u['language_code'] === 'string' ? { languageCode: u['language_code'] } : {}),
    ...(typeof u['photo_url'] === 'string' ? { photoUrl: u['photo_url'] } : {}),
    ...(typeof u['is_premium'] === 'boolean' ? { isPremium: u['is_premium'] } : {}),
  };
};

export interface VerifyOptions {
  readonly botToken: string;
  readonly maxAgeSeconds: number;
  /** Injectable for deterministic tests. */
  readonly now?: () => number;
}

export function verifyInitData(initData: string, opts: VerifyOptions): VerifiedInitData {
  const params = new URLSearchParams(initData);

  const providedHash = params.get('hash');
  if (!providedHash) {
    throw new AppError('UNAUTHORIZED', 'initData is missing its hash field');
  }
  // Reject non-hex up front: Buffer.from would silently truncate, and a
  // truncated buffer compared with timingSafeEqual throws on length mismatch.
  if (!/^[0-9a-f]{64}$/i.test(providedHash)) {
    throw new AppError('UNAUTHORIZED', 'initData hash is not a sha256 hex digest');
  }

  const secret = deriveSecretKey(opts.botToken);
  const expected = crypto
    .createHmac('sha256', secret)
    .update(buildDataCheckString(params))
    .digest();

  const provided = Buffer.from(providedHash, 'hex');
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
    throw new AppError('UNAUTHORIZED', 'initData signature does not verify');
  }

  // A valid signature is permanent, so freshness is what bounds replay.
  const authDateRaw = params.get('auth_date');
  const authDateSec = Number(authDateRaw);
  if (!authDateRaw || !Number.isFinite(authDateSec) || authDateSec <= 0) {
    throw new AppError('UNAUTHORIZED', 'initData auth_date is missing or malformed');
  }
  const nowMs = (opts.now ?? Date.now)();
  const ageSeconds = nowMs / 1000 - authDateSec;
  if (ageSeconds > opts.maxAgeSeconds) {
    throw new AppError('UNAUTHORIZED', 'initData has expired; relaunch the Mini App');
  }
  // Small negative ages are ordinary clock skew; large ones mean a forged date.
  if (ageSeconds < -300) {
    throw new AppError('UNAUTHORIZED', 'initData auth_date is in the future');
  }

  const userRaw = params.get('user');
  if (!userRaw) {
    // Happens when the app is opened from an inline context with no user scope.
    throw new AppError('UNAUTHORIZED', 'initData contains no user; open the app from a chat');
  }

  let parsedUser: unknown;
  try {
    parsedUser = JSON.parse(userRaw);
  } catch {
    throw new AppError('UNAUTHORIZED', 'initData user field is not valid JSON');
  }

  return {
    user: TelegramUserPayload(parsedUser),
    authDate: new Date(authDateSec * 1000),
    queryId: params.get('query_id') ?? undefined,
    startParam: params.get('start_param') ?? undefined,
  };
}
