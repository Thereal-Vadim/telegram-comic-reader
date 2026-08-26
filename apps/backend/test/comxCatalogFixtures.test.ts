import { describe, expect, it } from 'vitest';
import { ComxAdapter } from '../src/adapters/comxAdapter.js';

const FIVE_COMICS = [
  {
    slug: '101-orbital-mechanics.html',
    title: 'Orbital Mechanics',
    cover: '/uploads/covers/orbital.jpg',
    description: 'A crew maps the outer rings before the station fails.',
    chapters: ['Chapter 1', 'Chapter 2'],
  },
  {
    slug: '102-signal-lost.html',
    title: 'Signal Lost',
    cover: '/uploads/covers/signal.jpg',
    description: '',
    chapters: ['Prologue', 'Chapter 1'],
  },
  {
    slug: '103-the-cartographer.html',
    title: 'The Cartographer',
    cover: '//cdn.example.com/cartographer.webp',
    description: 'Maps that rewrite themselves each night.',
    chapters: ['Vol.1 Ch.1'],
  },
  {
    slug: '104-night-shift.html',
    title: 'Night Shift',
    cover: '/uploads/covers/night.jpg',
    description: 'Hospital corridors after midnight.',
    chapters: ['Issue 1', 'Issue 2', 'Issue 3'],
  },
  {
    slug: '105-glass-harbor.html',
    title: 'Glass Harbor',
    cover: '/uploads/covers/harbor.png',
    description: '',
    chapters: ['Chapter 01'],
  },
] as const;

function catalogHtml(): string {
  const cards = FIVE_COMICS.map(
    (c) => `
      <div class="readed d-flex short">
        <a href="https://com-x.life/comix/${c.slug}" class="readed__img">
          <img data-src="${c.cover}" alt="${c.title}" />
        </a>
        <div class="readed__desc">
          <h3 class="readed__title"><a href="https://com-x.life/comix/${c.slug}">${c.title}</a></h3>
          <div class="readed__meta"><div class="readed__meta-item">2024</div></div>
        </div>
      </div>`,
  ).join('\n');

  return `<html><body><div id="dle-content">${cards}
    <div class="navigation"><a>1</a><a>2</a></div>
  </div></body></html>`;
}

function detailHtml(comic: (typeof FIVE_COMICS)[number]): string {
  const newsId = 1000 + FIVE_COMICS.findIndex((c) => c.slug === comic.slug);
  const chaptersJson = comic.chapters.map((title, i) => ({
    id: newsId * 10 + i + 1,
    posi: i + 1,
    pages: 10,
    title,
    volume: 1,
    number: i + 1,
    date: '7.08.2026',
  }));
  const descBlock = comic.description
    ? `<div class="page__text full-text">${comic.description}</div>`
    : `<div class="page__text full-text"></div>`;

  return `<html><body>
    <article class="page">
      <h1>${comic.title}</h1>
      <h2 class="page__title-original">Original</h2>
      <div class="page__poster"><img src="${comic.cover.startsWith('//') ? `https:${comic.cover}` : comic.cover}" /></div>
      ${descBlock}
      <ul class="page__list"><li><div>Статус:</div> Ongoing</li></ul>
      <div class="page__tags"><a>Sci-Fi</a><a>Adventure</a></div>
      <script>window.__DATA__ = ${JSON.stringify({ news_id: newsId, chapters: chaptersJson, limit: 30 })};</script>
    </article>
  </body></html>`;
}

describe('ComxAdapter five-comic catalog + detail parse', () => {
  it('parses five catalog cards with titles, urls, and covers', () => {
    const adapter = new ComxAdapter(async () => ({
      body: Buffer.from(''),
      contentType: 'text/html',
    }));

    const parsed = adapter.parseCatalogPage(catalogHtml(), 1);
    expect(parsed.items).toHaveLength(5);
    expect(parsed.items.map((i) => i.title)).toEqual(FIVE_COMICS.map((c) => c.title));
    for (const [i, comic] of FIVE_COMICS.entries()) {
      const item = parsed.items[i]!;
      expect(item.url).toBe(`https://com-x.life/comix/${comic.slug}`);
      expect(item.coverUrl.length).toBeGreaterThan(0);
      expect(item.coverUrl.startsWith('http')).toBe(true);
    }
    expect(parsed.hasNextPage).toBe(true);
  });

  it('opens all five comics: description only when present, chapters listed', async () => {
    const byUrl = new Map(
      FIVE_COMICS.map((c) => [`https://com-x.life/comix/${c.slug}`, detailHtml(c)]),
    );

    const adapter = new ComxAdapter(async (url) => {
      const html = byUrl.get(url);
      if (!html) throw new Error(`unexpected fetch ${url}`);
      return { body: Buffer.from(html), contentType: 'text/html' };
    });

    for (const comic of FIVE_COMICS) {
      const details = await adapter.getComicDetails(`/comix/${comic.slug}`);
      expect(details.title).toBe(comic.title);
      expect(details.coverUrl.startsWith('http')).toBe(true);
      expect(details.chapters.length).toBe(comic.chapters.length);
      expect(details.chapters.map((c) => c.title)).toEqual([...comic.chapters]);
      if (comic.description) {
        expect(details.description).toBe(comic.description);
      } else {
        expect(details.description).toBe('');
      }

      // ProviderAdapter surface used by Home / detail routes.
      const id = Buffer.from(`https://com-x.life/comix/${comic.slug}`, 'utf8').toString(
        'base64url',
      );
      const summary = await adapter.getComic(id);
      expect(summary.title).toBe(comic.title);
      expect(summary.description).toBe(comic.description);
      const chapters = await adapter.getChapters(id);
      expect(chapters.length).toBe(comic.chapters.length);
    }
  });

  it('featured() returns the five catalog comics for the home shelf', async () => {
    const adapter = new ComxAdapter(async (url) => {
      if (url.includes('/comix-read/') || url === 'https://com-x.life' || url === 'https://com-x.life/') {
        return { body: Buffer.from(catalogHtml()), contentType: 'text/html' };
      }
      throw new Error(`unexpected ${url}`);
    });

    const items = await adapter.featured();
    expect(items.length).toBe(5);
    expect(items.map((i) => i.title)).toEqual(FIVE_COMICS.map((c) => c.title));
    for (const item of items) {
      expect(item.cover?.kind).toBe('http');
      if (item.cover?.kind === 'http') {
        expect(item.cover.url.startsWith('http')).toBe(true);
      }
    }
  });

  it('parses 2026 poster-grid catalog cards from the public home page', () => {
    const adapter = new ComxAdapter(async () => ({
      body: Buffer.from(''),
      contentType: 'text/html',
    }));
    const html = `
      <a class="poster grid-item has-overlay" href="/12824-mladshij-syn-mechnika.html">
        <div class="poster__img"><img src="/uploads/mini/a.webp" alt="alt"></div>
        <div class="poster__desc">
          <p class="poster__title line-clamp">The Youngest Son of a Master Swordsman / Младший сын мечника</p>
          <ul class="poster__meta"><li>Kakao</li><li>2022</li></ul>
        </div>
      </a>
      <li class="latest grid-item">
        <a href="/31633-dorogoj.html" class="latest__img"><img src="/uploads/mini/b.webp" alt="Дорогой"></a>
        <p class="latest__title"><a href="/31633-dorogoj.html">Dear / Дорогой</a></p>
        <p class="latest__chapter">1 - 61</p>
      </li>`;
    const parsed = adapter.parseCatalogPage(html, 1);
    expect(parsed.items.map((i) => i.title)).toEqual([
      'The Youngest Son of a Master Swordsman / Младший сын мечника',
      'Dear / Дорогой',
    ]);
    expect(parsed.items[0]!.coverUrl).toContain('/uploads/mini/a.webp');
    expect(parsed.items[1]!.latestChapter).toBe('1 - 61');
  });
});
