import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetMasterKeyCacheForTests } from '../../src/core/masterKey.js';
import {
  deleteToken,
  getLocalApiKey,
  loadClient,
  loadToken,
  parseClientJson,
  rotateLocalApiKey,
  saveClient,
  saveToken,
} from '../../src/core/secrets.js';

let root: string;
let setMasterKey = false;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mg-secrets-'));
  process.env.MULTIPLE_GMAIL_HOME = join(root, 'home');
  if (process.platform !== 'win32') {
    process.env.MULTIPLE_GMAIL_MASTER_KEY = randomBytes(32).toString('base64');
    setMasterKey = true;
  }
  resetMasterKeyCacheForTests();
});
afterEach(async () => {
  resetMasterKeyCacheForTests();
  process.env.MULTIPLE_GMAIL_HOME = process.env.MULTIPLE_GMAIL_TEST_HOME;
  if (setMasterKey) {
    delete process.env.MULTIPLE_GMAIL_MASTER_KEY;
    setMasterKey = false;
  }
  await rm(root, { recursive: true, force: true });
});

const installed = JSON.stringify({
  installed: { client_id: 'id-1', client_secret: 'sec-1', redirect_uris: ['http://localhost'] },
});
const web = JSON.stringify({ web: { client_id: 'id-2', client_secret: 'sec-2' } });

describe('parseClientJson', () => {
  it('parses installed and web clients', () => {
    expect(parseClientJson(installed)).toEqual({
      clientId: 'id-1',
      clientSecret: 'sec-1',
      kind: 'installed',
      redirectUris: ['http://localhost'],
    });
    expect(parseClientJson(web)).toEqual({ clientId: 'id-2', clientSecret: 'sec-2', kind: 'web', redirectUris: [] });
  });

  it('rejects bad input with descriptive messages', () => {
    expect(() => parseClientJson('{"type":"service_account"}')).toThrow(/service account/i);
    expect(() => parseClientJson('nope')).toThrow(/not valid JSON/i);
    expect(() => parseClientJson('{"other":{}}')).toThrow(/neither "installed" nor "web"/);
    expect(() => parseClientJson('{"installed":{"client_secret":"x"}}')).toThrow(/client_id/);
    expect(() => parseClientJson('{"installed":{"client_id":"x","client_secret":""}}')).toThrow(/client_secret/);
  });
});

describe('secret store', () => {
  it('round-trips the client and returns null when absent', async () => {
    expect(await loadClient()).toBeNull();
    const c = parseClientJson(installed);
    await saveClient(c);
    expect(await loadClient()).toEqual(c);
    const raw = await readFile(join(process.env.MULTIPLE_GMAIL_HOME!, 'client.enc'));
    expect(raw.includes('sec-1')).toBe(false);
  });

  it('round-trips tokens, encrypted on disk, and deletes', async () => {
    const t = { refreshToken: 'refresh-secret-xyz', accessToken: 'a', expiryDate: 123, scope: 's' };
    expect(await loadToken('alpha')).toBeNull();
    await saveToken('alpha', t);
    expect(await loadToken('alpha')).toEqual(t);
    const raw = await readFile(join(process.env.MULTIPLE_GMAIL_HOME!, 'tokens', 'alpha.enc'));
    expect(raw.includes('refresh-secret-xyz')).toBe(false);
    await deleteToken('alpha');
    expect(await loadToken('alpha')).toBeNull();
    await expect(deleteToken('alpha')).resolves.toBeUndefined();
  });

  it('rejects path traversal aliases', async () => {
    const t = { refreshToken: 'r', scope: 's' };
    await expect(saveToken('../evil', t)).rejects.toThrow(/Invalid account alias/);
    await expect(loadToken('..\\evil')).rejects.toThrow(/Invalid account alias/);
    await expect(deleteToken('a/b')).rejects.toThrow(/Invalid account alias/);
  });

  it('local api key is stable and rotates', async () => {
    const k1 = await getLocalApiKey();
    expect(k1).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await getLocalApiKey()).toBe(k1);
    const k2 = await rotateLocalApiKey();
    expect(k2).not.toBe(k1);
    expect(await getLocalApiKey()).toBe(k2);
  });

  it('local api key first creation is race-safe', async () => {
    const keys = await Promise.all(Array.from({ length: 5 }, () => getLocalApiKey()));
    expect(new Set(keys).size).toBe(1);
    expect(await getLocalApiKey()).toBe(keys[0]);
  });
});
