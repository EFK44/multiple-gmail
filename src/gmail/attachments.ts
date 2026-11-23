import { readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
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
  '.thunderbird',
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

// The same kind of data under %APPDATA% (Roaming) and %LOCALAPPDATA%, wherever those point.
const SENSITIVE_APPDATA_DIRS = [
  'gcloud',
  'GitHub CLI',
  'Mozilla',
  'Thunderbird',
  'Opera Software',
  join('Microsoft', 'Credentials'),
  join('Microsoft', 'Protect'),
];
const SENSITIVE_LOCALAPPDATA_DIRS = [
  join('Google', 'Chrome', 'User Data'),
  join('Microsoft', 'Edge', 'User Data'),
  'BraveSoftware',
  'Vivaldi',
  join('Microsoft', 'Credentials'),
];

type Opts = {
  home?: string;
  dataDir?: string;
  platform?: NodeJS.Platform;
  appData?: string;
  localAppData?: string;
};

// A UNC or device path makes Windows open a network connection (and send NTLM credentials) before any check runs,
// and an SMB path to this machine would bypass the folder checks. Only drive-letter paths are accepted there.
const DRIVE_PATH = /^[A-Za-z]:[\\/]/;
const UNC_PATH = /^[\\/]{2}/;
const NETWORK_PATH = (p: string) =>
  friendly(`Network and device paths cannot be attached; use a drive letter path like C:\\...: ${p}`);

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
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !rel.startsWith('../') && !isAbsolute(rel));
}

// Validates and reads local files for a message. Checks run on the resolved path, so a link cannot reach a denied
// folder. Every file is checked and sized before any is read.
export async function loadAttachments(items: AttachmentInput[] | undefined, opts: Opts = {}): Promise<LoadedAttachment[]> {
  if (!items?.length) return [];
  const home = opts.home ?? homedir();
  const platform = opts.platform ?? process.platform;
  const fold = platform === 'win32' || platform === 'darwin';
  const appData = opts.appData ?? process.env.APPDATA;
  const localAppData = opts.localAppData ?? process.env.LOCALAPPDATA;
  const denied = [
    opts.dataDir ?? dataDir(),
    ...SENSITIVE_HOME_DIRS.map((d) => join(home, d)),
    ...(appData ? SENSITIVE_APPDATA_DIRS.map((d) => join(appData, d)) : []),
    ...(localAppData ? SENSITIVE_LOCALAPPDATA_DIRS.map((d) => join(localAppData, d)) : []),
  ];
  const roots = await Promise.all(denied.map(async (d) => [d, await real(d)]));

  const checked: { path: string; filename: string }[] = [];
  let total = 0;
  for (const item of items) {
    if (!isAbsolute(item.path) && !UNC_PATH.test(item.path)) {
      throw friendly(`Attachment path must be absolute: ${item.path}`);
    }
    if (platform === 'win32' && (UNC_PATH.test(item.path) || !DRIVE_PATH.test(item.path))) throw NETWORK_PATH(item.path);
    let resolved: string;
    try {
      resolved = await realpath(item.path);
    } catch {
      throw friendly(`Attachment not found: ${item.path}`);
    }
    if (platform === 'win32' && UNC_PATH.test(resolved)) throw NETWORK_PATH(item.path);
    if (roots.some((pair) => pair.some((r) => inside(r, resolved, fold)))) {
      throw friendly(`Attaching files from this folder is not allowed: ${item.path}`);
    }
    const st = await stat(resolved).catch(() => {
      throw friendly(`Could not read attachment: ${item.path}`);
    });
    if (!st.isFile()) throw friendly(`Attachment is not a file: ${item.path}`);
    total += st.size;
    if (total > MAX_ATTACHMENT_BYTES) throw friendly('Attachments exceed Gmail\'s 25 MB limit per message.');
    checked.push({ path: resolved, filename: item.filename || basename(item.path) });
  }
  const out: LoadedAttachment[] = [];
  for (const c of checked) {
    const content = await readFile(c.path).catch(() => {
      throw friendly(`Could not read attachment: ${c.path}`);
    });
    out.push({ filename: c.filename, content });
  }
  // A file may have grown between the size check and the read.
  if (out.reduce((n, a) => n + a.content.length, 0) > MAX_ATTACHMENT_BYTES) {
    throw friendly('Attachments exceed Gmail\'s 25 MB limit per message.');
  }
  return out;
}
