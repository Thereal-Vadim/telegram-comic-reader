import { expect, test, type Page } from '@playwright/test';

/**
 * Offline reading.
 *
 * This is the app's central promise, so it is verified the only way that
 * really counts: download a chapter, cut the network at the browser level,
 * and read it. `context.setOffline(true)` fails every request the page makes,
 * so anything that still renders genuinely came from IndexedDB.
 */

async function openComic(page: Page, series: string): Promise<void> {
  await page.goto('/');
  await page.getByText(series).first().click();
  await expect(page.getByRole('heading', { name: series })).toBeVisible({ timeout: 15_000 });
}

/**
 * Block until the service worker has installed and precached the shell.
 *
 * Cutting the network before activation would test nothing but a cold cache,
 * and every context here starts with empty storage.
 */
async function waitForOfflineReadiness(page: Page): Promise<void> {
  await page.waitForFunction(
    async () => {
      const registration = await navigator.serviceWorker?.ready;
      return registration?.active?.state === 'activated';
    },
    undefined,
    { timeout: 30_000 },
  );
}

test.describe('offline', () => {
  test('downloads a chapter and reads it with the network cut', async ({ page, context }) => {
    await openComic(page, 'Signal Lost');
    await waitForOfflineReadiness(page);

    // Save the first chapter and wait for it to report as stored. The stored
    // state is announced as "Remove download" because tapping it again is what
    // the button then does.
    const row = page.locator('li').filter({ hasText: 'Chapter 01' }).first();
    await row.getByRole('button', { name: /download chapter/i }).click();

    await expect(row.getByRole('button', { name: /remove download/i })).toBeVisible({
      timeout: 60_000,
    });

    await context.setOffline(true);

    try {
      await row.getByText('Chapter 01').click();

      await expect(page.getByRole('application', { name: /comic reader/i })).toBeVisible({
        timeout: 20_000,
      });

      // The reader labels its source; "Offline copy" means it resolved pages
      // from IndexedDB rather than the proxy.
      const surface = page.getByRole('application', { name: /comic reader/i });
      const box = (await surface.boundingBox())!;
      await surface.click({ position: { x: box.width / 2, y: box.height / 2 } });

      await expect(page.getByText(/offline copy/i)).toBeVisible({ timeout: 10_000 });

      // Turning pages must work too, not just the first one.
      await surface.click({ position: { x: box.width * 0.9, y: box.height / 2 } });
      await expect(page.getByText('2 / 6')).toBeVisible({ timeout: 10_000 });
    } finally {
      await context.setOffline(false);
    }
  });

  test('home feed falls back to cached metadata when offline', async ({ page, context }) => {
    // Prime the cache with an online visit.
    await page.goto('/');
    await expect(page.getByText('Orbital Mechanics').first()).toBeVisible({ timeout: 15_000 });
    await waitForOfflineReadiness(page);

    await context.setOffline(true);
    try {
      await page.goto('/');

      // Rather than an error, the feed shows what is stored locally.
      await expect(page.getByText(/offline/i).first()).toBeVisible({ timeout: 20_000 });
      await expect(page.getByText('Orbital Mechanics').first()).toBeVisible();
    } finally {
      await context.setOffline(false);
    }
  });

  test('reports a clear error for an undownloaded chapter while offline', async ({
    page,
    context,
  }) => {
    await openComic(page, 'The Cartographer');
    await waitForOfflineReadiness(page);

    await context.setOffline(true);
    try {
      await page.getByText('Chapter 03').first().click();

      // The message has to say the device is offline, not just "failed".
      await expect(page.getByText(/you are offline|could not reach/i)).toBeVisible({
        timeout: 20_000,
      });
    } finally {
      await context.setOffline(false);
    }
  });

  test('downloads page shows storage usage', async ({ page }) => {
    await page.goto('/downloads');

    await expect(page.getByRole('heading', { name: 'Downloads' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/storage used/i)).toBeVisible();

    // The foreground-only caveat must be stated wherever a queue is shown.
    const queueNote = page.getByText(/only run while this app is open/i);
    const emptyNote = page.getByText(/nothing downloading/i);
    await expect(queueNote.or(emptyNote)).toBeVisible();
  });
});
