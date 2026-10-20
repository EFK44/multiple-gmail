import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from './fsx.js';
import { dataDir } from './paths.js';
import { ensureSecureDir } from './secureDir.js';

const KEY_LEN = 32;
const KEY_FILE = 'master.key.dpapi';
const ENV_MESSAGE = 'Set MULTIPLE_GMAIL_MASTER_KEY (32 bytes base64). Generate with: multiple-gmail gen-key';
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

let cached: Promise<Buffer> | undefined;

export function getMasterKey(): Promise<Buffer> {
  if (!cached) {
    cached = loadMasterKey().catch((err: unknown) => {
      cached = undefined;
      throw err;
    });
  }
  return cached;
}

export function resetMasterKeyCacheForTests(): void {
  cached = undefined;
}

export function keyFromEnv(value: string | undefined): Buffer {
  const v = (value ?? '').trim();
  if (!v || v.length % 4 !== 0 || !BASE64_RE.test(v)) throw new Error(ENV_MESSAGE);
  const key = Buffer.from(v, 'base64');
  if (key.length !== KEY_LEN) throw new Error(ENV_MESSAGE);
  return key;
}

async function loadMasterKey(): Promise<Buffer> {
  if (process.platform !== 'win32') return keyFromEnv(process.env.MULTIPLE_GMAIL_MASTER_KEY);

  const dir = dataDir();
  await ensureSecureDir(dir);
  const file = join(dir, KEY_FILE);

  const existing = await readKeyFile(file);
  if (existing) return existing;

  const key = randomBytes(KEY_LEN);
  const protectedBytes = await dpapi('Protect', key);
  try {
    await writeFileAtomic(file, protectedBytes, { exclusive: true });
    return key;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  // Another process created the key first: use theirs.
  const winner = await readKeyFile(file);
  if (!winner) throw new Error(`Master key file ${file} disappeared during creation.`);
  return winner;
}

async function readKeyFile(file: string): Promise<Buffer | undefined> {
  let blob: Buffer;
  try {
    blob = await readFile(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  let key: Buffer;
  try {
    key = await dpapi('Unprotect', blob);
  } catch (err) {
    throw new Error(
      `Cannot decrypt master key file ${file} (it must be created by the same Windows user): ${(err as Error).message}`,
    );
  }
  if (key.length !== KEY_LEN) throw new Error(`Master key file ${file} is corrupt (wrong key length).`);
  return key;
}

// Bytes travel base64-encoded over stdin/stdout only; never in argv or env.
function dpapi(op: 'Protect' | 'Unprotect', input: Buffer): Promise<Buffer> {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName System.Security',
    '$in = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())',
    `$out = [System.Security.Cryptography.ProtectedData]::${op}($in, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)`,
    '[Console]::Out.Write([Convert]::ToBase64String($out))',
  ].join('; ');
  return new Promise((resolve, reject) => {
    const child = execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`DPAPI ${op} failed: ${String(stderr).trim() || err.message}`));
          return;
        }
        const out = String(stdout).trim();
        if (!out || !BASE64_RE.test(out)) {
          reject(new Error(`DPAPI ${op} returned no usable output.`));
          return;
        }
        resolve(Buffer.from(out, 'base64'));
      },
    );
    child.stdin?.on('error', () => {});
    child.stdin?.end(input.toString('base64'));
  });
}
