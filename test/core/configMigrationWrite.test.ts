import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { restoreTestHome } from '../setup.js';

// Every write fails: the migration save must not make loading the config fail.
vi.mock('../../src/core/fsx.js', async (orig) => ({
  ...(await orig<typeof import('../../src/core/fsx.js')>()),
  writeFileAtomic: vi.fn(async () => {
    throw new Error('disk full');
  }),
}));

const { loadConfig } = await import('../../src/core/config.js');
const { configPath } = await import('../../src/core/paths.js');

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'mg-migwrite-'));
  process.env.MULTIPLE_GMAIL_HOME = home;
});
afterEach(async () => {
  restoreTestHome();
  await rm(home, { recursive: true, force: true });
});

describe('best-effort migration save', () => {
  it('returns the migrated config and logs when the save fails', async () => {
    const old = {
      port: 47110,
      language: 'en',
      defaultAccount: 'alpha',
      accounts: { alpha: { email: 'you@example.com', addedAt: '2026-10-01T10:00:00.000Z' } },
    };
    await mkdir(home, { recursive: true });
    await writeFile(configPath(), JSON.stringify(old));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const c = await loadConfig();
      expect(c.accounts.alpha).toEqual({ name: 'alpha', email: 'you@example.com', addedAt: '2026-10-01T10:00:00.000Z' });
      expect(spy).toHaveBeenCalled();
      expect(String(spy.mock.calls[0][0])).toContain('disk full');
      // The old file is untouched.
      expect(JSON.parse(await readFile(configPath(), 'utf8'))).toEqual(old);
    } finally {
      spy.mockRestore();
    }
  });
});
