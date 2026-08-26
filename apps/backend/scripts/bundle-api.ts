/**
 * Bundle the Fastify app into api/[[...path]].mjs for Vercel serverless.
 *
 * JS deps are inlined so the function does not rely on node_modules layout
 * under /var/task. Only native packages stay external (installed into api/).
 */
import { build } from 'esbuild';
import { rm, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(here, '..');
const repoRoot = path.resolve(backendRoot, '../..');
const apiDir = path.join(repoRoot, 'api');
// Catch-all so /api/home, /api/comics/… hit one function with the real path.
const outFile = path.join(apiDir, '[[...path]].mjs');

await mkdir(apiDir, { recursive: true });
await rm(outFile, { force: true });

await build({
  entryPoints: [path.join(backendRoot, 'src/vercelHandler.ts')],
  outfile: outFile,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: false,
  packages: 'bundle',
  // Native / browser binaries must resolve from api/node_modules at runtime.
  external: ['puppeteer-core', 'sharp', '@img/*', 'fsevents'],
  banner: {
    // Vercel ESM functions still need createRequire for some CJS native addons.
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  logLevel: 'info',
});

// Vercel packages this folder; npm install here avoids pnpm symlink holes.
await writeFile(
  path.join(apiDir, 'package.json'),
  `${JSON.stringify(
    {
      type: 'module',
      private: true,
      dependencies: {
        sharp: '0.35.3',
      },
    },
    null,
    2,
  )}\n`,
);

console.log(`wrote ${path.relative(repoRoot, outFile)}`);
