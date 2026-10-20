import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  findAccount,
  loadConfig,
  newAccountId,
  normalizeName,
  sameName,
  validateId,
  validateName,
  type AppConfig,
} from '../../src/core/config.js';
import { configPath } from '../../src/core/paths.js';
import { restoreTestHome } from '../setup.js';

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'mg-names-'));
  process.env.MULTIPLE_GMAIL_HOME = home;
});
afterEach(async () => {
  restoreTestHome();
  await rm(home, { recursive: true, force: true });
});

const cfg = (accounts: AppConfig['accounts']): AppConfig => ({ port: 47110, language: 'en', defaultAccount: null, accounts });

describe('normalizeName / validateName', () => {
  it('trims, NFC-normalizes and collapses whitespace', () => {
    expect(normalizeName('  İş   Hesabı \t ')).toBe('İş Hesabı');
    expect(normalizeName('Ki̇şi')).toBe('Ki̇şi'.normalize('NFC'));
    expect(normalizeName('ş')).toBe('ş');
  });
  it('accepts free-form names with Turkish letters, digits, spaces and punctuation', () => {
    for (const n of ['Kişisel', 'İş Hesabı', 'Shop', 'çğıİöşü', 'Work (2026) - main.', "Ali's mail", 'a']) {
      expect(validateName(n, cfg({}))).toBe(normalizeName(n));
    }
  });
  it('limits to 40 code points', () => {
    expect(validateName('ş'.repeat(40), cfg({}))).toBe('ş'.repeat(40));
    expect(() => validateName('ş'.repeat(41), cfg({}))).toThrow(/40/);
  });
  it('rejects empty, control characters and the reserved name', () => {
    expect(() => validateName('   ', cfg({}))).toThrow();
    expect(() => validateName('a\u0000b', cfg({}))).toThrow();
    expect(() => validateName('a\u0007b', cfg({}))).toThrow();
    expect(() => validateName('a‎b', cfg({}))).toThrow();
    expect(() => validateName('All', cfg({}))).toThrow(/reserved/);
    expect(() => validateName(' ALL ', cfg({}))).toThrow(/reserved/);
  });
  it('treats newlines inside as whitespace to collapse', () => {
    expect(validateName('a\nb', cfg({}))).toBe('a b');
  });
  it('rejects case-insensitive duplicates in both tr-TR and plain lowercasing', () => {
    const c = cfg({
      a1: { name: 'İş Hesabı', email: 'you@example.com', addedAt: 'x' },
      b2: { name: 'Info', email: 'other@example.com', addedAt: 'x' },
    });
    expect(() => validateName('iş hesabı', c)).toThrow(/already/);
    expect(() => validateName('İŞ HESABI', c)).toThrow(/already/);
    expect(() => validateName('INFO', c)).toThrow(/already/);
    expect(() => validateName('info', c)).toThrow(/already/);
    // Renaming an account to itself (other case) is fine.
    expect(validateName('info', c, 'b2')).toBe('info');
  });
  it('sameName compares both ways', () => {
    expect(sameName('Info', 'INFO')).toBe(true);
    expect(sameName('İnfo', 'info')).toBe(true);
    expect(sameName('Info', 'Inf')).toBe(false);
  });
});

describe('ids', () => {
  it('newAccountId is 12 lowercase base32 chars and filename safe', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const id = newAccountId();
      expect(id).toMatch(/^[a-z2-7]{12}$/);
      expect(validateId(id)).toBe(id);
      seen.add(id);
    }
    expect(seen.size).toBe(50);
  });
  it('validateId accepts legacy aliases and rejects path tricks', () => {
    expect(validateId('alpha')).toBe('alpha');
    expect(() => validateId('../x')).toThrow();
    expect(() => validateId('Alpha')).toThrow();
    expect(() => validateId('all')).toThrow();
    expect(() => validateId('')).toThrow();
  });
});

describe('findAccount', () => {
  const c = cfg({
    'alpha': { name: 'Work Mail', email: 'you@example.com', addedAt: 'x' },
    k2k2k2k2k2k2: { name: 'Kişisel', email: 'Other@Example.com', addedAt: 'x' },
  });
  it('matches by name (case-insensitive), email (case-insensitive) or id', () => {
    expect(findAccount(c, 'work mail')).toBe('alpha');
    expect(findAccount(c, '  WORK   MAIL ')).toBe('alpha');
    expect(findAccount(c, 'KİŞİSEL')).toBe('k2k2k2k2k2k2');
    expect(findAccount(c, 'kişisel')).toBe('k2k2k2k2k2k2');
    expect(findAccount(c, 'other@example.COM')).toBe('k2k2k2k2k2k2');
    expect(findAccount(c, 'k2k2k2k2k2k2')).toBe('k2k2k2k2k2k2');
    expect(findAccount(c, 'alpha')).toBe('alpha');
    expect(findAccount(c, 'nobody')).toBeUndefined();
  });
  it('prefers a name match over another account id', () => {
    const d = cfg({
      beta: { name: 'Work', email: 'you@example.com', addedAt: 'x' },
      abcdefabcdef: { name: 'beta', email: 'other@example.com', addedAt: 'x' },
    });
    expect(findAccount(d, 'beta')).toBe('abcdefabcdef');
  });
});

describe('config migration', () => {
  it('migrates the old alias-keyed shape losslessly and saves it', async () => {
    const old = {
      port: 47110,
      language: 'tr',
      defaultAccount: 'alpha',
      accounts: {
        'alpha': { email: 'you@example.com', addedAt: '2026-10-01T10:00:00.000Z' },
        beta: { email: 'other@example.com', addedAt: '2026-10-02T10:00:00.000Z' },
      },
    };
    await mkdir(home, { recursive: true });
    await writeFile(configPath(), JSON.stringify(old, null, 2));
    const c = await loadConfig();
    expect(c).toEqual({
      port: 47110,
      language: 'tr',
      defaultAccount: 'alpha',
      accounts: {
        'alpha': { name: 'alpha', email: 'you@example.com', addedAt: '2026-10-01T10:00:00.000Z' },
        beta: { name: 'beta', email: 'other@example.com', addedAt: '2026-10-02T10:00:00.000Z' },
      },
    });
    const onDisk = JSON.parse(await readFile(configPath(), 'utf8'));
    expect(onDisk).toEqual(c);
    // Idempotent: loading again gives the same result.
    expect(await loadConfig()).toEqual(c);
  });
});

describe('names that collide with emails or ids', () => {
  const c = cfg({
    alpha: { name: 'alpha', email: 'you@example.com', addedAt: 'x' },
    k2k2k2k2k2k2: { name: 'Kişisel', email: 'other@example.com', addedAt: 'x' },
  });
  it('rejects a name equal to any account email (any case), including the renamed account', () => {
    expect(() => validateName('YOU@example.com', c)).toThrow(/email/);
    expect(() => validateName('other@example.com', c, 'k2k2k2k2k2k2')).toThrow(/email/);
    expect(() => validateName('you@example.com', c, 'k2k2k2k2k2k2')).toThrow(/email/);
    expect(validateName('new@example.com', c)).toBe('new@example.com');
  });
  it("rejects a name equal to another account's id (legacy alias), but allows the account's own id", () => {
    expect(() => validateName('ALPHA', c, 'k2k2k2k2k2k2')).toThrow(/already/);
    expect(() => validateName('k2k2k2k2k2k2', c, 'alpha')).toThrow(/already/);
    expect(() => validateName('K2K2K2K2K2K2', c)).toThrow(/already/);
    expect(validateName('Alpha', c, 'alpha')).toBe('Alpha');
  });
  it('a reference with @ resolves by email first', () => {
    const d = cfg({
      a1a1a1a1a1a1: { name: 'x@example.com', email: 'you@example.com', addedAt: 'x' },
      b2b2b2b2b2b2: { name: 'Work', email: 'x@example.com', addedAt: 'x' },
    });
    expect(findAccount(d, 'X@example.com')).toBe('b2b2b2b2b2b2');
    expect(findAccount(d, 'work')).toBe('b2b2b2b2b2b2');
  });
});

describe('migration keeps existing tokens', () => {
  it('a sealed tokens/<alias>.enc written before migration still loads by the migrated id', async () => {
    const { saveToken, loadToken } = await import('../../src/core/secrets.js');
    const { resetMasterKeyCacheForTests } = await import('../../src/core/masterKey.js');
    const setKey = process.platform !== 'win32' && !process.env.MULTIPLE_GMAIL_MASTER_KEY;
    if (setKey) process.env.MULTIPLE_GMAIL_MASTER_KEY = Buffer.alloc(32, 7).toString('base64');
    resetMasterKeyCacheForTests();
    try {
      await saveToken('alpha', { refreshToken: 'r-alpha', scope: 's' });
      await writeFile(
        configPath(),
        JSON.stringify({
          port: 47110,
          language: 'en',
          defaultAccount: 'alpha',
          accounts: { alpha: { email: 'you@example.com', addedAt: '2026-10-01T10:00:00.000Z' } },
        }),
      );
      const c = await loadConfig();
      const id = findAccount(c, 'alpha');
      expect(id).toBe('alpha');
      expect(await loadToken(id!)).toEqual({ refreshToken: 'r-alpha', scope: 's' });
    } finally {
      resetMasterKeyCacheForTests();
      if (setKey) delete process.env.MULTIPLE_GMAIL_MASTER_KEY;
    }
  }, 60_000);
});
