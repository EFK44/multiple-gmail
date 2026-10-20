import { mkdtemp, rm, mkdir, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, saveConfig } from '../../src/core/config.js';
import { configPath, dataDir, tokenPath } from '../../src/core/paths.js';
import { writeFileAtomic } from '../../src/core/fsx.js';
import { restoreTestHome } from '../setup.js';

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'mg-test-'));
  process.env.MULTIPLE_GMAIL_HOME = home;
});
afterEach(async () => {
  restoreTestHome();
  await rm(home, { recursive: true, force: true });
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
      accounts: { alpha: { name: 'Alpha Mail', email: 'you@example.com', addedAt: '2026-01-01T00:00:00.000Z' } },
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

describe('dataDir guard', () => {
  it('throws under vitest when MULTIPLE_GMAIL_HOME is unset instead of using the real profile', () => {
    const saved = process.env.MULTIPLE_GMAIL_HOME;
    delete process.env.MULTIPLE_GMAIL_HOME;
    try {
      expect(() => dataDir()).toThrow('Tests must set MULTIPLE_GMAIL_HOME');
    } finally {
      process.env.MULTIPLE_GMAIL_HOME = saved ?? process.env.MULTIPLE_GMAIL_TEST_HOME;
    }
  });
});
