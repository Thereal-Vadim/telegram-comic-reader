import { accessSync } from 'node:fs';
import { AppError } from '@comic/shared';
import type { ComxCredentials } from './comxSession.js';

/**
 * Loose DOM shapes for code that runs inside page.evaluate.
 * Must not close over Node helpers — Puppeteer serializes only the function body.
 */
type InPageEl = {
  textContent: string | null;
  value?: string;
  hidden?: boolean;
  style: { display: string };
  click(): void;
  requestSubmit?: () => void;
  submit?: () => void;
  scrollIntoView(arg?: unknown): void;
};
type InPageDoc = {
  querySelector(selectors: string): InPageEl | null;
  querySelectorAll(selectors: string): ArrayLike<InPageEl>;
};

const BASE_URL = 'https://com-x.life';

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  `${process.env.LOCALAPPDATA ?? ''}\\Google\\Chrome\\Application\\chrome.exe`,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/local/bin/google-chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter((p): p is string => Boolean(p));

function resolveChromePath(): string {
  for (const candidate of CHROME_CANDIDATES) {
    try {
      accessSync(candidate);
      return candidate;
    } catch {
      // try next
    }
  }
  throw new AppError(
    'UPSTREAM_UNAVAILABLE',
    'Chrome is required for com-x login (set CHROME_PATH)',
  );
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Random delay in [minMs, maxMs] — keeps pacing human, not metronomic. */
const humanPause = (minMs: number, maxMs: number): Promise<void> =>
  sleep(minMs + Math.floor(Math.random() * (maxMs - minMs + 1)));

async function typeLikeHuman(
  page: import('puppeteer-core').Page,
  selector: string,
  text: string,
): Promise<void> {
  const handle = await page.waitForSelector(selector, { visible: true, timeout: 15_000 });
  if (!handle) throw new AppError('UPSTREAM_UNAVAILABLE', `comx field missing: ${selector}`);
  await handle.evaluate((el) => {
    (el as unknown as InPageEl).scrollIntoView({ block: 'center', inline: 'nearest' });
  });
  await humanPause(150, 350);
  await handle.click({ clickCount: 1 });
  await humanPause(120, 280);
  // Inline globalThis access — outer inPageDoc() is not available in the page world.
  await page.evaluate((sel) => {
    const doc = (globalThis as unknown as { document: InPageDoc }).document;
    const input = doc.querySelector(sel);
    if (input && typeof input.value === 'string') input.value = '';
  }, selector);
  await handle.focus();
  for (const ch of text) {
    await page.keyboard.type(ch, { delay: 45 + Math.floor(Math.random() * 85) });
  }
}

export interface BrowserLoginResult {
  cookies: Array<{ name: string; value: string }>;
}

/**
 * Log into com-x.life through real Chrome with human pacing.
 *
 * Pure Node POSTs are rejected by the site’s gate (HTTP 401) even with valid
 * credentials; a headed/headless Chrome session matches what works in a
 * normal browser and yields cookies the HTML client can reuse for catalog
 * browsing and later file downloads.
 */
export async function loginComxWithBrowser(
  credentials: ComxCredentials,
): Promise<BrowserLoginResult> {
  const puppeteer = await import('puppeteer-core');
  const executablePath = resolveChromePath();
  const headed = Boolean(process.env.DISPLAY);

  const browser = await puppeteer.launch({
    executablePath,
    headless: headed ? false : true,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1280,900',
    ],
    defaultViewport: { width: 1280, height: 900 },
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    );
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty((globalThis as unknown as { navigator: object }).navigator, 'webdriver', {
        get: () => false,
      });
    });

    await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle2', timeout: 90_000 }).catch(async () => {
      await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    });
    // Anti-bot / gate paint. The homepage catalog is public; the login form
    // lives in a closed modal (`Войти`) and is not visible until opened.
    await humanPause(2500, 4000);

    const loginVisible = await page
      .$('input[name="login_name"]')
      .then(async (h) => {
        if (!h) return false;
        return h.evaluate((el) => {
          const node = el as unknown as InPageEl & { getBoundingClientRect?: () => { width: number; height: number } };
          const box = node.getBoundingClientRect?.();
          return Boolean(box && box.width > 0 && box.height > 0 && node.style.display !== 'none');
        });
      })
      .catch(() => false);

    if (!loginVisible) {
      await page.evaluate(() => {
        const doc = (globalThis as unknown as { document: InPageDoc }).document;
        const nodes = Array.from(doc.querySelectorAll('a, button, span, div'));
        const enter = nodes.find((el) => /^войти$/i.test((el.textContent || '').trim()));
        if (enter) enter.click();
      });
      await humanPause(800, 1500);
    }

    // Password form may be hidden behind the magic-link primary panel.
    const altClicked = await page.evaluate(() => {
      const doc = (globalThis as unknown as { document: InPageDoc }).document;
      const nodes = Array.from(doc.querySelectorAll('a, button, span, div'));
      const alt =
        doc.querySelector('.js-gate-alt') ||
        nodes.find((el) => /вход паролем|паролем|password/i.test(el.textContent || ''));
      if (alt) {
        alt.click();
        return true;
      }
      return false;
    });
    if (altClicked) await humanPause(1000, 1800);

    // Unhide secondary login panel if still marked hidden.
    await page.evaluate(() => {
      const secondary = (globalThis as unknown as { document: InPageDoc }).document.querySelector(
        '.js-gate-secondary',
      );
      if (secondary) {
        secondary.hidden = false;
        secondary.style.display = 'block';
      }
    });

    await page.waitForSelector('input[name="login_name"]', {
      timeout: 30_000,
      visible: true,
    });
    await humanPause(600, 1200);
    await typeLikeHuman(page, 'input[name="login_name"]', credentials.login);
    await humanPause(700, 1400);
    await typeLikeHuman(page, 'input[name="login_password"]', credentials.password);
    await humanPause(900, 1800);

    const navPromise = page
      .waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 45_000 })
      .catch(() => undefined);

    const submitted = await page.evaluate(() => {
      const doc = (globalThis as unknown as { document: InPageDoc }).document;
      const form =
        doc.querySelector('form[method="post"]') ||
        doc.querySelector('.js-gate-secondary form') ||
        doc.querySelector('form');
      if (form) {
        if (typeof form.requestSubmit === 'function') form.requestSubmit();
        else if (typeof form.submit === 'function') form.submit();
        else form.click();
        return true;
      }
      const btn = doc.querySelector(
        '.js-gate-secondary button[type="submit"], form button[type="submit"]',
      );
      if (btn) {
        btn.click();
        return true;
      }
      return false;
    });
    if (!submitted) {
      throw new AppError('UPSTREAM_UNAVAILABLE', 'comx login form submit control not found');
    }
    await navPromise;

    await humanPause(2000, 3500);

    const html = await page.content();
    const stillGate =
      html.includes('name="login_name"') &&
      (html.includes('Com-X.life — вход') || html.includes('sandev-auth-magic'));
    if (stillGate) {
      throw new AppError(
        'UPSTREAM_UNAVAILABLE',
        'comx browser login failed — check login/password on com-x.life',
      );
    }

    // Warm the catalog once so download cookies cover that path too.
    await page.goto(`${BASE_URL}/comix-read/`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    await humanPause(2000, 3500);

    const cookies = await page.cookies(BASE_URL, `${BASE_URL}/comix-read/`);
    if (cookies.length === 0) {
      throw new AppError('UPSTREAM_UNAVAILABLE', 'comx browser login produced no cookies');
    }

    return {
      cookies: cookies.map((c) => ({ name: c.name, value: c.value })),
    };
  } finally {
    await browser.close().catch(() => undefined);
  }
}
