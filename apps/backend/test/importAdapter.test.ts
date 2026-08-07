import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { ImportAdapter } from '../src/adapters/import.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

async function makeCbz(): Promise<{ dir: string; cbz: Buffer }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'import-cbz-'));
  await fs.writeFile(path.join(dir, '01.png'), PNG);
  await fs.writeFile(path.join(dir, '02.png'), PNG);
  execFileSync('zip', ['-q', 'test.cbz', '01.png', '02.png'], { cwd: dir });
  const cbz = await fs.readFile(path.join(dir, 'test.cbz'));
  return { dir, cbz };
}

describe('ImportAdapter', () => {
  const cleanups: string[] = [];

  afterEach(async () => {
    for (const dir of cleanups.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('imports a direct CBZ body and lists pages', async () => {
    const { dir: srcDir, cbz } = await makeCbz();
    cleanups.push(srcDir);

    const storeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'import-store-'));
    cleanups.push(storeDir);

    const hosts = new Set<string>();
    const adapter = new ImportAdapter({
      dir: storeDir,
      maxArchiveBytes: 10 * 1024 * 1024,
      maxEntryBytes: 10 * 1024 * 1024,
      extraHosts: hosts,
      fetch: async () => ({
        body: cbz,
        contentType: 'application/vnd.comicbook+zip',
      }),
    });

    const { record, encodedId } = await adapter.importUrl({
      ownerId: 42,
      url: 'https://cdn.example.com/library/My%20Issue.cbz',
      title: 'My Issue',
    });

    expect(record.kind).toBe('archive');
    expect(record.pageCount).toBe(2);
    expect(record.title).toBe('My Issue');
    expect(record.ownerId).toBe(42);

    const pages = await adapter.getPages(encodedId);
    expect(pages).toHaveLength(2);
    expect(pages[0]?.source.kind).toBe('zip-entry');

    const listed = await adapter.listForOwner(42);
    expect(listed).toHaveLength(1);
    expect(await adapter.listForOwner(99)).toHaveLength(0);
  });

  it('imports a web page of images and allowlists their hosts', async () => {
    const storeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'import-store-'));
    cleanups.push(storeDir);
    const hosts = new Set<string>();

    const html = `
      <html><head><title>Web Comic</title></head><body>
        <img src="https://img.example.com/c/1.jpg" />
        <img src="https://img.example.com/c/2.jpg" />
        <img src="https://img.example.com/c/3.jpg" />
      </body></html>
    `;

    const adapter = new ImportAdapter({
      dir: storeDir,
      maxArchiveBytes: 10 * 1024 * 1024,
      maxEntryBytes: 10 * 1024 * 1024,
      extraHosts: hosts,
      fetch: async () => ({ body: Buffer.from(html), contentType: 'text/html; charset=utf-8' }),
    });

    const { record, encodedId } = await adapter.importUrl({
      ownerId: 7,
      url: 'https://reader.example.com/chapter/1',
    });

    expect(record.kind).toBe('web');
    expect(record.pageCount).toBe(3);
    expect(hosts.has('img.example.com')).toBe(true);

    const pages = await adapter.getPages(encodedId);
    expect(pages[1]?.source).toEqual({
      kind: 'http',
      url: 'https://img.example.com/c/2.jpg',
    });
  });
});
