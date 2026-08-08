import { describe, expect, it } from 'vitest';
import { AdapterRegistry } from '../src/adapters/registry.js';
import { ComxAdapter } from '../src/adapters/comxAdapter.js';

const POPULAR = ['Orbital Mechanics', 'Signal Lost', 'The Cartographer'] as const;
const COMICS = ['Night Shift', 'Glass Harbor', 'Steel Alley'] as const;
const MANGA = ['Paper Crane', 'Ink Tide', 'Quiet Station'] as const;

function catalogHtml(titles: readonly string[], prefix: string): string {
  const cards = titles.map(
    (title, i) => `
      <article class="comix-item">
        <h3><a href="/comix/${prefix}-${i}-${title.toLowerCase().replace(/\s+/g, '-')}.html">${title}</a></h3>
        <img src="/uploads/${prefix}${i}.jpg" />
      </article>`,
  ).join('');
  return `<div id="dle-content">${cards}<div class="page-nav"><span>1</span><a>2</a></div></div>`;
}

describe('Home feed from comx featured shelves', () => {
  it('returns popular → comics → manga shelves for Home tabs', async () => {
    const adapter = new ComxAdapter(async (url) => {
      if (url.includes('marvel-read') || url.includes('dc-comics') || url.includes('image-read') || url.includes('other-read')) {
        return { body: Buffer.from(catalogHtml(COMICS, 'c')), contentType: 'text/html' };
      }
      if (url.includes('manga-2025') || url.includes('manhwa') || url.includes('manhua')) {
        return { body: Buffer.from(catalogHtml(MANGA, 'm')), contentType: 'text/html' };
      }
      if (url.includes('comix-read')) {
        return { body: Buffer.from(catalogHtml(POPULAR, 'p')), contentType: 'text/html' };
      }
      throw new Error(`unexpected ${url}`);
    });

    const registry = new AdapterRegistry([adapter], []);
    const feed = await registry.homeFeed();

    expect(feed.degraded).toEqual([]);
    expect(feed.shelves.map((s) => s.id)).toEqual([
      'comx-popular',
      'comx-comics',
      'comx-manga',
    ]);
    expect(feed.shelves.map((s) => s.title)).toEqual([
      'Сейчас популярно',
      'Комиксы',
      'Манга',
    ]);
    expect(feed.shelves[0]!.items.map((i) => i.title)).toEqual([...POPULAR]);
    expect(feed.shelves[1]!.items.map((i) => i.title)).toEqual([...COMICS]);
    expect(feed.shelves[2]!.items.map((i) => i.title)).toEqual([...MANGA]);
    expect(feed.hero[0]!.title).toBe(POPULAR[0]);

    for (const item of feed.shelves.flatMap((s) => s.items)) {
      expect(item.id.startsWith('comx:')).toBe(true);
      expect(item.coverUrl).toMatch(/^\/api\/image\/comx\//);
    }
  });
});
