import { randomBytes } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { validateAlias } from './config.js';
import { open, seal } from './crypto.js';
import { writeFileAtomic, type WriteAtomicOptions } from './fsx.js';
import { getMasterKey } from './masterKey.js';
import { dataDir, tokenPath } from './paths.js';
import { ensureSecureDir } from './secureDir.js';

export type OAuthClient = {
  clientId: string;
  clientSecret: string;
  kind: 'installed' | 'web';
  redirectUris: string[];
};

export type StoredToken = {
  refreshToken: string;
  accessToken?: string;
  expiryDate?: number;
  scope: string;
};

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function parseClientJson(text: string): OAuthClient {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error('This file is not valid JSON. Download the OAuth client JSON from Google Cloud Console.');
  }
  if (!isObject(json)) throw new Error('This file is not a JSON object; expected a Google OAuth client JSON.');
  if (json.type === 'service_account') {
    throw new Error('This file is a service account key, not an OAuth client. Create an OAuth client ID (Desktop app).');
  }
  const kind = isObject(json.installed) ? 'installed' : isObject(json.web) ? 'web' : undefined;
  if (!kind) {
    throw new Error('This file is neither "installed" nor "web" (not an OAuth client JSON); download the correct JSON.');
  }
  const body = json[kind] as Record<string, unknown>;
  const clientId = body.client_id;
  const clientSecret = body.client_secret;
  if (typeof clientId !== 'string' || !clientId.trim()) throw new Error('OAuth client JSON is missing client_id.');
  if (typeof clientSecret !== 'string' || !clientSecret.trim()) {
    throw new Error('OAuth client JSON is missing client_secret.');
  }
  const uris = body.redirect_uris;
  const redirectUris = Array.isArray(uris) ? uris.filter((u): u is string => typeof u === 'string') : [];
  return { clientId, clientSecret, kind, redirectUris };
}

export async function writeSealed(file: string, value: Buffer, opts: WriteAtomicOptions = {}): Promise<void> {
  await ensureSecureDir(dataDir());
  await ensureSecureDir(dirname(file));
  await writeFileAtomic(file, seal(await getMasterKey(), value), opts);
}

export async function readSealed(file: string): Promise<Buffer | null> {
  let blob: Buffer;
  try {
    blob = await readFile(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  return open(await getMasterKey(), blob);
}

const clientFile = () => join(dataDir(), 'client.enc');
const apiKeyFile = () => join(dataDir(), 'local-api-key.enc');

export async function saveClient(c: OAuthClient): Promise<void> {
  await writeSealed(clientFile(), Buffer.from(JSON.stringify(c), 'utf8'));
}

export async function loadClient(): Promise<OAuthClient | null> {
  const buf = await readSealed(clientFile());
  return buf ? (JSON.parse(buf.toString('utf8')) as OAuthClient) : null;
}

export async function saveToken(alias: string, t: StoredToken): Promise<void> {
  const a = validateAlias(alias);
  await writeSealed(tokenPath(a), Buffer.from(JSON.stringify(t), 'utf8'));
}

export async function loadToken(alias: string): Promise<StoredToken | null> {
  const a = validateAlias(alias);
  const buf = await readSealed(tokenPath(a));
  return buf ? (JSON.parse(buf.toString('utf8')) as StoredToken) : null;
}

export async function deleteToken(alias: string): Promise<void> {
  const a = validateAlias(alias);
  await rm(tokenPath(a), { force: true });
}

export async function getLocalApiKey(): Promise<string> {
  const existing = await readSealed(apiKeyFile());
  if (existing) return existing.toString('utf8');
  const key = randomBytes(32).toString('base64url');
  try {
    await writeSealed(apiKeyFile(), Buffer.from(key, 'utf8'), { exclusive: true });
    return key;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  // Another caller or process created the key first: use theirs.
  const winner = await readSealed(apiKeyFile());
  if (!winner) throw new Error(`Local API key file ${apiKeyFile()} disappeared during creation.`);
  return winner.toString('utf8');
}

export async function rotateLocalApiKey(): Promise<string> {
  const key = randomBytes(32).toString('base64url');
  await writeSealed(apiKeyFile(), Buffer.from(key, 'utf8'));
  return key;
}
