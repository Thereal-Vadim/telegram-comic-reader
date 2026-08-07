import { describe, expect, it } from 'vitest';
import { ComxAdapter } from '../src/adapters/comxAdapter.js';

describe('ComxAdapter.parseCatalogPage', () => {
  it('extracts cards and pagination from catalog HTML', () => {
    const adapter = new ComxAdapter(async () => ({
      body: Buffer.from(''),
      contentType: 'text/html',
    }));

    const html = `
      <html><body>
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
