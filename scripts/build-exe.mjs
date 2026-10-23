// Builds build/main.cjs (esbuild bundle) and, unless --bundle-only, the single executable for this OS (Node SEA)
// with every file under src/web embedded as an asset keyed "web/<path>":
//   Windows build/multiple-gmail.exe (with the app icon), macOS and Linux build/multiple-gmail,
//   and on macOS also build/multiple-gmail.app.
// --asset-name=<name> (or MG_ASSET_NAME) also copies the result to build/release/<name> for a GitHub Release
// (on macOS plus build/release/<name>.zip with the .app).
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import * as ResEdit from 'resedit';

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

const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const ICON_DIR = join(ROOT, 'assets', 'icon');

// Windows: replace node's icon and version strings (Explorer, taskbar, Task Manager) with multiple-gmail's.
// Runs before the injection, on the plain node.exe copy; ignoreCert drops node's signature, which breaks anyway.
function setWindowsResources(file) {
  const exe = ResEdit.NtExecutable.from(readFileSync(file), { ignoreCert: true });
  const res = ResEdit.NtExecutableResource.from(exe);
  const icons = ResEdit.Data.IconFile.from(readFileSync(join(ICON_DIR, 'icon.ico'))).icons.map((i) => i.data);
  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
  if (groups.length === 0) throw new Error('node.exe has no icon group to replace');
  for (const g of groups) ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, g.id, g.lang, icons);
  const [vi] = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
  if (!vi) throw new Error('node.exe has no version info to replace');
  const [major, minor, patch] = VERSION.split('.').map(Number);
  for (const lang of vi.getAllLanguagesForStringValues()) {
    vi.setFileVersion(major, minor, patch, 0, lang.lang);
    vi.setProductVersion(major, minor, patch, 0, lang.lang);
    vi.setStringValues(lang, {
      CompanyName: 'EFK44',
      FileDescription: 'multiple-gmail',
      InternalName: 'multiple-gmail',
      LegalCopyright: 'MIT License',
      OriginalFilename: 'multiple-gmail.exe',
      ProductName: 'multiple-gmail',
    });
  }
  vi.outputToResourceEntries(res.entries);
  res.outputResource(exe);
  writeFileSync(file, Buffer.from(exe.generate()));
}

// macOS: build/multiple-gmail.app around the signed executable. Double-clicked from Finder, the program reopens
// itself in Terminal (src/core/macApp.ts). LSUIElement keeps that short first launch out of the Dock.
function buildMacApp(exe) {
  const app = join(BUILD, 'multiple-gmail.app');
  rmSync(app, { recursive: true, force: true });
  mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true });
  mkdirSync(join(app, 'Contents', 'Resources'), { recursive: true });
  const plist = {
    CFBundleDevelopmentRegion: 'en',
    CFBundleDisplayName: 'multiple-gmail',
    CFBundleExecutable: 'multiple-gmail',
    CFBundleIconFile: 'icon.icns',
    CFBundleIdentifier: 'io.github.efk44.multiple-gmail',
    CFBundleInfoDictionaryVersion: '6.0',
    CFBundleName: 'multiple-gmail',
    CFBundlePackageType: 'APPL',
    CFBundleShortVersionString: VERSION,
    CFBundleVersion: VERSION,
    LSMinimumSystemVersion: '13.5',
    LSUIElement: true,
    NSHighResolutionCapable: true,
  };
  const value = (v) => (v === true ? '<true/>' : `<string>${v}</string>`);
  const body = Object.entries(plist).map(([k, v]) => `\t<key>${k}</key>\n\t${value(v)}`).join('\n');
  writeFileSync(
    join(app, 'Contents', 'Info.plist'),
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
      `<plist version="1.0">\n<dict>\n${body}\n</dict>\n</plist>\n`,
  );
  writeFileSync(join(app, 'Contents', 'PkgInfo'), 'APPL????');
  copyFileSync(join(ICON_DIR, 'icon.icns'), join(app, 'Contents', 'Resources', 'icon.icns'));
  const inner = join(app, 'Contents', 'MacOS', 'multiple-gmail');
  copyFileSync(exe, inner);
  chmodSync(inner, 0o755);
  run('/usr/bin/plutil', ['-lint', join(app, 'Contents', 'Info.plist')]);
  // Ad-hoc signature of the whole bundle (seals Info.plist and the icon); no Apple identity.
  run('/usr/bin/codesign', ['--force', '--sign', '-', app]);
  run('/usr/bin/codesign', ['--verify', '--strict', '--verbose=2', app]);
  console.log('built build/multiple-gmail.app');
  return app;
}

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
    setWindowsResources(EXE);
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
  const app = PLATFORM === 'darwin' ? buildMacApp(EXE) : null;
  if (assetName) {
    const RELEASE = join(BUILD, 'release');
    mkdirSync(RELEASE, { recursive: true });
    copyFileSync(EXE, join(RELEASE, assetName));
    if (PLATFORM !== 'win32') chmodSync(join(RELEASE, assetName), 0o755);
    console.log(`copied to build/release/${assetName}`);
    if (app) {
      // ditto keeps the bundle's permissions and signature; Finder's Archive Utility unpacks it.
      rmSync(join(RELEASE, `${assetName}.zip`), { force: true });
      run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, join(RELEASE, `${assetName}.zip`)]);
      console.log(`zipped to build/release/${assetName}.zip`);
    }
  }
}
console.log(`done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
