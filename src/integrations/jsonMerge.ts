import { constants as fsConstants } from 'node:fs';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { writeFileAtomic } from '../core/fsx.js';

// Errors whose message is written for the user and safe to show.
export class IntegrationError extends Error {}

export type McpEntry = { command: string; args: string[] };

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

// Reads a JSON config file. Missing -> null. Empty -> {}. Invalid -> IntegrationError (nothing is touched).
export async function readJsonConfig(file: string): Promise<Record<string, unknown> | null> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new IntegrationError(`Could not read ${file}: ${(e as Error).message}. Nothing was changed.`);
  }
  text = text.replace(/^\uFEFF/, '');
  if (text.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new IntegrationError(`Could not read ${file}: invalid JSON. Fix or move it, nothing was changed.`);
  }
  if (!isObject(parsed)) {
    throw new IntegrationError(`Could not read ${file}: invalid JSON. Fix or move it, nothing was changed.`);
  }
  return parsed;
}

// Backups never overwrite: <file>.bak-<stamp>, then -2, -3, ... when the name is taken.
async function copyBackup(file: string): Promise<string> {
  const base = `${file}.bak-${stamp()}`;
  for (let n = 1; ; n++) {
    const target = n === 1 ? base : `${base}-${n}`;
    try {
      await copyFile(file, target, fsConstants.COPYFILE_EXCL);
      return target;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || n > 1000) throw e;
    }
  }
}

export async function mergeMcpServer(
  file: string,
  key: 'mcpServers',
  name: 'multiple-gmail',
  entry: McpEntry,
): Promise<{ backup: string | null; created: boolean }> {
  const existing = await readJsonConfig(file);
  const doc = existing ?? {};
  const current = doc[key];
  if (current !== undefined && !isObject(current)) {
    throw new IntegrationError(`Could not read ${file}: "${key}" is not an object. Fix or move it, nothing was changed.`);
  }
  doc[key] = { ...(current ?? {}), [name]: { command: entry.command, args: entry.args } };
  await mkdir(dirname(file), { recursive: true });
  let backup: string | null = null;
  if (existing !== null) {
    backup = await copyBackup(file);
  }
  await writeFileAtomic(file, `${JSON.stringify(doc, null, 2)}\n`);
  return { backup, created: existing === null };
}

// 'current': the entry runs `command` (this copy of multiple-gmail). 'outdated': an entry exists but runs something
// else, for example an older copy at another path. 'missing': no entry, or the file is absent or unreadable.
export type EntryState = 'missing' | 'current' | 'outdated';

// Windows paths are case-insensitive.
function sameCommand(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export async function mcpServerState(file: string, command: string, name = 'multiple-gmail'): Promise<EntryState> {
  try {
    const doc = await readJsonConfig(file);
    const servers = doc?.mcpServers;
    if (!isObject(servers) || !Object.hasOwn(servers, name)) return 'missing';
    const entry = servers[name];
    return isObject(entry) && typeof entry.command === 'string' && sameCommand(entry.command, command)
      ? 'current'
      : 'outdated';
  } catch {
    return 'missing';
  }
}

export type IntegrationStatus = { configured: boolean; outdated: boolean };

// Configured only when every file has the current entry; outdated when any file points at another command.
export async function combinedStatus(files: string[], command: string): Promise<IntegrationStatus> {
  if (files.length === 0) return { configured: false, outdated: false };
  const states = await Promise.all(files.map((f) => mcpServerState(f, command)));
  return { configured: states.every((s) => s === 'current'), outdated: states.includes('outdated') };
}
