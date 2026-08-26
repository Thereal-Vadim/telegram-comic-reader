import { describe, expect, it } from 'vitest';
import { AdapterRegistry } from '../src/adapters/registry.js';
import { ComxAdapter } from '../src/adapters/comxAdapter.js';

const TITLES = [
  'Orbital Mechanics',
  'Signal Lost',
  'The Cartographer',
  'Night Shift',
  'Glass Harbor',
] as const;

function catalogHtml(): string {
  const cards = TITLES.map(
    (title, i) => `
      <article class="comix-item">
        <h3><a href="/comix/${100 + i}-${title.toLowerCase().replace(/\s+/g, '-')}.html">${title}</a></h3>
        <img src="/uploads/c${i}.jpg" />
      </article>`,
  ).join('');
  return `<div id="dle-content">${cards}<div class="page-nav"><span>1</span><a>2</a></div></div>`;
}

describe('Home feed from comx featured shelf', () => {
  it('surfaces five parsed comics on hero + com-x.life shelf', async () => {
    const adapter = new ComxAdapter(async (url) => {
      if (
        url.includes('comix-read') ||
        url.includes('/comix/') ||
        url === 'https://com-x.life' ||
        url === 'https://com-x.life/'
      ) {
        return { body: Buffer.from(catalogHtml()), contentType: 'text/html' };
      }
      throw new Error(`unexpected ${url}`);
    });

    const registry = new AdapterRegistry([adapter], []);
    const feed = await registry.homeFeed();

    expect(feed.degraded).toEqual([]);
    expect(feed.shelves).toHaveLength(1);
    expect(feed.shelves[0]!.id).toBe('comx');
    expect(feed.shelves[0]!.title).toBe('com-x.life');
    expect(feed.shelves[0]!.items).toHaveLength(5);
    expect(feed.shelves[0]!.items.map((i) => i.title)).toEqual([...TITLES]);
    expect(feed.hero.length).toBeGreaterThanOrEqual(5);

    for (const item of feed.shelves[0]!.items) {
      expect(item.id.startsWith('comx:')).toBe(true);
      expect(item.coverUrl).toMatch(/^\/api\/image\/comx\//);
    }
  });
});
