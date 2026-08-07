import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { AppError } from '@comic/shared';

/**
 * Outbound fetch guard for the image proxy.
 *
 * Two independent checks, both required:
 *
 *  1. Host allowlist. Only origins implied by configured adapters (plus any
 *     explicitly listed extras) may be contacted at all.
 *  2. Post-resolution address check. The allowlist alone is not enough: a
 *     permitted hostname can have a DNS record pointing at 127.0.0.1 or
 *     169.254.169.254, so we resolve first and inspect the actual addresses.
 *
 * The resolved address is then pinned for the connection, which closes the
 * DNS-rebinding window between our check and Node's own lookup.
 */

/** Reserved ranges that must never be reachable through the proxy. */
function isBlockedIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  const [a, b] = parts as [number, number, number, number];
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true;
  }
  if (a === 0) return true; // "this network"
  if (a === 10) return true; // RFC1918
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 192 && b === 0) return true; // IETF protocol assignments
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast + reserved + broadcast
  return false;
}

function isBlockedIPv6(ip: string): boolean {
  const lower = ip.toLowerCase().split('%')[0] ?? '';
  if (lower === '::' || lower === '::1') return true; // unspecified, loopback
  // IPv4-mapped (::ffff:a.b.c.d) must be judged by its embedded IPv4 address.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped?.[1]) return isBlockedIPv4(mapped[1]);
  if (/^f[cd]/.test(lower)) return true; // unique local fc00::/7
  if (/^fe[89ab]/.test(lower)) return true; // link-local fe80::/10
  if (/^ff/.test(lower)) return true; // multicast
  return false;
}

export function isBlockedAddress(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) return isBlockedIPv4(ip);
  if (family === 6) return isBlockedIPv6(ip);
  return true; // not an IP literal at all - refuse
}

export interface GuardOptions {
  /** Lowercased hostnames permitted as proxy targets. */
  readonly allowedHosts: ReadonlySet<string>;
  /** Skip the private-range check (LAN OPDS servers). */
  readonly allowPrivate: boolean;
  /**
   * When true, any public host is accepted (host allowlist skipped).
   * Used only for user-initiated personal imports — private ranges are
   * still refused so this cannot become an SSRF pivot into the LAN.
   */
  readonly allowAnyPublicHost?: boolean;
}

/** Match `host` against the allowlist, honouring a leading `*.` wildcard. */
export function isHostAllowed(host: string, allowedHosts: ReadonlySet<string>): boolean {
  const h = host.toLowerCase();
  if (allowedHosts.has(h)) return true;
  for (const entry of allowedHosts) {
    if (entry.startsWith('*.')) {
      const suffix = entry.slice(1); // ".example.com"
      if (h.endsWith(suffix) && h.length > suffix.length) return true;
    }
  }
  return false;
}

export interface SafeTarget {
  readonly url: URL;
  /** Literal address the request must connect to, pinned against rebinding. */
  readonly address: string;
  readonly family: 4 | 6;
}

/**
 * Validate a candidate URL and resolve it to a single safe address.
 * Throws {@link AppError} with ORIGIN_NOT_ALLOWED for anything suspect.
 */
export async function resolveSafeTarget(rawUrl: string, opts: GuardOptions): Promise<SafeTarget> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new AppError('ORIGIN_NOT_ALLOWED', 'upstream url is not parseable');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AppError('ORIGIN_NOT_ALLOWED', `unsupported protocol "${url.protocol}"`);
  }
  if (url.username || url.password) {
    // Credentials in the URL would be forwarded verbatim; force explicit config.
    throw new AppError('ORIGIN_NOT_ALLOWED', 'credentials in upstream url are not permitted');
  }
  if (!opts.allowAnyPublicHost && !isHostAllowed(url.hostname, opts.allowedHosts)) {
    throw new AppError('ORIGIN_NOT_ALLOWED', `host "${url.hostname}" is not on the proxy allowlist`);
  }

  // An IP literal needs no lookup, but still needs the range check.
  const literal = net.isIP(url.hostname);
  if (literal !== 0) {
    if (!opts.allowPrivate && isBlockedAddress(url.hostname)) {
      throw new AppError('ORIGIN_NOT_ALLOWED', 'upstream address is in a reserved range');
    }
    return { url, address: url.hostname, family: literal === 6 ? 6 : 4 };
  }

  let records: { address: string; family: number }[];
  try {
    records = await dns.lookup(url.hostname, { all: true, verbatim: true });
  } catch {
    throw new AppError('UPSTREAM_UNAVAILABLE', `could not resolve "${url.hostname}"`);
  }
  if (records.length === 0) {
    throw new AppError('UPSTREAM_UNAVAILABLE', `no addresses for "${url.hostname}"`);
  }

  // Reject if *any* record is private. Picking only the public ones would let
  // an attacker keep a benign record alongside a malicious one and race us.
  if (!opts.allowPrivate) {
    for (const r of records) {
      if (isBlockedAddress(r.address)) {
        throw new AppError(
          'ORIGIN_NOT_ALLOWED',
          `"${url.hostname}" resolves to a reserved address`,
        );
      }
    }
  }

  const chosen = records[0]!;
  return { url, address: chosen.address, family: chosen.family === 6 ? 6 : 4 };
}

/**
 * Fetch a validated target with the resolved address pinned.
 *
 * The TCP connection goes to the address we vetted, while TLS SNI and the Host
 * header keep the original hostname so certificates still validate. Rewriting
 * the URL to the bare IP and calling `fetch` looks simpler but breaks TLS:
 * undici validates the certificate against the URL hostname, which would then
 * be an address, and archive.org (among others) fails closed.
 */
export async function safeFetch(
  target: SafeTarget,
  init: {
    headers?: Record<string, string>;
    timeoutMs: number;
    maxBytes: number;
    /** Override Accept; archive downloads are not images. */
    accept?: string;
  },
): Promise<{ body: Buffer; contentType: string | null }> {
  const lib = target.url.protocol === 'https:' ? https : http;
  const headers: Record<string, string> = {
    ...init.headers,
    host: target.url.host,
    accept: init.accept ?? init.headers?.['accept'] ?? init.headers?.['Accept'] ?? 'image/*',
  };

  return await new Promise<{ body: Buffer; contentType: string | null }>((resolve, reject) => {
    const req = lib.request(
      {
        protocol: target.url.protocol,
        // Connect to the vetted address, not whatever DNS returns next.
        hostname: target.address,
        family: target.family,
        // SNI + cert validation still use the real name.
        servername: target.url.hostname,
        port: target.url.port || (target.url.protocol === 'https:' ? 443 : 80),
        path: `${target.url.pathname}${target.url.search}`,
        method: 'GET',
        headers,
        timeout: init.timeoutMs,
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400) {
          const location = res.headers.location;
          res.resume();
          const err = Object.assign(
            new AppError('ORIGIN_NOT_ALLOWED', 'upstream redirected; redirects are not followed'),
            { redirectLocation: typeof location === 'string' ? location : undefined },
          );
          reject(err);
          return;
        }

        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          reject(new AppError('UPSTREAM_UNAVAILABLE', `upstream responded ${res.statusCode ?? 0}`));
          return;
        }

        const declared = Number(res.headers['content-length'] ?? '0');
        if (declared > init.maxBytes) {
          res.destroy();
          reject(new AppError('UPSTREAM_MALFORMED', 'upstream body exceeds the size limit'));
          return;
        }

        const chunks: Buffer[] = [];
        let total = 0;
        res.on('data', (chunk: Buffer) => {
          total += chunk.byteLength;
          if (total > init.maxBytes) {
            res.destroy();
            reject(new AppError('UPSTREAM_MALFORMED', 'upstream body exceeds the size limit'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          const contentType = res.headers['content-type'];
          resolve({
            body: Buffer.concat(chunks),
            contentType: typeof contentType === 'string' ? contentType : null,
          });
        });
        res.on('error', (err) => {
          reject(new AppError('UPSTREAM_UNAVAILABLE', `upstream fetch failed: ${String(err)}`));
        });
      },
    );

    req.on('timeout', () => {
      req.destroy();
      reject(new AppError('UPSTREAM_UNAVAILABLE', 'upstream timed out', 5_000));
    });
    req.on('error', (err) => {
      if (err instanceof AppError) reject(err);
      else reject(new AppError('UPSTREAM_UNAVAILABLE', `upstream fetch failed: ${String(err)}`));
    });
    req.end();
  });
}

/**
 * Follow a bounded chain of redirects, re-validating every hop.
 *
 * Used for hosts that front their CDN with a 302 (archive.org download URLs).
 * Each Location is resolved through {@link resolveSafeTarget} before the next
 * request, so a redirect into a reserved address or off the allowlist is
 * refused the same way a direct request would be.
 */
export async function safeFetchFollowingRedirects(
  rawUrl: string,
  opts: GuardOptions,
  init: {
    headers?: Record<string, string>;
    timeoutMs: number;
    maxBytes: number;
    accept?: string;
    maxHops?: number;
  },
): Promise<{ body: Buffer; contentType: string | null }> {
  const maxHops = init.maxHops ?? 5;
  let current = rawUrl;

  for (let hop = 0; hop <= maxHops; hop++) {
    const target = await resolveSafeTarget(current, opts);
    try {
      return await safeFetch(target, init);
    } catch (err) {
      const location =
        err instanceof AppError
          ? (err as AppError & { redirectLocation?: string }).redirectLocation
          : undefined;
      if (!location || hop === maxHops) throw err;
      current = new URL(location, current).toString();
    }
  }

  throw new AppError('ORIGIN_NOT_ALLOWED', 'too many upstream redirects');
}
