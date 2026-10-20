import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, saveConfig } from '../../src/core/config.js';
import {
  GMAIL_SCOPE,
  beginAuth,
  classifyOAuthError,
  formatDuration,
  startLoopbackAuth,
  type LoopbackDeps,
  type TokenSet,
} from '../../src/core/googleAuth.js';
import { resetMasterKeyCacheForTests } from '../../src/core/masterKey.js';
import { loadToken, type OAuthClient } from '../../src/core/secrets.js';
import { restoreTestHome } from '../setup.js';

let root: string;
let setMasterKey = false;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mg-oauth-'));
  process.env.MULTIPLE_GMAIL_HOME = join(root, 'home');
  if (process.platform !== 'win32') {
    process.env.MULTIPLE_GMAIL_MASTER_KEY = randomBytes(32).toString('base64');
    setMasterKey = true;
  }
  resetMasterKeyCacheForTests();
});
afterEach(async () => {
  resetMasterKeyCacheForTests();
  restoreTestHome();
  if (setMasterKey) {
    delete process.env.MULTIPLE_GMAIL_MASTER_KEY;
    setMasterKey = false;
  }
  await rm(root, { recursive: true, force: true });
});

const client: OAuthClient = {
  clientId: 'client-id-1.apps.googleusercontent.com',
  clientSecret: 'client-secret-1',
  kind: 'installed',
  redirectUris: ['http://localhost'],
};

describe('beginAuth', () => {
  it('builds a PKCE S256 consent URL with only the Gmail scope', () => {
    const r = beginAuth({ id: 'alpha', client, redirectUri: 'http://127.0.0.1:5555/callback', loginHint: 'you@example.com' });
    const u = new URL(r.url);
    expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    const p = u.searchParams;
    expect(p.get('scope')).toBe(GMAIL_SCOPE);
    expect(GMAIL_SCOPE).toBe('https://www.googleapis.com/auth/gmail.modify');
    expect(p.get('code_challenge_method')).toBe('S256');
    expect(p.get('access_type')).toBe('offline');
    expect(p.get('prompt')).toBe('consent');
    expect(p.get('response_type')).toBe('code');
    expect(p.get('client_id')).toBe(client.clientId);
    expect(p.get('redirect_uri')).toBe('http://127.0.0.1:5555/callback');
    expect(p.get('login_hint')).toBe('you@example.com');
    expect(r.state.length).toBeGreaterThanOrEqual(32);
    expect(p.get('state')).toBe(r.state);
    const challenge = createHash('sha256').update(r.codeVerifier).digest('base64url');
    expect(p.get('code_challenge')).toBe(challenge);
    expect(r.codeVerifier).toMatch(/^[A-Za-z0-9._~-]{43,128}$/);
    expect(r.url).not.toContain(client.clientSecret);
  });

  it('uses a fresh state and verifier each time', () => {
    const a = beginAuth({ id: 'alpha', client, redirectUri: 'http://127.0.0.1:1/callback' });
    const b = beginAuth({ id: 'alpha', client, redirectUri: 'http://127.0.0.1:1/callback' });
    expect(a.state).not.toBe(b.state);
    expect(a.codeVerifier).not.toBe(b.codeVerifier);
    expect(new URL(a.url).searchParams.has('login_hint')).toBe(false);
  });
});

describe('classifyOAuthError', () => {
  it('maps Google error codes', () => {
    expect(classifyOAuthError('admin_policy_enforced')).toBe('admin_blocked');
    expect(classifyOAuthError('access_denied')).toBe('user_denied');
    expect(classifyOAuthError('something_else')).toBe('unknown');
    expect(classifyOAuthError(null)).toBe('unknown');
  });
});

type Recorded = { exchanges: { code: string; codeVerifier: string; redirectUri: string }[]; profiles: string[] };

function deps(over: Partial<{ email: string; tokens: TokenSet; timeoutMs: number }> = {}): {
  deps: LoopbackDeps;
  rec: Recorded;
} {
  const rec: Recorded = { exchanges: [], profiles: [] };
  const tokens: TokenSet = over.tokens ?? {
    refreshToken: 'refresh-1',
    accessToken: 'access-1',
    expiryDate: 1234,
    scope: `${GMAIL_SCOPE} openid`,
  };
  return {
    rec,
    deps: {
      loadClient: async () => client,
      exchangeCode: async ({ code, codeVerifier, redirectUri }) => {
        rec.exchanges.push({ code, codeVerifier, redirectUri });
        return tokens;
      },
      getProfileEmail: async (accessToken) => {
        rec.profiles.push(accessToken);
        return over.email ?? 'you@example.com';
      },
      timeoutMs: over.timeoutMs ?? 10_000,
    },
  };
}

function callbackUrl(authUrl: string, params: Record<string, string>): string {
  const redirect = new URL(new URL(authUrl).searchParams.get('redirect_uri')!);
  for (const [k, v] of Object.entries(params)) redirect.searchParams.set(k, v);
  return redirect.toString();
}

const stateOf = (authUrl: string) => new URL(authUrl).searchParams.get('state')!;

async function seedConfig(accounts: Record<string, { email: string; addedAt: string }>): Promise<void> {
  await saveConfig({ port: 47110, language: 'en', defaultAccount: null, accounts });
}

describe('startLoopbackAuth', () => {
  it('binds a 127.0.0.1 loopback redirect on /callback', async () => {
    const { deps: d } = deps({ timeoutMs: 200 });
    const { url, done } = await startLoopbackAuth('alpha', { id: 'alpha', deps: d });
    done.catch(() => {});
    const redirect = new URL(new URL(url).searchParams.get('redirect_uri')!);
    expect(redirect.hostname).toBe('127.0.0.1');
    expect(redirect.pathname).toBe('/callback');
    expect(Number(redirect.port)).toBeGreaterThan(0);
    const other = await fetch(`http://127.0.0.1:${redirect.port}/other`);
    expect(other.status).toBe(404);
    await expect(done).rejects.toThrow(/timed out/i);
  });

  it('rejects a callback with a wrong state and does not exchange the code', async () => {
    const { deps: d, rec } = deps({ timeoutMs: 300 });
    const { url, done } = await startLoopbackAuth('alpha', { id: 'alpha', deps: d });
    done.catch(() => {});
    const res = await fetch(callbackUrl(url, { state: 'x'.repeat(43), code: 'code-1' }));
    expect(res.status).toBe(400);
    const missing = await fetch(callbackUrl(url, { code: 'code-1' }));
    expect(missing.status).toBe(400);
    expect(rec.exchanges).toHaveLength(0);
    await expect(done).rejects.toThrow(/timed out/i);
    expect(await loadToken('alpha')).toBeNull();
  });

  it('connects an account: exchanges with PKCE, saves token and config, closes the server', async () => {
    const { deps: d, rec } = deps();
    const { url, done } = await startLoopbackAuth('alpha', { id: 'alpha', deps: d, lang: 'tr' });
    const cb = callbackUrl(url, { state: stateOf(url), code: 'code-1' });
    const res = await fetch(cb);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    const body = await res.text();
    expect(body).toContain('lang="tr"');
    expect(body).not.toContain('code-1');
    expect(await done).toEqual({ id: 'alpha', name: 'alpha', email: 'you@example.com' });
    expect(rec.exchanges).toHaveLength(1);
    expect(rec.exchanges[0].code).toBe('code-1');
    expect(rec.exchanges[0].redirectUri).toBe(new URL(url).searchParams.get('redirect_uri'));
    expect(createHash('sha256').update(rec.exchanges[0].codeVerifier).digest('base64url')).toBe(
      new URL(url).searchParams.get('code_challenge'),
    );
    expect(rec.profiles).toEqual(['access-1']);
    expect(await loadToken('alpha')).toEqual({
      refreshToken: 'refresh-1',
      accessToken: 'access-1',
      expiryDate: 1234,
      scope: `${GMAIL_SCOPE} openid`,
    });
    const cfg = await loadConfig();
    expect(cfg.accounts.alpha.email).toBe('you@example.com');
    expect(Number.isNaN(Date.parse(cfg.accounts.alpha.addedAt))).toBe(false);
    await expect(fetch(cb)).rejects.toThrow();
  });

  it('a free-form name gets a random id; the token is stored under the id', async () => {
    await seedConfig({ beta: { email: 'other@example.com', addedAt: '2026-01-01T00:00:00.000Z' } });
    const { url, id, done } = await startLoopbackAuth('  İş   Hesabı ', { deps: deps().deps });
    expect(id).toMatch(/^[a-z2-7]{12}$/);
    await fetch(callbackUrl(url, { state: stateOf(url), code: 'code-1' }));
    expect(await done).toEqual({ id, name: 'İş Hesabı', email: 'you@example.com' });
    expect((await loadToken(id))?.refreshToken).toBe('refresh-1');
    const cfg = await loadConfig();
    expect(cfg.accounts[id]).toMatchObject({ name: 'İş Hesabı', email: 'you@example.com' });
    expect(cfg.accounts.beta.name).toBe('beta');
    // Same name in another case is taken; reconnect by name finds it.
    await expect(startLoopbackAuth('iş hesabı', { deps: deps().deps })).rejects.toThrow(/already exists/);
    const re = await startLoopbackAuth('İŞ HESABI', { reconnect: true, deps: deps({ timeoutMs: 100 }).deps });
    expect(re.id).toBe(id);
    await expect(re.done).rejects.toThrow(/timed out/);
  });

  it('rejects a duplicate email under another alias', async () => {
    await seedConfig({ beta: { email: 'You@Example.com', addedAt: '2026-01-01T00:00:00.000Z' } });
    const { deps: d } = deps();
    const { url, done } = await startLoopbackAuth('alpha', { id: 'alpha', deps: d });
    done.catch(() => {});
    await fetch(callbackUrl(url, { state: stateOf(url), code: 'code-1' }));
    await expect(done).rejects.toThrow(/already connected as "beta"/);
    expect(await loadToken('alpha')).toBeNull();
    expect((await loadConfig()).accounts.alpha).toBeUndefined();
  });

  it('rejects an existing alias without reconnect, and an unknown alias with reconnect', async () => {
    await seedConfig({ alpha: { email: 'you@example.com', addedAt: '2026-01-01T00:00:00.000Z' } });
    await expect(startLoopbackAuth('alpha', { id: 'alpha', deps: deps().deps })).rejects.toThrow(/An account named "alpha" already exists/);
    await expect(startLoopbackAuth('beta', { reconnect: true, deps: deps().deps })).rejects.toThrow(/No account "beta" to reconnect/);
    await expect(startLoopbackAuth('all', { deps: deps().deps })).rejects.toThrow(/reserved/);
  });

  it('reconnect keeps addedAt and requires the same email', async () => {
    await seedConfig({ alpha: { email: 'you@example.com', addedAt: '2026-01-01T00:00:00.000Z' } });
    const ok = await startLoopbackAuth('alpha', { reconnect: true, deps: deps().deps });
    await fetch(callbackUrl(ok.url, { state: stateOf(ok.url), code: 'code-1' }));
    expect(await ok.done).toEqual({ id: 'alpha', name: 'alpha', email: 'you@example.com' });
    expect((await loadConfig()).accounts.alpha.addedAt).toBe('2026-01-01T00:00:00.000Z');

    const bad = await startLoopbackAuth('alpha', { reconnect: true, deps: deps({ email: 'other@example.com' }).deps });
    bad.done.catch(() => {});
    await fetch(callbackUrl(bad.url, { state: stateOf(bad.url), code: 'code-2' }));
    await expect(bad.done).rejects.toThrow('Signed in as other@example.com but the account "alpha" belongs to you@example.com');
    expect((await loadToken('alpha'))?.refreshToken).toBe('refresh-1');
  });

  it('rejects done with code admin_blocked when Google returns admin_policy_enforced', async () => {
    const { deps: d, rec } = deps();
    const { url, done } = await startLoopbackAuth('alpha', { id: 'alpha', deps: d });
    done.catch(() => {});
    const res = await fetch(callbackUrl(url, { state: stateOf(url), error: 'admin_policy_enforced' }));
    expect(res.status).toBe(200);
    const err = (await done.catch((e: unknown) => e)) as Error & { code?: string };
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('admin_blocked');
    expect(rec.exchanges).toHaveLength(0);
  });

  it('rejects done with code user_denied on access_denied', async () => {
    const { deps: d } = deps();
    const { url, done } = await startLoopbackAuth('alpha', { id: 'alpha', deps: d });
    done.catch(() => {});
    await fetch(callbackUrl(url, { state: stateOf(url), error: 'access_denied' }));
    const err = (await done.catch((e: unknown) => e)) as Error & { code?: string };
    expect(err.code).toBe('user_denied');
  });

  it('fails clearly when Google returns no refresh token', async () => {
    const { deps: d } = deps({ tokens: { accessToken: 'a', scope: GMAIL_SCOPE } });
    const { url, done } = await startLoopbackAuth('alpha', { id: 'alpha', deps: d });
    done.catch(() => {});
    await fetch(callbackUrl(url, { state: stateOf(url), code: 'code-1' }));
    await expect(done).rejects.toThrow(/myaccount\.google\.com\/permissions/);
    expect(await loadToken('alpha')).toBeNull();
  });

  it('fails when the Gmail permission was not granted', async () => {
    const { deps: d } = deps({ tokens: { refreshToken: 'r', accessToken: 'a', scope: 'openid email' } });
    const { url, done } = await startLoopbackAuth('alpha', { id: 'alpha', deps: d });
    done.catch(() => {});
    await fetch(callbackUrl(url, { state: stateOf(url), code: 'code-1' }));
    await expect(done).rejects.toThrow(/Gmail permission checkbox/);
    expect(await loadToken('alpha')).toBeNull();
  });

  it('fails when no OAuth client has been uploaded', async () => {
    const d: LoopbackDeps = { ...deps().deps, loadClient: async () => null };
    await expect(startLoopbackAuth('alpha', { id: 'alpha', deps: d })).rejects.toThrow(/OAuth client/);
  });

  it('does not time out mid-exchange: the timer is cleared once the callback is handled', async () => {
    await loadToken('alpha'); // warm the master key so slow key setup does not eat the bound
    const base = deps({ timeoutMs: 600 }).deps;
    const d: LoopbackDeps = {
      ...base,
      exchangeCode: async () => {
        await new Promise((r) => setTimeout(r, 400));
        return { refreshToken: 'refresh-1', accessToken: 'access-1', expiryDate: 1, scope: GMAIL_SCOPE };
      },
    };
    const { url, done } = await startLoopbackAuth('alpha', { id: 'alpha', deps: d });
    // Callback arrives near the end of the flow timeout; the exchange then outlives the original timer.
    await new Promise((r) => setTimeout(r, 400));
    await fetch(callbackUrl(url, { state: stateOf(url), code: 'code-1' }));
    expect(await done).toEqual({ id: 'alpha', name: 'alpha', email: 'you@example.com' });
    expect((await loadToken('alpha'))?.refreshToken).toBe('refresh-1');
  });

  it('timeout message reflects the configured timeout', async () => {
    const s = await startLoopbackAuth('beta', { deps: deps({ timeoutMs: 100 }).deps });
    await expect(s.done).rejects.toThrow(/after 1 second/);
    expect(formatDuration(120_000)).toBe('2 minutes');
    expect(formatDuration(60_000)).toBe('1 minute');
    expect(formatDuration(300_000)).toBe('5 minutes');
  });

  it('revokes only when the signed-in email is not connected under any alias', async () => {
    const calls: { url: string; body: string }[] = [];
    const fakeFetch = (async (url: string, init: { body: string }) => {
      calls.push({ url, body: init.body });
      throw new Error('network down');
    }) as unknown as typeof fetch;

    await seedConfig({
      alpha: { email: 'you@example.com', addedAt: '2026-01-01T00:00:00.000Z' },
      beta: { email: 'dup@example.com', addedAt: '2026-01-01T00:00:00.000Z' },
    });
    const bad = await startLoopbackAuth('alpha', {
      reconnect: true,
      deps: { ...deps({ email: 'other@example.com' }).deps, fetch: fakeFetch },
    });
    bad.done.catch(() => {});
    await fetch(callbackUrl(bad.url, { state: stateOf(bad.url), code: 'c' }));
    await expect(bad.done).rejects.toThrow(/Signed in as other@example.com/);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://oauth2.googleapis.com/revoke');
    expect(calls[0].body).toContain('token=refresh-1');

    const dup = await startLoopbackAuth('gamma', {
      deps: { ...deps({ email: 'dup@example.com' }).deps, fetch: fakeFetch },
    });
    dup.done.catch(() => {});
    await fetch(callbackUrl(dup.url, { state: stateOf(dup.url), code: 'c' }));
    await expect(dup.done).rejects.toThrow(/already connected as "beta"/);
    expect(calls).toHaveLength(1);

    // Reconnect mismatch where the signed-in email belongs to another alias: no revoke either.
    const mm = await startLoopbackAuth('alpha', {
      reconnect: true,
      deps: { ...deps({ email: 'dup@example.com' }).deps, fetch: fakeFetch },
    });
    mm.done.catch(() => {});
    await fetch(callbackUrl(mm.url, { state: stateOf(mm.url), code: 'c' }));
    await expect(mm.done).rejects.toThrow(/Signed in as dup@example.com/);
    expect(calls).toHaveLength(1);
  });

  it('bounds a hung exchange: rejects with timeout, closes the server, saves nothing late', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const d: LoopbackDeps = {
      ...deps({ timeoutMs: 250 }).deps,
      exchangeCode: async () => {
        await gate;
        return { refreshToken: 'late', accessToken: 'a', expiryDate: 1, scope: GMAIL_SCOPE };
      },
    };
    const { url, done } = await startLoopbackAuth('alpha', { id: 'alpha', deps: d });
    done.catch(() => {});
    fetch(callbackUrl(url, { state: stateOf(url), code: 'c' })).catch(() => {});
    const err = (await done.catch((e: unknown) => e)) as Error & { code?: string };
    expect(err.code).toBe('timeout');
    release();
    await new Promise((r) => setTimeout(r, 200));
    expect(await loadToken('alpha')).toBeNull();
    expect((await loadConfig()).accounts.alpha).toBeUndefined();
    await expect(fetch(callbackUrl(url, { state: stateOf(url), code: 'c' }))).rejects.toThrow();
  });
});
