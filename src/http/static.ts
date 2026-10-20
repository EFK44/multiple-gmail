import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { getAsset, isSea } from 'node:sea';
import { srcPath } from '../core/runtime.js';

// Dev and `node build/main.cjs`: files live in src/web. Packaged exe: SEA assets keyed "web/<posix path>".
const WEB_DIR = srcPath('web');

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

async function readFromDisk(segments: string[]): Promise<Buffer | null> {
  const root = resolve(WEB_DIR);
  const file = resolve(root, ...segments);
  if (!file.startsWith(root + sep)) return null;
  try {
    if (!(await stat(file)).isFile()) return null;
    return await readFile(file);
  } catch {
    return null;
  }
}

function readFromSea(segments: string[]): Buffer | null {
  try {
    return Buffer.from(getAsset(`web/${segments.join('/')}`) as ArrayBuffer);
  } catch {
    return null; // getAsset throws for an unknown key
  }
}

// Returns the file for a URL path (no query), or null for anything missing, hidden, or outside the web dir.
// The same validation runs before either reader.
export async function readStatic(urlPath: string): Promise<{ body: Buffer; type: string } | null> {
  if (!urlPath.startsWith('/')) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded === '/') decoded = '/index.html';
  if (decoded.includes('\0') || decoded.includes('\\') || decoded.includes(':')) return null;
  const segments = decoded.slice(1).split('/');
  if (segments.some((s) => s === '' || s.startsWith('.'))) return null;
  const type = TYPES[extname(decoded).toLowerCase()];
  if (!type) return null;
  const body = isSea() ? readFromSea(segments) : await readFromDisk(segments);
  return body ? { body, type } : null;
}
