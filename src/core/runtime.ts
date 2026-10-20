import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Replaced with `true` by esbuild (scripts/build-exe.mjs); undeclared, so typeof is 'undefined', in the ESM dev tree.
declare const __MG_BUNDLED__: boolean | undefined;

// True in build/main.cjs and the exe built from it.
export function isBundled(): boolean {
  return typeof __MG_BUNDLED__ !== 'undefined';
}

// Absolute path of the bundle file (build/main.cjs; process.execPath under SEA), or null in the dev tree.
export function bundleFile(): string | null {
  return isBundled() ? __filename : null;
}

// Absolute path of `rel` (posix, relative to src/) in the source tree. Dev: resolved from this module, which lives
// in src/core. Bundle: build/main.cjs sits in build/, next to src/.
export function srcPath(rel: string): string {
  const bundle = bundleFile();
  if (bundle) return resolve(bundle, '..', '..', 'src', ...rel.split('/'));
  return fileURLToPath(new URL(`../${rel}`, import.meta.url));
}
