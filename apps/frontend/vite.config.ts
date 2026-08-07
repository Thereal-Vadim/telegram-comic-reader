import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
      '/api': { target: 'http://localhost:8787', changeOrigin: true },
    },
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
          return undefined;
        },
      },
    },
  },
});
