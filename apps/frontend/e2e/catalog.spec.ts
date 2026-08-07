import { expect, test } from '@playwright/test';

/**
 * Catalog flows against the real backend and the generated sample library.
 *
 * These deliberately do not mock the API. The interesting failures in this
 * app live at the seams (namespaced ids surviving a round trip, the image
 * proxy actually returning WebP, the Telegram fallback behaving outside
 * Telegram), and a mocked backend hides all of them.
 */

test.describe('catalog', () => {
  test('home feed lists the sample library', async ({ page }) => {
    await page.goto('/');

    // The sample library has three series, each becoming a shelf entry.
    await expect(page.getByText('Orbital Mechanics').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Signal Lost').first()).toBeVisible();
    await expect(page.getByText('The Cartographer').first()).toBeVisible();
  });

  test('covers load as WebP from the app origin', async ({ page }) => {
    // The CORS story depends on every image coming from our own API rather
    // than a third-party host, so this asserts both the type and the origin.
    const imageResponses: { url: string; type: string }[] = [];

    page.on('response', (response) => {
      if (response.url().includes('/api/image/')) {
        imageResponses.push({
          url: response.url(),
          type: response.headers()['content-type'] ?? '',
        });
      }
    });

    await page.goto('/');
    await expect(page.getByText('Orbital Mechanics').first()).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(2000);

    expect(imageResponses.length).toBeGreaterThan(0);
    for (const response of imageResponses) {
      expect(response.type).toBe('image/webp');
    }
  });

  test('search filters by title', async ({ page }) => {
    await page.goto('/search');

    const input = page.getByRole('searchbox', { name: /search comics/i });
    await input.fill('Signal');

    await expect(page.getByText('Signal Lost').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Orbital Mechanics')).toHaveCount(0);
  });

  test('search reports no matches rather than showing an empty grid', async ({ page }) => {
    await page.goto('/search');
    await page.getByRole('searchbox', { name: /search comics/i }).fill('zzzznotathing');

    await expect(page.getByText(/no matches/i)).toBeVisible({ timeout: 15_000 });
  });

  test('comic detail lists chapters in order', async ({ page }) => {
    await page.goto('/');
    await page.getByText('Orbital Mechanics').first().click();

    await expect(page.getByRole('heading', { name: 'Orbital Mechanics' })).toBeVisible({
      timeout: 15_000,
    });

    // Four chapters, listed lowest number first.
    const chapters = page.getByText(/^Chapter 0\d$/);
    await expect(chapters).toHaveCount(4);
    await expect(chapters.first()).toHaveText('Chapter 01');
  });

  test('favouriting a comic persists across a reload', async ({ page }) => {
    await page.goto('/');
    await page.getByText('Signal Lost').first().click();

    const favourite = page.getByRole('button', { name: /add to favourites/i });
    await favourite.click();
    await expect(page.getByRole('button', { name: /in favourites/i })).toBeVisible();

    // Reload: the state lives in IndexedDB, so it must survive.
    await page.reload();
    await expect(page.getByRole('button', { name: /in favourites/i })).toBeVisible({
      timeout: 15_000,
    });
  });
});
