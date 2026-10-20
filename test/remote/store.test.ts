import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetMasterKeyCacheForTests, useMasterKey } from '../../src/core/masterKey.js';
import { MAX_CLIENTS, RemoteStore } from '../../src/remote/store.js';

let dir: string;
let prevHome: string | undefined;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mg-store-'));
  prevHome = process.env.MULTIPLE_GMAIL_HOME;
  process.env.MULTIPLE_GMAIL_HOME = join(dir, 'home');
  useMasterKey(randomBytes(32));
});
afterEach(async () => {
  resetMasterKeyCacheForTests();
  if (prevHome === undefined) delete process.env.MULTIPLE_GMAIL_HOME;
  else process.env.MULTIPLE_GMAIL_HOME = prevHome;
  await rm(dir, { recursive: true, force: true });
});

const RES = 'https://mail.example.com/mcp';

describe('remote store', () => {
  it('caps clients at 50: clients without live tokens are evicted, otherwise registration is refused', async () => {
    const store = await RemoteStore.open();
    expect(MAX_CLIENTS).toBe(50);
    const ids: string[] = [];
    for (let i = 0; i < MAX_CLIENTS; i++) {
      const c = await store.registerClient({ redirectUris: ['https://c.example/cb'] });
      expect(c).not.toBeNull();
      ids.push(c!.clientId);
    }
    // The oldest has no tokens, so a new registration evicts it.
    const extra = await store.registerClient({ redirectUris: ['https://c.example/cb'] });
    expect(extra).not.toBeNull();
    expect(store.getClient(ids[0])).toBeUndefined();

    // Give every remaining client a live token family: now the store is full.
    for (const id of [...ids.slice(1), extra!.clientId]) await store.issueTokens({ clientId: id, resource: RES, scope: 'mcp' });
    expect(await store.registerClient({ redirectUris: ['https://c.example/cb'] })).toBeNull();
  });

  it('access tokens expire after one hour', async () => {
    let now = 1_000_000;
    const store = await RemoteStore.open(() => now);
    const c = await store.registerClient({ redirectUris: ['https://c.example/cb'] });
    const t = await store.issueTokens({ clientId: c!.clientId, resource: RES, scope: 'mcp' });
    expect(t.expiresIn).toBe(3600);
    expect(store.verifyAccess(t.accessToken)?.clientId).toBe(c!.clientId);
    now += 3600 * 1000 + 1;
    expect(store.verifyAccess(t.accessToken)).toBeNull();
  });

  it('refresh tokens expire after 30 days', async () => {
    let now = 1_000_000;
    const store = await RemoteStore.open(() => now);
    const c = await store.registerClient({ redirectUris: ['https://c.example/cb'] });
    const t = await store.issueTokens({ clientId: c!.clientId, resource: RES, scope: 'mcp' });
    now += 30 * 24 * 3600 * 1000 + 1;
    expect((await store.rotateRefresh(t.refreshToken, c!.clientId)).kind).toBe('invalid');
  });

  it('over the token cap, rotated refresh tokens are evicted before live ones', async () => {
    const store = await RemoteStore.open(Date.now, { maxTokens: 6 });
    const idle = await store.registerClient({ redirectUris: ['https://c.example/cb'] });
    const busy = await store.registerClient({ redirectUris: ['https://c.example/cb'] });
    // The idle client's refresh token is the oldest record of all.
    const idleTokens = await store.issueTokens({ clientId: idle!.clientId, resource: RES, scope: 'mcp' });
    let current = (await store.issueTokens({ clientId: busy!.clientId, resource: RES, scope: 'mcp' })).refreshToken;
    const rotated: string[] = [];
    for (let i = 0; i < 8; i++) {
      const r = await store.rotateRefresh(current, busy!.clientId);
      if (r.kind !== 'ok') throw new Error('rotation failed');
      rotated.push(current);
      current = r.tokens.refreshToken;
    }
    // 1 idle + 1 live + 8 used > 6: only used records were dropped.
    expect(store.verifyAccess(idleTokens.accessToken)).not.toBeNull();
    // A recent used record is still recognized as a replay, which revokes the busy family.
    expect((await store.rotateRefresh(rotated[rotated.length - 1], busy!.clientId)).kind).toBe('reused');
    expect((await store.rotateRefresh(current, busy!.clientId)).kind).toBe('invalid');
    // The idle client's live refresh token survived the evictions.
    expect((await store.rotateRefresh(idleTokens.refreshToken, idle!.clientId)).kind).toBe('ok');
  });

  it('rotated refresh tokens are kept for 7 days for replay detection', async () => {
    let now = 1_000_000;
    const store = await RemoteStore.open(() => now);
    const c = await store.registerClient({ redirectUris: ['https://c.example/cb'] });
    const t = await store.issueTokens({ clientId: c!.clientId, resource: RES, scope: 'mcp' });
    const r = await store.rotateRefresh(t.refreshToken, c!.clientId);
    expect(r.kind).toBe('ok');
    now += 6 * 24 * 3600 * 1000;
    expect((await store.rotateRefresh(t.refreshToken, c!.clientId)).kind).toBe('reused');

    const t2 = await store.issueTokens({ clientId: c!.clientId, resource: RES, scope: 'mcp' });
    expect((await store.rotateRefresh(t2.refreshToken, c!.clientId)).kind).toBe('ok');
    now += 7 * 24 * 3600 * 1000 + 1;
    // Forgotten after 7 days: just invalid now.
    expect((await store.rotateRefresh(t2.refreshToken, c!.clientId)).kind).toBe('invalid');
  });

  it('a refresh token presented by another client is refused', async () => {
    const store = await RemoteStore.open();
    const a = await store.registerClient({ redirectUris: ['https://c.example/cb'] });
    const b = await store.registerClient({ redirectUris: ['https://c.example/cb'] });
    const t = await store.issueTokens({ clientId: a!.clientId, resource: RES, scope: 'mcp' });
    expect((await store.rotateRefresh(t.refreshToken, b!.clientId)).kind).toBe('invalid');
  });
});
