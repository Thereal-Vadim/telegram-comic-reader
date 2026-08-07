import { AppError } from '@comic/shared';

/**
 * Classify and normalise a user-pasted URL into something the importer can fetch.
 *
 * Cloud share links almost never point at the raw bytes: Google Drive serves an
 * interstitial, Dropbox defaults to a preview page, OneDrive wraps the file in
 * a viewer. Each provider has a well-known "force download" form that we rewrite
 * into before hitting the network.
 */

export type ImportSourceKind = 'archive' | 'web' | 'unsupported';

export interface ResolvedImportUrl {
  /** URL the fetcher should actually request. */
  readonly fetchUrl: string;
  /** Original user-facing URL, kept for display and dedupe. */
  readonly sourceUrl: string;
  readonly provider: 'google-drive' | 'dropbox' | 'onedrive' | 'direct' | 'web';
  /** Best-effort filename hint from the URL path. */
  readonly filenameHint: string | null;
  /**
   * Hint about what we expect. `web` means "fetch as HTML and extract images";
   * `archive` means "treat the response body as a comic container".
   * Final classification still inspects Content-Type / magic bytes after fetch.
   */
  readonly expected: ImportSourceKind;
}

const ARCHIVE_EXT = /\.(cbz|zip|cbr|rar|pdf)(?:$|[?#])/i;

function filenameFromPath(url: URL): string | null {
  const seg = url.pathname.split('/').filter(Boolean).pop();
  if (!seg) return null;
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

/** Extract a Google Drive file id from the common share / open / uc forms. */
export function extractGoogleDriveFileId(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (host !== 'drive.google.com' && host !== 'docs.google.com') return null;

  const fileMatch = /\/file\/d\/([a-zA-Z0-9_-]+)/.exec(url.pathname);
  if (fileMatch?.[1]) return fileMatch[1];

  const openId = url.searchParams.get('id');
  if (openId && /^[a-zA-Z0-9_-]+$/.test(openId)) return openId;

  const ucId = url.searchParams.get('id');
  if (url.pathname.includes('/uc') && ucId) return ucId;

  return null;
}

/** Dropbox share links need `dl=1` (or the content CDN host) to yield bytes. */
export function toDropboxDirectUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (host === 'www.dropbox.com' || host === 'dropbox.com') {
    url.searchParams.set('dl', '1');
    return url.toString();
  }
  if (host === 'dl.dropboxusercontent.com') return url.toString();
  // Shared folder / scl links also accept dl=1.
  if (host.endsWith('.dropbox.com')) {
    url.searchParams.set('dl', '1');
    return url.toString();
  }
  return null;
}

/**
 * OneDrive / 1drv.ms share links. The `download=1` query forces the binary
 * rather than the web viewer for most modern sharing URLs.
 */
export function toOneDriveDirectUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (
    host === '1drv.ms' ||
    host === 'onedrive.live.com' ||
    host.endsWith('.sharepoint.com') ||
    host === 'my.microsoftpersonalcontent.com'
  ) {
    url.searchParams.set('download', '1');
    return url.toString();
  }
  return null;
}

export function resolveImportUrl(raw: string): ResolvedImportUrl {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new AppError('BAD_REQUEST', 'import url is not parseable');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AppError('BAD_REQUEST', 'only http(s) import urls are supported');
  }
  if (url.username || url.password) {
    throw new AppError('BAD_REQUEST', 'credentials in import url are not permitted');
  }

  const sourceUrl = url.toString();
  const filenameHint = filenameFromPath(url);

  const driveId = extractGoogleDriveFileId(sourceUrl);
  if (driveId) {
    return {
      fetchUrl: `https://drive.google.com/uc?export=download&id=${encodeURIComponent(driveId)}`,
      sourceUrl,
      provider: 'google-drive',
      filenameHint: filenameHint && ARCHIVE_EXT.test(filenameHint) ? filenameHint : null,
      expected: 'archive',
    };
  }

  const dropbox = toDropboxDirectUrl(sourceUrl);
  if (dropbox) {
    return {
      fetchUrl: dropbox,
      sourceUrl,
      provider: 'dropbox',
      filenameHint,
      expected: filenameHint && ARCHIVE_EXT.test(filenameHint) ? 'archive' : 'archive',
    };
  }

  const onedrive = toOneDriveDirectUrl(sourceUrl);
  if (onedrive) {
    return {
      fetchUrl: onedrive,
      sourceUrl,
      provider: 'onedrive',
      filenameHint,
      expected: 'archive',
    };
  }

  if (filenameHint && ARCHIVE_EXT.test(filenameHint)) {
    return {
      fetchUrl: sourceUrl,
      sourceUrl,
      provider: 'direct',
      filenameHint,
      expected: 'archive',
    };
  }

  // Default: treat as a web page of sequential images. Direct binary responses
  // are still detected after fetch via Content-Type / magic bytes.
  return {
    fetchUrl: sourceUrl,
    sourceUrl,
    provider: 'web',
    filenameHint,
    expected: 'web',
  };
}

/** Google Drive virus-scan interstitial: pull the confirm token out of the HTML. */
export function extractDriveConfirmToken(html: string, fileId: string): string | null {
  // Form action style: /uc?export=download&confirm=XXXX&id=FILE_ID
  const confirmInUrl = new RegExp(
    `confirm=([0-9A-Za-z_-]+)&amp;id=${fileId}|confirm=([0-9A-Za-z_-]+)(?:&|")`,
  ).exec(html);
  const fromUrl = confirmInUrl?.[1] ?? confirmInUrl?.[2];
  if (fromUrl) return fromUrl;

  // Cookie style: download_warning_...=TOKEN
  const cookie = /download_warning[^=]+=([0-9A-Za-z_-]+)/.exec(html);
  if (cookie?.[1]) return cookie[1];

  // Newer interstitial embeds uuid in a form field.
  const uuid = /name="uuid"\s+value="([^"]+)"/.exec(html);
  if (uuid?.[1]) return uuid[1];

  return null;
}

export function isArchiveContentType(contentType: string | null): boolean {
  if (!contentType) return false;
  const ct = contentType.toLowerCase().split(';')[0]?.trim() ?? '';
  return (
    ct === 'application/zip' ||
    ct === 'application/x-zip-compressed' ||
    ct === 'application/vnd.comicbook+zip' ||
    ct === 'application/x-cbz' ||
    ct === 'application/x-cbr' ||
    ct === 'application/vnd.comicbook-rar' ||
    ct === 'application/x-rar-compressed' ||
    ct === 'application/vnd.rar' ||
    ct === 'application/pdf' ||
    ct === 'application/octet-stream'
  );
}

export function isHtmlContentType(contentType: string | null): boolean {
  if (!contentType) return false;
  const ct = contentType.toLowerCase();
  return ct.includes('text/html') || ct.includes('application/xhtml');
}

/** ZIP / RAR / PDF magic-byte sniff so octet-stream responses still classify. */
export function sniffContainer(body: Buffer): 'zip' | 'rar' | 'pdf' | null {
  if (body.length < 4) return null;
  // PK\x03\x04 or PK\x05\x06 (empty) or PK\x07\x08
  if (body[0] === 0x50 && body[1] === 0x4b) return 'zip';
  // Rar!\x1a\x07
  if (body[0] === 0x52 && body[1] === 0x61 && body[2] === 0x72 && body[3] === 0x21) return 'rar';
  // %PDF
  if (body[0] === 0x25 && body[1] === 0x50 && body[2] === 0x44 && body[3] === 0x46) return 'pdf';
  return null;
}
