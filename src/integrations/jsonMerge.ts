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
  text = text.replace(/^﻿/, '');
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
    backup = `${file}.bak-${stamp()}`;
    await copyFile(file, backup);
  }
  await writeFileAtomic(file, `${JSON.stringify(doc, null, 2)}\n`);
  return { backup, created: existing === null };
}

export async function hasMcpServer(file: string, name = 'multiple-gmail'): Promise<boolean> {
  try {
    const doc = await readJsonConfig(file);
    const servers = doc?.mcpServers;
    return isObject(servers) && name in servers;
  } catch {
    return false;
  }
}
