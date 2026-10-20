import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { open, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from './fsx.js';
import { dataDir } from './paths.js';
import { ensureSecureDir } from './secureDir.js';
import { isExecutableFile, posixBinary, system32Dir, systemBinary, type IsExecutable } from './sysbin.js';

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

// Remote mode: the key always comes from MULTIPLE_GMAIL_MASTER_KEY (also on Windows), validated at startup.
export function useMasterKey(key: Buffer): void {
  if (key.length !== KEY_LEN) throw new Error(ENV_MESSAGE);
  cached = Promise.resolve(Buffer.from(key));
}

export function keyFromEnv(value: string | undefined): Buffer {
  const v = (value ?? '').trim();
  if (!v || v.length % 4 !== 0 || !BASE64_RE.test(v)) throw new Error(ENV_MESSAGE);
  const key = Buffer.from(v, 'base64');
  if (key.length !== KEY_LEN) throw new Error(ENV_MESSAGE);
  return key;
}

async function loadMasterKey(): Promise<Buffer> {
  if (process.platform !== 'win32') return loadPosixMasterKey();

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
      systemBinary('powershell'),
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, maxBuffer: 1024 * 1024, cwd: system32Dir() },
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

// ---------------------------------------------------------------------------------------------------------------
// macOS and Linux. Order: MULTIPLE_GMAIL_MASTER_KEY (remote, Docker), then the OS keystore:
//   macOS: login Keychain item (account multiple-gmail, service multiple-gmail-master-key) via /usr/bin/security.
//   Linux: an existing <data>/master.key file, else the Secret Service via secret-tool when installed, else a new
//          0600 master.key file in the 0700 data folder (protected only by file permissions; warned once).
// A key that exists but cannot be read (access denied, locked keyring, corrupt value) is an error, never a reason to
// make a new key: a new key would silently orphan every token sealed with the old one.

export const KEYCHAIN_ACCOUNT = 'multiple-gmail';
export const KEYCHAIN_SERVICE = 'multiple-gmail-master-key';
const SECRET_ATTRS = ['service', 'multiple-gmail', 'key', 'master'];
const PLAIN_KEY_FILE = 'master.key';
const SECURITY_NOT_FOUND = 44; // errSecItemNotFound

// `stderr` is always the raw child stderr. `failure` is set when the process did not run to a normal exit:
// 'spawn' (could not start, output too large) or 'timeout' (killed by the timeout or a signal); `detail` explains it.
export type KeyRunResult = {
  code: number;
  stdout: string;
  stderr: string;
  failure?: 'spawn' | 'timeout';
  detail?: string;
};
const RUN_TIMEOUT_MS = 30_000;
// The lock holder makes at most three runner calls (lookup, store, lookup), each bounded by RUN_TIMEOUT_MS.
const LOCK_STALE_MS = 3 * RUN_TIMEOUT_MS + 30_000;
// Runs an absolute-path binary without a shell; `input` goes to stdin.
export type KeyRunner = (file: string, args: string[], input?: string) => Promise<KeyRunResult>;

export type PosixKeyDeps = {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  dir: string;
  run: KeyRunner;
  isExec: IsExecutable;
  warn: (message: string) => void;
  ensureDir: (dir: string) => Promise<void>;
  // macOS only: a specific keychain file instead of the default search list (used by the CI integration test).
  keychain?: string;
};

let warnedPlainFile = false;

type ExecErrorShape = { code?: unknown; killed?: boolean; signal?: unknown; message?: string } | null | undefined;

// Maps execFile's callback arguments to a KeyRunResult. A normal non-zero exit has a numeric err.code and keeps the
// raw (possibly empty) stderr, so "exit 1, no output" stays distinguishable from a real failure.
export function toKeyRunResult(err: ExecErrorShape, stdout: unknown, stderr: unknown): KeyRunResult {
  const out = String(stdout ?? '');
  const errText = String(stderr ?? '');
  if (!err) return { code: 0, stdout: out, stderr: errText };
  if (err.killed || (typeof err.signal === 'string' && err.signal)) {
    return { code: -1, stdout: out, stderr: errText, failure: 'timeout', detail: `timed out or killed (${String(err.signal ?? 'killed')})` };
  }
  if (typeof err.code === 'number') return { code: err.code, stdout: out, stderr: errText };
  return { code: -1, stdout: out, stderr: errText, failure: 'spawn', detail: err.message || String(err.code ?? 'spawn failed') };
}

const describeRun = (r: KeyRunResult) => r.detail ?? (r.stderr.trim() || `exit code ${r.code}`);

export const realKeyRunner: KeyRunner = (file, args, input) => {
  if (process.env.VITEST && process.env.MULTIPLE_GMAIL_REAL_KEYSTORE_TEST !== '1') {
    return Promise.reject(new Error('Tests must not touch the real OS keystore; inject a runner.'));
  }
  return new Promise((resolve) => {
    const child = execFile(file, args, { cwd: '/', timeout: RUN_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) =>
      resolve(toKeyRunResult(err, stdout, stderr)),
    );
    child.stdin?.on('error', () => {});
    child.stdin?.end(input ?? '');
  });
};

function parseStoredKey(text: string, where: string): Buffer {
  const v = text.trim();
  const key = v.length % 4 === 0 && BASE64_RE.test(v) ? Buffer.from(v, 'base64') : Buffer.alloc(0);
  if (key.length !== KEY_LEN) throw new Error(`The master key in ${where} is corrupt (expected 32 bytes base64).`);
  return key;
}

export async function loadPosixMasterKey(partial: Partial<PosixKeyDeps> = {}): Promise<Buffer> {
  const d: PosixKeyDeps = {
    platform: partial.platform ?? process.platform,
    env: partial.env ?? process.env,
    dir: partial.dir ?? dataDir(),
    run: partial.run ?? realKeyRunner,
    isExec: partial.isExec ?? isExecutableFile,
    warn: partial.warn ?? ((s) => console.error(s)),
    ensureDir: partial.ensureDir ?? ensureSecureDir,
    ...(partial.keychain ? { keychain: partial.keychain } : {}),
  };
  if ((d.env.MULTIPLE_GMAIL_MASTER_KEY ?? '').trim()) return keyFromEnv(d.env.MULTIPLE_GMAIL_MASTER_KEY);
  if (d.platform === 'darwin') return keychainMasterKey(d);
  return linuxMasterKey(d);
}

// --- macOS Keychain ---

async function keychainRead(d: PosixKeyDeps, security: string): Promise<Buffer | undefined> {
  const kc = d.keychain ? [d.keychain] : [];
  const r = await d.run(security, ['find-generic-password', '-a', KEYCHAIN_ACCOUNT, '-s', KEYCHAIN_SERVICE, '-w', ...kc]);
  if (!r.failure && r.code === SECURITY_NOT_FOUND) return undefined;
  if (r.failure || r.code !== 0) {
    throw new Error(
      `Could not read the multiple-gmail master key from the macOS Keychain: ${describeRun(r)}. ` +
        'Unlock the Keychain and allow access when macOS asks, or set MULTIPLE_GMAIL_MASTER_KEY.',
    );
  }
  return parseStoredKey(r.stdout, 'the macOS Keychain item multiple-gmail-master-key');
}

async function keychainMasterKey(d: PosixKeyDeps): Promise<Buffer> {
  const security = posixBinary('security', d.isExec);
  if (!security) throw new Error(`macOS security tool not found at /usr/bin/security. ${ENV_MESSAGE}`);
  const existing = await keychainRead(d, security);
  if (existing) return existing;

  const b64 = randomBytes(KEY_LEN).toString('base64');
  const kc = d.keychain ? [d.keychain] : [];
  // Create only (no -U): if another process created the item meanwhile, this add fails and its key is read back.
  // First choice: `security -i` reads the command from stdin, so the key never appears in any process argv.
  if (!d.keychain || !/[\s"'\\]/.test(d.keychain)) {
    const line = ['add-generic-password', '-a', KEYCHAIN_ACCOUNT, '-s', KEYCHAIN_SERVICE, '-w', b64, ...kc].join(' ');
    await d.run(security, ['-i'], `${line}\n`);
  }
  let stored = await keychainRead(d, security);
  if (!stored) {
    // Fallback: `-w <value>` in argv, visible to same-user process listings only for the few milliseconds the
    // one-time add takes. security has no non-interactive stdin option for the password.
    await d.run(security, ['add-generic-password', '-a', KEYCHAIN_ACCOUNT, '-s', KEYCHAIN_SERVICE, '-w', b64, ...kc]);
    stored = await keychainRead(d, security);
  }
  if (!stored) throw new Error(`Could not store the master key in the macOS Keychain. ${ENV_MESSAGE}`);
  return stored;
}

// --- Linux and other POSIX systems ---

async function readPlainKey(file: string): Promise<Buffer | undefined> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  return parseStoredKey(text, file);
}

class KeyringUnavailable extends Error {}

async function secretToolLookup(d: PosixKeyDeps, tool: string): Promise<Buffer | undefined> {
  const r = await d.run(tool, ['lookup', ...SECRET_ATTRS]);
  if (r.failure) throw new KeyringUnavailable(describeRun(r));
  if (r.code === 0 && r.stdout.trim()) return parseStoredKey(r.stdout, 'the Secret Service item multiple-gmail');
  // Not found: exit 1 (or 0 with no output) and nothing on stderr. Anything on stderr means the keyring itself failed.
  if (r.stderr.trim() || (r.code !== 0 && r.code !== 1)) throw new KeyringUnavailable(describeRun(r));
  return undefined;
}

// Serializes first-time creation across processes with an O_EXCL lock file in the data folder.
async function withLock<T>(lock: string, fn: () => Promise<T>): Promise<T> {
  // A lock older than the holder's worst case is stale (crashed holder); waiters wait at least that long.
  const deadline = Date.now() + LOCK_STALE_MS + 10_000;
  for (;;) {
    try {
      await (await open(lock, 'wx', 0o600)).close();
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const age = await stat(lock).then(
        (s) => Date.now() - s.mtimeMs,
        () => 0,
      );
      if (age > LOCK_STALE_MS) await rm(lock, { force: true });
      else if (Date.now() > deadline) throw new Error(`Timed out waiting for ${lock}.`);
      else await new Promise((r) => setTimeout(r, 50));
    }
  }
  try {
    return await fn();
  } finally {
    await rm(lock, { force: true });
  }
}

async function linuxMasterKey(d: PosixKeyDeps): Promise<Buffer> {
  await d.ensureDir(d.dir);
  const file = join(d.dir, PLAIN_KEY_FILE);
  const fromFile = await readPlainKey(file);
  if (fromFile) return fromFile;

  const tool = posixBinary('secret-tool', d.isExec);
  if (tool) {
    try {
      const found = await secretToolLookup(d, tool);
      if (found) return found;
      return await withLock(join(d.dir, '.master.key.lock'), async () => {
        const again = await secretToolLookup(d, tool);
        if (again) return again;
        const b64 = randomBytes(KEY_LEN).toString('base64');
        // The value goes over stdin only.
        const r = await d.run(tool, ['store', '--label=multiple-gmail', ...SECRET_ATTRS], b64);
        if (r.failure || r.code !== 0) throw new KeyringUnavailable(`secret-tool store failed: ${describeRun(r)}`);
        const stored = await secretToolLookup(d, tool);
        if (!stored) throw new KeyringUnavailable('the stored key could not be read back');
        return stored;
      });
    } catch (err) {
      if (!(err instanceof KeyringUnavailable)) throw err;
      throw new Error(
        `Could not use the Secret Service keyring through secret-tool: ${err.message}. ` +
          'Unlock or start your keyring, or set MULTIPLE_GMAIL_MASTER_KEY.',
      );
    }
  }

  if (!warnedPlainFile) {
    warnedPlainFile = true;
    d.warn(
      `multiple-gmail: no system keyring found (secret-tool from libsecret is not installed). The master key is kept in ${file}, ` +
        'protected only by file permissions.',
    );
  }
  const b64 = randomBytes(KEY_LEN).toString('base64');
  try {
    await writeFileAtomic(file, `${b64}\n`, { exclusive: true });
    return Buffer.from(b64, 'base64');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  const winner = await readPlainKey(file);
  if (!winner) throw new Error(`Master key file ${file} disappeared during creation.`);
  return winner;
}

export function resetPosixWarningForTests(): void {
  warnedPlainFile = false;
}
