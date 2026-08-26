import { describe, expect, it } from 'vitest';
import zlib from 'node:zlib';
import { decodeContentEncoding, isBlockedAddress, isHostAllowed, resolveSafeTarget } from '../src/net/ssrf.js';
import { AppError } from '@comic/shared';

/**
 * The image proxy is the one component that makes outbound requests on behalf
 * of a caller, which makes it the natural SSRF pivot in this service. The
 * cases below are the ones an allowlist alone does not cover.
 */

describe('isBlockedAddress', () => {
  it.each([
    ['127.0.0.1', 'loopback'],
    ['0.0.0.0', 'this network'],
    ['10.1.2.3', 'RFC1918 class A'],
    ['172.16.0.1', 'RFC1918 class B lower bound'],
    ['172.31.255.255', 'RFC1918 class B upper bound'],
    ['192.168.1.1', 'RFC1918 class C'],
    ['169.254.169.254', 'cloud metadata endpoint'],
    ['100.64.0.1', 'carrier-grade NAT'],
    ['224.0.0.1', 'multicast'],
    ['::1', 'IPv6 loopback'],
    ['fd00::1', 'IPv6 unique local'],
    ['fe80::1', 'IPv6 link-local'],
    ['::ffff:127.0.0.1', 'IPv4-mapped loopback'],
  ])('blocks %s (%s)', (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each([['8.8.8.8'], ['1.1.1.1'], ['93.184.216.34'], ['2606:2800:220:1:248:1893:25c8:1946']])(
    'allows the public address %s',
    (address) => {
      expect(isBlockedAddress(address)).toBe(false);
    },
  );

  it('treats 172.32.x.x as public, just outside the RFC1918 range', () => {
    // Off-by-one in this boundary is a common way to accidentally block or
    // allow the wrong half of the 172 space.
    expect(isBlockedAddress('172.32.0.1')).toBe(false);
    expect(isBlockedAddress('172.15.255.255')).toBe(false);
  });

  it('refuses anything that is not an IP literal', () => {
    expect(isBlockedAddress('example.com')).toBe(true);
    expect(isBlockedAddress('')).toBe(true);
  });
});

describe('isHostAllowed', () => {
  it('matches exact hosts case-insensitively', () => {
    const allow = new Set(['books.example.com']);
    expect(isHostAllowed('books.example.com', allow)).toBe(true);
    expect(isHostAllowed('BOOKS.EXAMPLE.COM', allow)).toBe(true);
    expect(isHostAllowed('other.example.com', allow)).toBe(false);
  });

  it('supports a leading wildcard but does not match the bare domain', () => {
    const allow = new Set(['*.example.com']);
    expect(isHostAllowed('cdn.example.com', allow)).toBe(true);
    expect(isHostAllowed('a.b.example.com', allow)).toBe(true);
    expect(isHostAllowed('example.com', allow)).toBe(false);
  });

  it('does not let a suffix match a different registrable domain', () => {
    // "evil-example.com" ends with "example.com" as a string but is a
    // different domain entirely; the leading dot is what prevents this.
    const allow = new Set(['*.example.com']);
    expect(isHostAllowed('evilexample.com', allow)).toBe(false);
    expect(isHostAllowed('notexample.com', allow)).toBe(false);
  });
});

describe('resolveSafeTarget', () => {
  const guard = { allowedHosts: new Set(['example.com']), allowPrivate: false };

  it('rejects a host that is not on the allowlist', async () => {
    await expect(resolveSafeTarget('https://elsewhere.com/a.jpg', guard)).rejects.toThrow(
      /not on the proxy allowlist/,
    );
  });

  it('rejects non-http protocols', async () => {
    // file:// would read local disk; gopher:// and friends enable protocol
    // smuggling against internal services.
    await expect(resolveSafeTarget('file:///etc/passwd', guard)).rejects.toThrow(
      /unsupported protocol/,
    );
  });

  it('rejects credentials embedded in the URL', async () => {
    await expect(
      resolveSafeTarget('https://user:pass@example.com/a.jpg', guard),
    ).rejects.toThrow(/credentials/);
  });

  it('rejects an allowlisted IP literal that is private', async () => {
    const localGuard = { allowedHosts: new Set(['127.0.0.1']), allowPrivate: false };
    await expect(resolveSafeTarget('http://127.0.0.1/a.jpg', localGuard)).rejects.toThrow(
      /reserved range/,
    );
  });

  it('permits a private literal when explicitly opted in', async () => {
    // The LAN-OPDS escape hatch, which must be off by default.
    const localGuard = { allowedHosts: new Set(['192.168.1.50']), allowPrivate: true };
    const target = await resolveSafeTarget('http://192.168.1.50:8080/a.jpg', localGuard);
    expect(target.address).toBe('192.168.1.50');
  });

  it('rejects unparseable input', async () => {
    await expect(resolveSafeTarget('not a url', guard)).rejects.toBeInstanceOf(AppError);
  });
});

describe('decodeContentEncoding', () => {
  it('gunzips bodies that arrive with content-encoding: gzip', () => {
    const html = '<html><title>Com-X</title></html>';
    const gz = zlib.gzipSync(html);
    expect(decodeContentEncoding(gz, 'gzip').toString('utf8')).toBe(html);
  });

  it('gunzips bodies that look like gzip even without the header', () => {
    const html = '<a class="poster" href="/1-x.html">x</a>';
    const gz = zlib.gzipSync(html);
    expect(decodeContentEncoding(gz, undefined).toString('utf8')).toBe(html);
  });

  it('leaves plain HTML alone', () => {
    const html = Buffer.from('<html>plain</html>');
    expect(decodeContentEncoding(html, undefined).equals(html)).toBe(true);
  });
});
