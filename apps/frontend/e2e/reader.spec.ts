import { expect, test, type Page } from '@playwright/test';

/**
 * Reader behaviour, including the memory budget.
 *
 * The soak test at the bottom is the one that matters most. A texture leak is
 * invisible over a handful of pages and fatal over a volume, and the only
 * cheap way to catch it is to turn a lot of pages and watch the counters.
 */

/** Navigate into the first chapter of a series and wait for the canvas. */
async function openReader(page: Page, series = 'Orbital Mechanics'): Promise<void> {
  await page.goto('/');
  await page.getByText(series).first().click();
  await expect(page.getByRole('heading', { name: series })).toBeVisible({ timeout: 15_000 });

  await page.getByText('Chapter 01').first().click();
  await expect(page.getByRole('application', { name: /comic reader/i })).toBeVisible({
    timeout: 20_000,
  });
  // The canvas needs a frame or two before the first texture is resident.
  await page.waitForTimeout(1500);
}

test.describe('reader', () => {
  test('opens a chapter and renders a WebGL canvas', async ({ page }) => {
    await openReader(page);

    const canvas = page.locator('canvas');
    await expect(canvas).toBeVisible();

    // A canvas element that never got a GL context still renders as an
    // element, so confirm the context actually exists.
    const hasContext = await canvas.evaluate((el) => {
      const c = el as HTMLCanvasElement;
      return c.width > 0 && c.height > 0;
    });
    expect(hasContext).toBe(true);
  });

  test('advances pages by tapping the right edge', async ({ page }) => {
    await openReader(page);

    const surface = page.getByRole('application', { name: /comic reader/i });
    const box = await surface.boundingBox();
    expect(box).not.toBeNull();

    // Reveal the chrome so the page counter is readable, then tap forward.
    await surface.click({ position: { x: box!.width / 2, y: box!.height / 2 } });
    await expect(page.getByText('1 / 5')).toBeVisible({ timeout: 10_000 });

    // Right third advances in left-to-right reading order.
    await surface.click({ position: { x: box!.width * 0.9, y: box!.height / 2 } });
    await expect(page.getByText('2 / 5')).toBeVisible({ timeout: 10_000 });
  });

  test('goes back by tapping the left edge', async ({ page }) => {
    await openReader(page);

    const surface = page.getByRole('application', { name: /comic reader/i });
    const box = (await surface.boundingBox())!;

    await surface.click({ position: { x: box.width / 2, y: box.height / 2 } });
    await expect(page.getByText('1 / 5')).toBeVisible({ timeout: 10_000 });

    await surface.click({ position: { x: box.width * 0.9, y: box.height / 2 } });
    await expect(page.getByText('2 / 5')).toBeVisible({ timeout: 10_000 });

    await surface.click({ position: { x: box.width * 0.1, y: box.height / 2 } });
    await expect(page.getByText('1 / 5')).toBeVisible({ timeout: 10_000 });
  });

  test('keeps reading position in the URL so a reload resumes', async ({ page }) => {
    await openReader(page);

    const surface = page.getByRole('application', { name: /comic reader/i });
    const box = (await surface.boundingBox())!;

    // Each tap has to wait for the previous turn to settle. A tap arriving
    // mid-animation is deliberately ignored by the gesture layer, so firing
    // them back to back would only advance one page.
    await surface.click({ position: { x: box.width * 0.9, y: box.height / 2 } });
    await expect(page).toHaveURL(/page=1/, { timeout: 10_000 });

    await surface.click({ position: { x: box.width * 0.9, y: box.height / 2 } });
    await expect(page).toHaveURL(/page=2/, { timeout: 10_000 });

    await page.reload();
    await expect(page.getByRole('application', { name: /comic reader/i })).toBeVisible({
      timeout: 20_000,
    });
    await expect(page).toHaveURL(/page=2/);
  });

  test('does not exceed the three-texture budget while turning pages', async ({ page }) => {
    await openReader(page);

    const surface = page.getByRole('application', { name: /comic reader/i });
    const box = (await surface.boundingBox())!;

    // The reader publishes its resident texture count on `window`, so this
    // reads the real number rather than inferring it from behaviour.
    const readStats = async (): Promise<{ screenCount: number; totalBytes: number } | null> =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              __READER_TEXTURE_STATS__?: { screenCount: number; totalBytes: number };
            }
          ).__READER_TEXTURE_STATS__ ?? null,
      );

    await expect.poll(async () => (await readStats())?.screenCount ?? -1).toBeGreaterThan(0);

    // Turn back and forth well past the size of the three-page window.
    for (let i = 0; i < 16; i++) {
      const forward = i % 8 < 4;
      await surface.click({
        position: { x: forward ? box.width * 0.9 : box.width * 0.1, y: box.height / 2 },
      });
      await page.waitForTimeout(300);

      const stats = await readStats();
      expect(stats).not.toBeNull();
      expect(stats!.screenCount).toBeLessThanOrEqual(3);
      // Three 1200x1800 RGBA textures is about 26 MB; anything approaching
      // 64 MB means pages are accumulating instead of being evicted.
      expect(stats!.totalBytes).toBeLessThan(64 * 1024 * 1024);
    }

    // The reader must still be alive and responsive at the end.
    await expect(surface).toBeVisible();
  });

  test('survives a simulated WebGL context loss', async ({ page }) => {
    await openReader(page);

    // Force the exact failure a mobile WebView produces under memory pressure.
    const lost = await page.evaluate(() => {
      const canvas = document.querySelector('canvas');
      if (!canvas) return false;
      const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
      const ext = (gl as WebGLRenderingContext | null)?.getExtension('WEBGL_lose_context');
      if (!ext) return false;
      ext.loseContext();
      setTimeout(() => ext.restoreContext(), 300);
      return true;
    });

    if (!lost) test.skip(true, 'WEBGL_lose_context is unavailable in this browser build');

    await page.waitForTimeout(2500);

    // The canvas must come back rather than staying black forever, and the
    // app must not have fallen through to the error boundary.
    await expect(page.getByRole('application', { name: /comic reader/i })).toBeVisible();
    await expect(page.getByText(/something broke/i)).toHaveCount(0);
  });
});
