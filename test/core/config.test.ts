import { mkdtemp, rm, mkdir, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, saveConfig, validateAlias } from '../../src/core/config.js';
import { configPath, dataDir, tokenPath } from '../../src/core/paths.js';
import { writeFileAtomic } from '../../src/core/fsx.js';

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'mg-test-'));
  process.env.MULTIPLE_GMAIL_HOME = home;
});
afterEach(async () => {
  delete process.env.MULTIPLE_GMAIL_HOME;
  await rm(home, { recursive: true, force: true });
});

describe('validateAlias', () => {
  it('lowercases and trims', () => {
    expect(validateAlias('Alpha')).toBe('alpha');
    expect(validateAlias('  Beta-1 ')).toBe('beta-1');
  });
  it('rejects bad aliases', () => {
    expect(() => validateAlias('all')).toThrow(Error);
    expect(() => validateAlias('şirket')).toThrow(Error);
    expect(() => validateAlias('')).toThrow(Error);
    expect(() => validateAlias('a'.repeat(33))).toThrow(Error);
    expect(() => validateAlias('../x')).toThrow(Error);
  });
  it('accepts 32 chars', () => {
    expect(validateAlias('a'.repeat(32))).toBe('a'.repeat(32));
  });
});

describe('paths', () => {
  it('honors MULTIPLE_GMAIL_HOME at call time', () => {
    expect(dataDir()).toBe(home);
    expect(tokenPath('alpha')).toBe(join(home, 'tokens', 'alpha.enc'));
    expect(configPath()).toBe(join(home, 'config.json'));
  });
});

describe('config', () => {
  it('returns defaults when missing', async () => {
    expect(await loadConfig()).toEqual({ port: 47110, language: 'en', defaultAccount: null, accounts: {} });
  });
  it('round-trips', async () => {
    const c = {
      port: 5000,
      language: 'tr' as const,
      defaultAccount: 'alpha',
      accounts: { alpha: { email: 'you@example.com', addedAt: '2026-01-01T00:00:00.000Z' } },
    };
    await saveConfig(c);
    expect(await loadConfig()).toEqual(c);
  });
  it('throws mentioning path on invalid JSON', async () => {
    await mkdir(home, { recursive: true });
    await writeFile(configPath(), '{nope');
    await expect(loadConfig()).rejects.toThrow(configPath());
  });
  it('throws mentioning path on schema mismatch', async () => {
    await writeFile(configPath(), JSON.stringify({ port: 'x' }));
    await expect(loadConfig()).rejects.toThrow(configPath());
  });
});

describe('writeFileAtomic', () => {
  it('writes and leaves no temp files', async () => {
    const f = join(home, 'a.txt');
    await writeFileAtomic(f, 'hi');
    await writeFileAtomic(f, 'there');
    expect(await readdir(home)).toEqual(['a.txt']);
  });
});
