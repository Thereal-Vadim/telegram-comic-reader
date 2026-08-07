import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ComxAdapter } from '../src/adapters/comxAdapter.js';
import { solveComxPow } from '../src/adapters/comxSession.js';

describe('ComxAdapter.getCatalogUrl', () => {
  const adapter = new ComxAdapter(async () => ({
    body: Buffer.from(''),
    contentType: 'text/html',
  }));

  it('omits /page/1/ on the first catalog page (DLE 404 otherwise)', () => {
    expect(adapter.getCatalogUrl(1)).toBe('https://com-x.life/comix-read/');
    expect(adapter.getCatalogUrl(0)).toBe('https://com-x.life/comix-read/');
  });

  it('uses /comix-read/page/N/ for later pages', () => {
    expect(adapter.getCatalogUrl(2)).toBe('https://com-x.life/comix-read/page/2/');
    expect(adapter.getCatalogUrl(5)).toBe('https://com-x.life/comix-read/page/5/');
  });

  it('strips /page/N from category URLs on page 1', () => {
    expect(adapter.getCatalogUrl(1, 'https://com-x.life/xfsearch/marvel/page/3')).toBe(
      'https://com-x.life/xfsearch/marvel',
    );
    expect(adapter.getCatalogUrl(2, 'https://com-x.life/xfsearch/marvel/')).toBe(
      'https://com-x.life/xfsearch/marvel/page/2/',
    );
  });
});

describe('ComxAdapter.parseCatalogPage', () => {
  it('extracts cards and pagination from catalog HTML', () => {
    const adapter = new ComxAdapter(async () => ({
      body: Buffer.from(''),
      contentType: 'text/html',
    }));

    const html = `
      <html><body>
        <div id="dle-content">
          <article class="story">
            <h2 class="title"><a href="/comix/123-spiderman.html">Spider-Man</a></h2>
            <div class="poster"><img data-src="/uploads/cover1.jpg" /></div>
            <span class="year">2020</span>
          </article>
          <div class="short-story">
            <div class="story-title"><a href="/comix/456-batman.html">Batman</a></div>
            <img src="//cdn.example.com/bat.jpg" />
          </div>
          <div class="navigation"><a href="#">1</a><a href="#">2</a><span>3</span></div>
        </div>
      </body></html>
    `;

    const result = adapter.parseCatalogPage(html, 1);
    expect(result.items).toHaveLength(2);
    expect(result.items[0]?.title).toBe('Spider-Man');
    expect(result.items[0]?.url).toBe('https://com-x.life/comix/123-spiderman.html');
    expect(result.items[0]?.coverUrl).toBe('https://com-x.life/uploads/cover1.jpg');
    expect(result.items[1]?.coverUrl).toBe('https://cdn.example.com/bat.jpg');
    expect(result.totalPages).toBe(3);
    expect(result.hasNextPage).toBe(true);
  });
});

describe('solveComxPow', () => {
  it('finds a nonce whose SHA-256(token:nonce) starts with 00', () => {
    const token = 'test-token';
    const { nonce, hash } = solveComxPow(token);
    expect(hash).toBe(createHash('sha256').update(`${token}:${nonce}`).digest('hex'));
    expect(hash.startsWith('00')).toBe(true);
  });
});
