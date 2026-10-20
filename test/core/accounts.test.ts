import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { removeAccount } from '../../src/core/accounts.js';
import { loadConfig, saveConfig } from '../../src/core/config.js';
import { resetMasterKeyCacheForTests } from '../../src/core/masterKey.js';
import { loadToken, saveToken } from '../../src/core/secrets.js';

let root: string;
let setMasterKey = false;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mg-accounts-'));
  process.env.MULTIPLE_GMAIL_HOME = join(root, 'home');
  if (process.platform !== 'win32') {
    process.env.MULTIPLE_GMAIL_MASTER_KEY = randomBytes(32).toString('base64');
    setMasterKey = true;
  }
  resetMasterKeyCacheForTests();
});
afterEach(async () => {
  resetMasterKeyCacheForTests();
  delete process.env.MULTIPLE_GMAIL_HOME;
  if (setMasterKey) {
    delete process.env.MULTIPLE_GMAIL_MASTER_KEY;
    setMasterKey = false;
  }
  await rm(root, { recursive: true, force: true });
});

async function seed(): Promise<void> {
  await saveConfig({
    port: 47110,
    language: 'en',
    defaultAccount: 'alpha',
    accounts: {
      alpha: { email: 'you@example.com', addedAt: '2026-01-01T00:00:00.000Z' },
      beta: { email: 'other@example.com', addedAt: '2026-01-02T00:00:00.000Z' },
    },
  });
  await saveToken('alpha', { refreshToken: 'refresh-alpha', accessToken: 'access-alpha', scope: 's' });
}

type Call = { url: string; init?: RequestInit };

function fakeFetch(status: number, calls: Call[]): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response('', { status });
  }) as typeof fetch;
}

describe('removeAccount', () => {
  it('revokes the refresh token, deletes the token and config entry, clears default', async () => {
    await seed();
    const calls: Call[] = [];
    const res = await removeAccount('alpha', { fetch: fakeFetch(200, calls) });
    expect(res).toEqual({ revoked: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://oauth2.googleapis.com/revoke');
    expect(calls[0].init?.method).toBe('POST');
    expect(String(calls[0].init?.body)).toBe('token=refresh-alpha');
    expect(await loadToken('alpha')).toBeNull();
    const cfg = await loadConfig();
    expect(cfg.accounts.alpha).toBeUndefined();
    expect(cfg.accounts.beta).toBeDefined();
    expect(cfg.defaultAccount).toBeNull();
  });

  it('still deletes locally when the revoke endpoint returns 500', async () => {
    await seed();
    const res = await removeAccount('alpha', { fetch: fakeFetch(500, []) });
    expect(res).toEqual({ revoked: false });
    expect(await loadToken('alpha')).toBeNull();
    expect((await loadConfig()).accounts.alpha).toBeUndefined();
  });

  it('still deletes locally when fetch throws', async () => {
    await seed();
    const failing = (async () => {
      throw new Error('network down');
    }) as typeof fetch;
    expect(await removeAccount('alpha', { fetch: failing })).toEqual({ revoked: false });
    expect(await loadToken('alpha')).toBeNull();
  });

  it('keeps defaultAccount when removing a different alias', async () => {
    await seed();
    await saveToken('beta', { refreshToken: 'refresh-beta', scope: 's' });
    await removeAccount('beta', { fetch: fakeFetch(200, []) });
    const cfg = await loadConfig();
    expect(cfg.defaultAccount).toBe('alpha');
    expect(cfg.accounts.beta).toBeUndefined();
  });

  it('removes a config entry without a token, reporting revoked false and not calling fetch', async () => {
    await seed();
    const calls: Call[] = [];
    expect(await removeAccount('beta', { fetch: fakeFetch(200, calls) })).toEqual({ revoked: false });
    expect(calls).toHaveLength(0);
    expect((await loadConfig()).accounts.beta).toBeUndefined();
  });

  it('rejects unknown and invalid aliases', async () => {
    await seed();
    await expect(removeAccount('gamma', { fetch: fakeFetch(200, []) })).rejects.toThrow(/No account named "gamma"/);
    await expect(removeAccount('../x', { fetch: fakeFetch(200, []) })).rejects.toThrow(/Invalid account alias/);
  });
});
