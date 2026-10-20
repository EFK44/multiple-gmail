import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { open, seal } from '../../src/core/crypto.js';
import { keyFromEnv } from '../../src/core/masterKey.js';
import { ensureSecureDir } from '../../src/core/secureDir.js';

const isWin = process.platform === 'win32';

let root: string;
let home: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mg-crypto-'));
  home = join(root, 'home');
  process.env.MULTIPLE_GMAIL_HOME = home;
});
afterEach(async () => {
  delete process.env.MULTIPLE_GMAIL_HOME;
  await rm(root, { recursive: true, force: true });
});

describe('seal/open', () => {
  const key = randomBytes(32);

  it('round-trips', () => {
    const pt = Buffer.from('refresh-token-for-you@example.com');
    const sealed = seal(key, pt);
    expect(sealed[0]).toBe(0x01);
    expect(sealed.length).toBe(1 + 12 + 16 + pt.length);
    expect(sealed.includes(pt)).toBe(false);
    expect(open(key, sealed).equals(pt)).toBe(true);
  });

  it('round-trips empty plaintext and uses a fresh IV each time', () => {
    const a = seal(key, Buffer.alloc(0));
    const b = seal(key, Buffer.alloc(0));
    expect(open(key, a).length).toBe(0);
    expect(a.equals(b)).toBe(false);
  });

  it('throws on any tampered byte', () => {
    const sealed = seal(key, Buffer.from('secret'));
    for (let i = 0; i < sealed.length; i++) {
      const t = Buffer.from(sealed);
      t[i] ^= 0x01;
      expect(() => open(key, t)).toThrow();
    }
  });

  it('throws on wrong key', () => {
    const sealed = seal(key, Buffer.from('secret'));
    expect(() => open(randomBytes(32), sealed)).toThrow();
  });

  it('throws on truncated input and bad key length', () => {
    expect(() => open(key, Buffer.alloc(10))).toThrow();
    expect(() => seal(randomBytes(16), Buffer.from('x'))).toThrow();
  });
});

describe('keyFromEnv', () => {
  const msg = 'Set MULTIPLE_GMAIL_MASTER_KEY (32 bytes base64). Generate with: multiple-gmail gen-key';
  it('accepts exactly 32 bytes base64', () => {
    const k = randomBytes(32);
    expect(keyFromEnv(k.toString('base64')).equals(k)).toBe(true);
  });
  it('rejects missing, wrong length, or non-base64 values', () => {
    expect(() => keyFromEnv(undefined)).toThrow(msg);
    expect(() => keyFromEnv('')).toThrow(msg);
    expect(() => keyFromEnv(randomBytes(31).toString('base64'))).toThrow(msg);
    expect(() => keyFromEnv(randomBytes(33).toString('base64'))).toThrow(msg);
    expect(() => keyFromEnv('!!!not base64!!!' + 'a'.repeat(30))).toThrow(msg);
  });
});

describe('ensureSecureDir', () => {
  it('creates the directory and is idempotent', async () => {
    const dir = join(root, 'a', 'b');
    await ensureSecureDir(dir);
    expect((await stat(dir)).isDirectory()).toBe(true);
    await ensureSecureDir(dir);
    expect((await stat(dir)).isDirectory()).toBe(true);
  });
});

describe.skipIf(!isWin)('getMasterKey (win32 DPAPI)', () => {
  async function freshModule() {
    vi.resetModules();
    return import('../../src/core/masterKey.js');
  }

  it('persists via DPAPI and reads back equal key in a fresh module load', async () => {
    const m1 = await freshModule();
    const k1 = await m1.getMasterKey();
    expect(k1.length).toBe(32);

    const onDisk = await readFile(join(home, 'master.key.dpapi'));
    expect(onDisk.equals(k1)).toBe(false);
    expect(onDisk.includes(k1)).toBe(false);
    expect(onDisk.includes(Buffer.from(k1.toString('base64')))).toBe(false);

    const m2 = await freshModule();
    const k2 = await m2.getMasterKey();
    expect(k2.equals(k1)).toBe(true);
    expect(k2).not.toBe(k1);
  }, 60_000);

  it('caches in memory and the test hook clears the cache', async () => {
    const m = await freshModule();
    const a = await m.getMasterKey();
    expect(await m.getMasterKey()).toBe(a);
    m.resetMasterKeyCacheForTests();
    const b = await m.getMasterKey();
    expect(b).not.toBe(a);
    expect(b.equals(a)).toBe(true);
  }, 60_000);

  it('concurrent first creation from two module instances yields one key', async () => {
    const m1 = await freshModule();
    const m2 = await freshModule();
    const [a, b] = await Promise.all([m1.getMasterKey(), m2.getMasterKey()]);
    expect(a.equals(b)).toBe(true);
  }, 60_000);

  it('refuses a corrupt key file instead of regenerating', async () => {
    const m = await freshModule();
    await ensureSecureDir(home);
    const file = join(home, 'master.key.dpapi');
    await writeFile(file, Buffer.from('garbage'));
    await expect(m.getMasterKey()).rejects.toThrow(/master\.key\.dpapi/);
    expect((await readFile(file)).toString()).toBe('garbage');
  }, 60_000);
});
