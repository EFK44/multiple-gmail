import { readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative } from 'node:path';
import { dataDir } from '../core/paths.js';
import { friendly } from './errors.js';

export type AttachmentInput = { path: string; filename?: string };
export type LoadedAttachment = { filename: string; content: Buffer };

// Gmail's limit for attachments on one message.
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

// Files and folders under the home directory that hold credentials, keychains or browser profiles (saved passwords,
// cookies). Listed for every OS: a path that does not exist on this one never matches. The app's data folder is added.
const SENSITIVE_HOME_DIRS = [
  '.ssh',
  '.gnupg',
  '.aws',
  '.azure',
  '.kube',
  '.docker',
  '.netrc',
  '.git-credentials',
  '.npmrc',
  '.pypirc',
  '.mozilla',
  join('.config', 'gcloud'),
  join('.config', 'gh'),
  join('.config', 'google-chrome'),
  join('.config', 'chromium'),
  join('.config', 'BraveSoftware'),
  join('.config', 'microsoft-edge'),
  join('AppData', 'Local', 'Google', 'Chrome', 'User Data'),
  join('AppData', 'Local', 'Microsoft', 'Edge', 'User Data'),
  join('AppData', 'Local', 'BraveSoftware'),
  join('AppData', 'Local', 'Microsoft', 'Credentials'),
  join('AppData', 'Roaming', 'Microsoft', 'Credentials'),
  join('AppData', 'Roaming', 'Microsoft', 'Protect'),
  join('AppData', 'Roaming', 'Mozilla'),
  join('Library', 'Keychains'),
  join('Library', 'Cookies'),
  join('Library', 'Application Support', 'Google', 'Chrome'),
  join('Library', 'Application Support', 'Microsoft Edge'),
  join('Library', 'Application Support', 'BraveSoftware'),
  join('Library', 'Application Support', 'Firefox'),
];

type Opts = { home?: string; dataDir?: string; platform?: NodeJS.Platform };

async function real(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    return p;
  }
}

function inside(root: string, target: string, fold: boolean): boolean {
  const r = fold ? root.toLowerCase() : root;
  const t = fold ? target.toLowerCase() : target;
  const rel = relative(r, t);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

// Validates and reads local files for a message. Checks run on the resolved path, so a link cannot reach a denied
// folder. Every file is checked and sized before any is read.
export async function loadAttachments(items: AttachmentInput[] | undefined, opts: Opts = {}): Promise<LoadedAttachment[]> {
  if (!items?.length) return [];
  const home = opts.home ?? homedir();
  const platform = opts.platform ?? process.platform;
  const fold = platform === 'win32' || platform === 'darwin';
  const roots = await Promise.all(
    [opts.dataDir ?? dataDir(), ...SENSITIVE_HOME_DIRS.map((d) => join(home, d))].map(async (d) => [d, await real(d)]),
  );

  const checked: { path: string; filename: string }[] = [];
  let total = 0;
  for (const item of items) {
    if (!isAbsolute(item.path)) throw friendly(`Attachment path must be absolute: ${item.path}`);
    let resolved: string;
    try {
      resolved = await realpath(item.path);
    } catch {
      throw friendly(`Attachment not found: ${item.path}`);
    }
    if (roots.some((pair) => pair.some((r) => inside(r, resolved, fold)))) {
      throw friendly(`Attaching files from this folder is not allowed: ${item.path}`);
    }
    const st = await stat(resolved);
    if (!st.isFile()) throw friendly(`Attachment is not a file: ${item.path}`);
    total += st.size;
    if (total > MAX_ATTACHMENT_BYTES) throw friendly('Attachments exceed Gmail\'s 25 MB limit per message.');
    checked.push({ path: resolved, filename: item.filename || basename(item.path) });
  }
  const out: LoadedAttachment[] = [];
  for (const c of checked) {
    out.push({ filename: c.filename, content: await readFile(c.path) });
  }
  // A file may have grown between the size check and the read.
  if (out.reduce((n, a) => n + a.content.length, 0) > MAX_ATTACHMENT_BYTES) {
    throw friendly('Attachments exceed Gmail\'s 25 MB limit per message.');
  }
  return out;
}
