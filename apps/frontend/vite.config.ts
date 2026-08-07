import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    /*
     * Offline reading is the app's central promise, and downloaded pages in
     * IndexedDB are worthless if the document that reads them cannot load. A
     * service worker precaching the shell is what makes the difference between
     * "your chapters are saved" and a WebView error page on a plane.
     *
     * It also covers the reader's code-split chunk. Without precaching, the
     * lazy import of the three.js bundle is a network request, so the one
     * screen that must work offline would be the one screen that cannot.
     */
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'script-defer',
      // Telegram supplies the app chrome and the launch entry point, so a web
      // app manifest would only add an install prompt no one can act on from
      // inside the client.
      manifest: false,
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,webp,woff2}'],
        navigateFallback: 'index.html',
        navigateFallbackDenylist: [/^\/api\//],
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: true,
        runtimeCaching: [
          {
            // Covers and streamed pages. Transcoded images are content
            // addressed and served immutable, so a cache hit can never be
            // stale, and having them survive offline keeps the catalog from
            // turning into a wall of placeholders.
            urlPattern: ({ url }) => url.pathname.startsWith('/api/image/'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'comic-images',
              expiration: { maxEntries: 300, maxAgeSeconds: 60 * 60 * 24 * 30 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
  resolve: {
    alias: {
      '@comic/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)),
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    // Telegram loads the Mini App over https from its own domain, so during
    // development the app is normally reached through a tunnel. Allow any host
    // header rather than fighting Vite's default host check.
    host: true,
    allowedHosts: true,
    proxy: {
      // Only used when VITE_API_BASE is unset and the app talks to a
      // same-origin /api path. The e2e run sets VITE_API_BASE instead.
      '/api': {
        target: `http://localhost:${process.env['BACKEND_PORT'] ?? 8787}`,
        changeOrigin: true,
      },
    },
  },
  optimizeDeps: {
    include: ['three', '@react-three/fiber', 'dexie', 'zustand'],
  },
  build: {
    target: 'es2022',
    // Telegram's Android WebView is often a few Chrome versions behind the
    // system browser; sourcemaps make the difference debuggable in the field.
    sourcemap: true,
    rollupOptions: {
      output: {
        // three is ~600 KB and is only needed once the reader opens, so it is
        // split into its own chunk to keep the catalog's first paint fast.
        manualChunks(id) {
          if (id.includes('node_modules/three') || id.includes('@react-three')) return 'three';
          if (id.includes('node_modules/react-dom') || id.includes('node_modules/react/')) {
            return 'react';
          }
          if (id.includes('node_modules/dexie')) return 'dexie';
          return undefined;
        },
      },
    },
  },
});
