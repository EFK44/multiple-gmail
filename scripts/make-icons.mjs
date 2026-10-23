// Renders the app icon from assets/icon/*.svg into the committed icon files. Run after changing an SVG:
//   node scripts/make-icons.mjs
// icon-small.svg (one badge) is used up to 24 px, where the three badges of icon.svg blur together.
// Writes assets/icon/icon.ico (Windows exe), assets/icon/icon.icns (macOS .app), assets/icon/icon-512.png,
// and copies icon.svg to src/web/img/icon.svg (wizard) and docs/icon.svg (project site).
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'assets', 'icon');
const SVG = readFileSync(join(DIR, 'icon.svg'), 'utf8');
const SMALL_SVG = readFileSync(join(DIR, 'icon-small.svg'), 'utf8');

const cache = new Map();
function png(size) {
  if (!cache.has(size)) {
    const svg = size <= 24 ? SMALL_SVG : SVG;
    cache.set(size, Buffer.from(new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng()));
  }
  return cache.get(size);
}

// ICO with PNG-compressed images (Windows Vista and later).
function ico(sizes) {
  const images = sizes.map(png);
  const header = Buffer.alloc(6 + 16 * sizes.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  sizes.forEach((size, i) => {
    const e = 6 + 16 * i;
    header.writeUInt8(size >= 256 ? 0 : size, e);
    header.writeUInt8(size >= 256 ? 0 : size, e + 1);
    header.writeUInt16LE(1, e + 4);
    header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(images[i].length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += images[i].length;
  });
  return Buffer.concat([header, ...images]);
}

// ICNS with PNG entries; the @2x types reuse the next larger rendering.
function icns(entries) {
  const parts = entries.map(([type, size]) => {
    const data = png(size);
    const head = Buffer.alloc(8);
    head.write(type, 0, 'ascii');
    head.writeUInt32BE(data.length + 8, 4);
    return Buffer.concat([head, data]);
  });
  const head = Buffer.alloc(8);
  head.write('icns', 0, 'ascii');
  head.writeUInt32BE(8 + parts.reduce((n, p) => n + p.length, 0), 4);
  return Buffer.concat([head, ...parts]);
}

writeFileSync(join(DIR, 'icon.ico'), ico([16, 24, 32, 48, 64, 128, 256]));
writeFileSync(
  join(DIR, 'icon.icns'),
  icns([
    ['icp4', 16],
    ['icp5', 32],
    ['icp6', 64],
    ['ic07', 128],
    ['ic08', 256],
    ['ic09', 512],
    ['ic10', 1024],
    ['ic11', 32],
    ['ic12', 64],
    ['ic13', 256],
    ['ic14', 512],
  ]),
);
writeFileSync(join(DIR, 'icon-512.png'), png(512));
copyFileSync(join(DIR, 'icon.svg'), join(ROOT, 'src', 'web', 'img', 'icon.svg'));
copyFileSync(join(DIR, 'icon.svg'), join(ROOT, 'docs', 'icon.svg'));
console.log('wrote assets/icon/icon.ico, icon.icns, icon-512.png, src/web/img/icon.svg, docs/icon.svg');
