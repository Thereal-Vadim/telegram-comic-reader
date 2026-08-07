import { describe, expect, it } from 'vitest';
import {
  extractDriveConfirmToken,
  extractGoogleDriveFileId,
  resolveImportUrl,
  sniffContainer,
  toDropboxDirectUrl,
  toOneDriveDirectUrl,
} from '../src/import/resolveUrl.js';
import { extractComicImages } from '../src/import/webPage.js';

describe('extractGoogleDriveFileId', () => {
  it('parses /file/d/ID/view links', () => {
    expect(
      extractGoogleDriveFileId('https://drive.google.com/file/d/abc123XYZ/view?usp=sharing'),
    ).toBe('abc123XYZ');
  });

  it('parses open?id= links', () => {
    expect(extractGoogleDriveFileId('https://drive.google.com/open?id=fileId99')).toBe('fileId99');
  });

  it('returns null for unrelated hosts', () => {
    expect(extractGoogleDriveFileId('https://example.com/file/d/abc/view')).toBeNull();
  });
});

describe('toDropboxDirectUrl', () => {
  it('forces dl=1 on www.dropbox.com share links', () => {
    const out = toDropboxDirectUrl('https://www.dropbox.com/s/abc/comic.cbz?dl=0');
    expect(out).toContain('dl=1');
    expect(out).not.toContain('dl=0');
  });
});

describe('toOneDriveDirectUrl', () => {
  it('adds download=1', () => {
    const out = toOneDriveDirectUrl('https://1drv.ms/u/s!Abc');
    expect(out).toContain('download=1');
  });
});

describe('resolveImportUrl', () => {
  it('rewrites Google Drive to the uc export endpoint', () => {
    const r = resolveImportUrl('https://drive.google.com/file/d/FILEID/view?usp=sharing');
    expect(r.provider).toBe('google-drive');
    expect(r.fetchUrl).toBe('https://drive.google.com/uc?export=download&id=FILEID');
    expect(r.expected).toBe('archive');
  });

  it('treats a direct .cbz link as an archive', () => {
    const r = resolveImportUrl('https://cdn.example.com/library/Issue%2001.cbz');
    expect(r.provider).toBe('direct');
    expect(r.expected).toBe('archive');
    expect(r.filenameHint).toBe('Issue 01.cbz');
  });

  it('treats a bare page URL as web', () => {
    const r = resolveImportUrl('https://comics.example.com/chapter/12');
    expect(r.provider).toBe('web');
    expect(r.expected).toBe('web');
  });
});

describe('sniffContainer', () => {
  it('detects ZIP magic bytes', () => {
    expect(sniffContainer(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]))).toBe('zip');
  });

  it('detects RAR magic bytes', () => {
    expect(sniffContainer(Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a]))).toBe('rar');
  });

  it('detects PDF magic bytes', () => {
    expect(sniffContainer(Buffer.from('%PDF-1.4'))).toBe('pdf');
  });
});

describe('extractDriveConfirmToken', () => {
  it('pulls confirm from an interstitial form action', () => {
    const html =
      '<a href="/uc?export=download&amp;confirm=abcd&amp;id=FILEID">download</a>';
    expect(extractDriveConfirmToken(html, 'FILEID')).toBe('abcd');
  });
});

describe('extractComicImages', () => {
  it('collects chapter images and drops ad/icon URLs', () => {
    const html = `
      <html><head><title>Issue 12</title></head><body>
        <img src="/assets/logo.png" />
        <img src="https://doubleclick.net/ad.jpg" />
        <img src="/chapter/12/page-01.jpg" />
        <img data-src="/chapter/12/page-02.jpg" />
        <img src="/chapter/12/page-03.jpg" />
      </body></html>
    `;
    const result = extractComicImages(html, 'https://reader.example.com/chapter/12');
    expect(result.title).toBe('Issue 12');
    expect(result.imageUrls).toEqual([
      'https://reader.example.com/chapter/12/page-01.jpg',
      'https://reader.example.com/chapter/12/page-02.jpg',
      'https://reader.example.com/chapter/12/page-03.jpg',
    ]);
  });
});
