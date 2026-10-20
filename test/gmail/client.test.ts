import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { OAuth2Client } from 'google-auth-library';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { saveConfig } from '../../src/core/config.js';
import { resetMasterKeyCacheForTests } from '../../src/core/masterKey.js';
import { loadToken, saveClient, saveToken } from '../../src/core/secrets.js';
import { clearGmailCache, getGmail, setGmailFactoryForTests, type GmailApi } from '../../src/gmail/client.js';
import { getAccountStatus, setAccountStatus } from '../../src/gmail/errors.js';

let root: string;
let setKey = false;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mg-gmail-'));
  process.env.MULTIPLE_GMAIL_HOME = join(root, 'home');
  if (process.platform !== 'win32') {
    process.env.MULTIPLE_GMAIL_MASTER_KEY = randomBytes(32).toString('base64');
    setKey = true;
  }
  resetMasterKeyCacheForTests();
  clearGmailCache();
});
afterEach(async () => {
  setGmailFactoryForTests(null);
  clearGmailCache();
  resetMasterKeyCacheForTests();
  delete process.env.MULTIPLE_GMAIL_HOME;
  if (setKey) {
    delete process.env.MULTIPLE_GMAIL_MASTER_KEY;
    setKey = false;
  }
  await rm(root, { recursive: true, force: true });
});

async function seed(opts: { client?: boolean; token?: boolean; account?: boolean } = {}) {
  const { client = true, token = true, account = true } = opts;
  await saveConfig({
    port: 47110,
    language: 'en',
    defaultAccount: null,
    accounts: account ? { alpha: { email: 'you@example.com', addedAt: '2026-01-01T00:00:00.000Z' } } : {},
  });
  if (client) await saveClient({ clientId: 'cid', clientSecret: 'csecret', kind: 'installed', redirectUris: [] });
  if (token) await saveToken('alpha', { refreshToken: 'r1', accessToken: 'a1', expiryDate: 1, scope: 's' });
}

describe('getGmail', () => {
  it('rejects unknown accounts, missing client and missing token', async () => {
    await seed({ account: false, client: false, token: false });
    await expect(getGmail('alpha')).rejects.toThrow('Unknown account alpha');
    await seed({ client: false, token: false });
    await expect(getGmail('alpha')).rejects.toThrow(
      'No Google OAuth client configured. Open multiple-gmail to finish setup.',
    );
    await seed({ token: false });
    await expect(getGmail('alpha')).rejects.toThrow(/needs re-authorization.*Reconnect for alpha/);
    expect(getAccountStatus('alpha')).toBe('needs_reauth');
  });

  it('builds one client per alias, caches it, and clearGmailCache resets status', async () => {
    await seed();
    let built = 0;
    const api = { users: {} } as unknown as GmailApi;
    setGmailFactoryForTests(() => {
      built++;
      return api;
    });
    const a = await getGmail('alpha');
    const b = await getGmail('alpha');
    expect(a.api).toBe(api);
    expect(a.email).toBe('you@example.com');
    expect(b.api).toBe(api);
    expect(built).toBe(1);
    setAccountStatus('alpha', 'needs_reauth');
    clearGmailCache('alpha');
    expect(getAccountStatus('alpha')).toBe('ok');
    await getGmail('alpha');
    expect(built).toBe(2);
  });

  it('persists refreshed tokens, keeping the stored refresh token when none is sent', async () => {
    await seed();
    let auth!: OAuth2Client;
    setGmailFactoryForTests((o) => {
      auth = o;
      return { users: {} } as unknown as GmailApi;
    });
    await getGmail('alpha');
    expect(auth.credentials.refresh_token).toBe('r1');
    auth.emit('tokens', { access_token: 'a2', expiry_date: 99 });
    for (let i = 0; i < 50 && (await loadToken('alpha'))?.accessToken !== 'a2'; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(await loadToken('alpha')).toEqual({ refreshToken: 'r1', accessToken: 'a2', expiryDate: 99, scope: 's' });
  });
});
