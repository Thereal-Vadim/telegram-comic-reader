import { build } from 'esbuild';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Production bundle.
 *
 * `tsc` cannot emit this on its own. `@comic/shared` is a workspace package
 * that exports TypeScript source, so a plain compile either drags it outside
 * `rootDir` or emits an import specifier that resolves, at runtime, to a `.ts`
 * file Node will not load. Bundling resolves the workspace source at build
 * time and leaves real dependencies alone, which also keeps `sharp` loading
 * its platform-specific binary from node_modules instead of being inlined.
 *
 * Type checking is a separate step (`pnpm typecheck`) rather than a side
 * effect of the build; esbuild does not type check and pretending otherwise
 * would hide errors behind a green build.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

interface PackageJson {
  dependencies?: Record<string, string>;
}

const pkg = JSON.parse(
  await readFile(path.join(root, 'package.json'), 'utf8'),
) as PackageJson;

// Everything published to npm stays external; only workspace packages are
// pulled in, since they have no installable form of their own.
const external = Object.keys(pkg.dependencies ?? {}).filter(
  (name) => !name.startsWith('@comic/'),
);

// Cleaned rather than overwritten, so output from an earlier layout cannot be
// left behind and quietly started by `pnpm start`.
await rm(path.join(root, 'dist'), { recursive: true, force: true });

await build({
  entryPoints: [path.join(root, 'src/index.ts')],
  outfile: path.join(root, 'dist/index.js'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  external,
  logLevel: 'info',
});
