import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The package is ESM, so `__dirname` does not exist.
const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * End-to-end configuration.
 *
 * Both servers are started by Playwright against the generated sample library,
 * so a run needs no manual setup. The mobile Chrome profile is the default
 * because that is what a Telegram Mini App actually runs in; a desktop-sized
 * viewport would exercise layout paths real users never see.
 */

const BACKEND_PORT = 8788;
const FRONTEND_PORT = 5174;
const sampleLibrary = path.resolve(here, '../backend/var/sample-library');

export default defineConfig({
  testDir: './e2e',
  // Serial: the tests share one backend whose image cache and sample library
  // are global state, and download tests race each other over storage quota.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 2 : 0,
  // Downloading a chapter runs a real transcode of every page through sharp on
  // a cold image cache, which does not fit in the 30s default.
  timeout: 120_000,
  reporter: process.env['CI'] ? [['github'], ['html', { open: 'never' }]] : [['list']],

  use: {
    baseURL: `http://localhost:${FRONTEND_PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'mobile-chrome',
      use: {
        ...devices['Pixel 7'],
        // WebGL is required by the reader; headless Chrome needs to be told
        // to use SwiftShader rather than falling back to no GL at all.
        launchOptions: {
          args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'],
        },
      },
    },
  ],

  webServer: [
    {
      command: 'pnpm --filter @comic/backend dev',
      port: BACKEND_PORT,
      cwd: path.resolve(here, '../..'),
      reuseExistingServer: !process.env['CI'],
      timeout: 60_000,
      env: {
        PORT: String(BACKEND_PORT),
        LOCAL_LIBRARY_DIR: sampleLibrary,
        // Isolated from the dev cache so a test run cannot poison it.
        IMAGE_CACHE_DIR: path.resolve(here, '../backend/var/e2e-cache/images'),
        NODE_ENV: 'development',
      },
    },
    {
      // A production build rather than the dev server. The offline tests stand
      // or fall on the service worker, which only exists in a build, and the
      // dev server's unbundled module graph makes a code-split route hundreds
      // of separate requests that no precache manifest describes.
      command: `pnpm exec vite build && pnpm exec vite preview --port ${FRONTEND_PORT} --strictPort`,
      port: FRONTEND_PORT,
      cwd: here,
      reuseExistingServer: !process.env['CI'],
      timeout: 180_000,
      env: { VITE_API_BASE: `http://localhost:${BACKEND_PORT}` },
    },
  ],
});
