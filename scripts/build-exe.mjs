// Builds build/main.cjs (esbuild bundle) and, unless --bundle-only, the single executable for this OS (Node SEA)
// with every file under src/web embedded as an asset keyed "web/<path>":
//   Windows build/multiple-gmail.exe, macOS and Linux build/multiple-gmail.
// --asset-name=<name> (or MG_ASSET_NAME) also copies the result to build/release/<name> for a GitHub Release.
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = join(ROOT, 'build');
const PLATFORM = process.platform;
const EXE_NAME = PLATFORM === 'win32' ? 'multiple-gmail.exe' : 'multiple-gmail';
const EXE = join(BUILD, EXE_NAME);
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
const bundleOnly = process.argv.includes('--bundle-only');
const assetArg = process.argv.find((a) => a.startsWith('--asset-name='));
const assetName = assetArg ? assetArg.slice('--asset-name='.length) : process.env.MG_ASSET_NAME || '';
if (assetName && !/^[a-z0-9][a-z0-9._-]*$/.test(assetName)) throw new Error(`Invalid asset name "${assetName}".`);
const started = Date.now();

function run(command, args) {
  const r = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit' });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${command} ${args.join(' ')} exited with ${r.status}`);
}

function listFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? listFiles(join(dir, e.name)) : e.isFile() ? [join(dir, e.name)] : [],
  );
}

const toPosix = (p) => p.split(sep).join('/');

mkdirSync(BUILD, { recursive: true });

// import.meta.url does not exist in CJS: it becomes the bundle's own file URL (process.execPath under SEA).
// __MG_BUNDLED__ lets src/core/runtime.ts tell the bundle from the ESM dev tree.
await build({
  entryPoints: [join(ROOT, 'src', 'main.ts')],
  outfile: join(BUILD, 'main.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'warning',
  banner: { js: "const __mgImportMetaUrl = require('node:url').pathToFileURL(__filename).href;" },
  define: { 'import.meta.url': '__mgImportMetaUrl', __MG_BUNDLED__: 'true' },
});
console.log('bundled build/main.cjs');

if (!bundleOnly) {
  const assets = {};
  for (const file of listFiles(join(ROOT, 'src', 'web')).sort()) {
    assets[`web/${toPosix(relative(join(ROOT, 'src', 'web'), file))}`] = toPosix(relative(ROOT, file));
  }
  const seaConfig = {
    main: 'build/main.cjs',
    output: 'build/sea-prep.blob',
    disableExperimentalSEAWarning: true,
    useCodeCache: false,
    assets,
  };
  writeFileSync(join(BUILD, 'sea-config.json'), JSON.stringify(seaConfig, null, 2) + '\n');
  run(process.execPath, ['--experimental-sea-config', 'build/sea-config.json']);

  rmSync(EXE, { force: true });
  copyFileSync(process.execPath, EXE);
  if (PLATFORM !== 'win32') chmodSync(EXE, 0o755);
  if (PLATFORM === 'win32') {
    // Optional on Windows: strip node's Authenticode signature, which the injection invalidates anyway.
    const sign = spawnSync('signtool', ['remove', '/s', EXE], { cwd: ROOT, stdio: 'ignore' });
    if (sign.error || sign.status !== 0) console.log('signtool not available or failed; skipping signature removal');
  } else if (PLATFORM === 'darwin') {
    // Required on macOS: the injection breaks node's signature, and arm64 refuses to run unsigned code.
    run('/usr/bin/codesign', ['--remove-signature', EXE]);
  }
  const postject = [
    join(ROOT, 'node_modules', 'postject', 'dist', 'cli.js'),
    EXE,
    'NODE_SEA_BLOB',
    join(BUILD, 'sea-prep.blob'),
    '--sentinel-fuse',
    FUSE,
  ];
  if (PLATFORM === 'darwin') postject.push('--macho-segment-name', 'NODE_SEA');
  run(process.execPath, postject);
  // Ad-hoc signature (no identity): enough for arm64 to run it; Gatekeeper still treats a download as unidentified.
  if (PLATFORM === 'darwin') run('/usr/bin/codesign', ['--sign', '-', EXE]);
  const mb = (statSync(EXE).size / 1024 / 1024).toFixed(1);
  console.log(`built build/${EXE_NAME} (${mb} MB)`);
  if (assetName) {
    const RELEASE = join(BUILD, 'release');
    mkdirSync(RELEASE, { recursive: true });
    copyFileSync(EXE, join(RELEASE, assetName));
    if (PLATFORM !== 'win32') chmodSync(join(RELEASE, assetName), 0o755);
    console.log(`copied to build/release/${assetName}`);
  }
}
console.log(`done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
