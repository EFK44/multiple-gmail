import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Dev: files live in src/web next to this module. Task 12 swaps the reader for SEA assets behind readStatic.
const WEB_DIR = fileURLToPath(new URL('../web/', import.meta.url));

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

// Returns the file for a URL path (no query), or null for anything missing, hidden, or outside the web dir.
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
  const root = resolve(WEB_DIR);
  const file = resolve(root, ...segments);
  if (!file.startsWith(root + sep)) return null;
  try {
    if (!(await stat(file)).isFile()) return null;
    return { body: await readFile(file), type };
  } catch {
    return null;
  }
}
