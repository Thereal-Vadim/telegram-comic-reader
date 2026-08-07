import { describe, expect, it, vi } from 'vitest';
import { ComxAdapter } from '../src/adapters/comxAdapter.js';

function catalogHtml(): string {
  return `
    <div id="dle-content">
      <article class="comix-item">
        <h3><a href="/comix/1-cached-comic.html">Cached Comic</a></h3>
        <img src="/uploads/c.jpg" />
      </article>
      <div class="page-nav"><span>1</span></div>
    </div>`;
}

describe('ComxAdapter catalog / pages cache', () => {
  it('serves getCatalog from cache on the second call', async () => {
    const fetch = vi.fn(async (url: string) => {
      if (url.includes('comix-read') || url.includes('/comix/')) {
        return { body: Buffer.from(catalogHtml()), contentType: 'text/html' };
      }
      throw new Error(`unexpected ${url}`);
    });
    const adapter = new ComxAdapter(fetch);

    const first = await adapter.getCatalog(1);
    const second = await adapter.getCatalog(1);

    expect(first.items).toHaveLength(1);
    expect(second.items[0]?.title).toBe('Cached Comic');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent getCatalog scrapes', async () => {
    let releases!: () => void;
    const gate = new Promise<void>((resolve) => {
      releases = resolve;
    });
    const fetch = vi.fn(async () => {
      await gate;
      return { body: Buffer.from(catalogHtml()), contentType: 'text/html' };
    });
    const adapter = new ComxAdapter(fetch);

    const a = adapter.getCatalog(1);
    const b = adapter.getCatalog(1);
    releases();
    const [ra, rb] = await Promise.all([a, b]);

    expect(ra.items).toHaveLength(1);
    expect(rb.items).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
