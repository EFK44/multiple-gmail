import { mkdtemp, rm } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli, type CliIo } from '../../src/modes/cli.js';
import { RemoteConfigError, createRemoteServer, parseRemoteEnv } from '../../src/modes/remote.js';
import { clientIp, hashPassword, parsePasswordHash, verifyPassword } from '../../src/remote/adminAuth.js';
import { FORM, JSON_TYPE, PASSWORD, baseEnv, form, startHarness, type Harness } from './helpers.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

function io(extra: Partial<CliIo> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const o: CliIo & { out: string[]; err: string[] } = {
    out,
    err,
    log: (s) => out.push(s),
    error: (s) => err.push(s),
    isTty: false,
    confirm: async () => '',
    openUrl: async () => {},
    ...extra,
  };
  return o;
}

async function tempEnv(): Promise<{ env: Record<string, string>; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'mg-remote-cfg-'));
  return { env: await baseEnv(dir), cleanup: () => rm(dir, { recursive: true, force: true }) };
}

const cookieOf = (setCookie: string | string[] | undefined, name: string): string => {
  const all = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const c = all.find((s) => s.startsWith(`${name}=`));
  if (!c) throw new Error(`no ${name} cookie`);
  return c;
};

async function adminLogin(hh: Harness, password = PASSWORD) {
  const page = await hh.req({ path: '/admin/login' });
  const csrf = /name="csrf" value="([^"]+)"/.exec(page.body)?.[1] ?? '';
  return hh.req({ method: 'POST', path: '/admin/login', headers: FORM, body: form({ csrf, password }) });
}

describe('password hashing', () => {
  it('hash format is scrypt$N$r$p$salt$hash and verifies', async () => {
    const hash = await hashPassword('a long enough password');
    expect(hash).toMatch(/^scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    const parsed = parsePasswordHash(hash);
    expect(await verifyPassword('a long enough password', parsed)).toBe(true);
    expect(await verifyPassword('a long enough passwore', parsed)).toBe(false);
  });

  it('rejects malformed or out-of-bounds hashes', () => {
    expect(() => parsePasswordHash('plain')).toThrow();
    expect(() => parsePasswordHash('scrypt$1$8$1$AAAA$AAAA')).toThrow();
    expect(() => parsePasswordHash('scrypt$1073741824$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=')).toThrow();
  });

  it('hash-password reads the secret and prints a verifiable hash', async () => {
    const o = io({ readSecret: async () => 'another long password' });
    expect(await runCli(['hash-password'], o)).toBe(0);
    const line = o.out.join('\n').trim();
    expect(await verifyPassword('another long password', parsePasswordHash(line))).toBe(true);
  });

  it('hash-password refuses a short password', async () => {
    const o = io({ readSecret: async () => 'short' });
    expect(await runCli(['hash-password'], o)).toBe(1);
    expect(o.err.join('\n')).toMatch(/at least 12/);
  });
});

describe('remote configuration', () => {
  it('startup without ADMIN_PASSWORD_HASH exits with a clear message', async () => {
    const { env, cleanup } = await tempEnv();
    try {
      const { ADMIN_PASSWORD_HASH: _drop, ...rest } = env;
      await expect(createRemoteServer({ env: rest })).rejects.toThrow(/ADMIN_PASSWORD_HASH/);
      const o = io({ env: rest });
      expect(await runCli(['serve', '--remote'], o)).toBe(1);
      expect(o.err.join('\n')).toMatch(/ADMIN_PASSWORD_HASH is not set.*hash-password/s);
    } finally {
      await cleanup();
    }
  });

  it('requires an https PUBLIC_URL unless insecure mode is allowed for localhost', async () => {
    const { env, cleanup } = await tempEnv();
    try {
      expect(() => parseRemoteEnv({ ...env, MULTIPLE_GMAIL_ALLOW_INSECURE: undefined })).toThrow(RemoteConfigError);
      expect(() => parseRemoteEnv({ ...env, PUBLIC_URL: 'http://mail.example.com' })).toThrow(/https/);
      expect(() => parseRemoteEnv({ ...env, PUBLIC_URL: undefined })).toThrow(/PUBLIC_URL/);
      expect(() => parseRemoteEnv({ ...env, PUBLIC_URL: 'https://mail.example.com/sub' })).toThrow(/path/);
      expect(parseRemoteEnv({ ...env, PUBLIC_URL: 'https://mail.example.com/' }).publicUrl).toBe('https://mail.example.com');
    } finally {
      await cleanup();
    }
  });

  it('requires the master key from the environment', async () => {
    const { env, cleanup } = await tempEnv();
    try {
      expect(() => parseRemoteEnv({ ...env, MULTIPLE_GMAIL_MASTER_KEY: undefined })).toThrow(/MULTIPLE_GMAIL_MASTER_KEY/);
      expect(() => parseRemoteEnv({ ...env, PORT: 'abc' })).toThrow(/PORT/);
      const cfg = parseRemoteEnv({ ...env, PORT: undefined, HOST: undefined });
      expect(cfg.port).toBe(8080);
      expect(cfg.host).toBe('0.0.0.0');
    } finally {
      await cleanup();
    }
  });
});

describe('remote admin', () => {
  it('the wizard and /api need an admin session', async () => {
    h = await startHarness();
    const root = await h.req({ path: '/' });
    expect(root.status).toBe(302);
    expect(root.headers.location).toBe('/admin/login');
    const api = await h.req({ path: '/api/state' });
    expect(api.status).toBe(401);
  });

  it('login sets a Secure HttpOnly SameSite=Strict cookie that opens /api/state in remote mode', async () => {
    h = await startHarness();
    const r = await adminLogin(h);
    expect(r.status).toBe(303);
    const cookie = cookieOf(r.headers['set-cookie'], '__Host-mg_admin');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    const value = cookie.split(';')[0];
    const state = await h.req({ path: '/api/state', headers: { Cookie: value } });
    expect(state.status).toBe(200);
    const s = JSON.parse(state.body);
    expect(s.mode).toBe('remote');
    expect(s.apiKeyMasked).toBeUndefined();
    expect(s.mcpUrl).toBe('http://localhost/mcp');
    expect(s.googleRedirectUri).toBe('http://localhost/oauth/google/callback');

    for (const path of ['/api/apikey', '/api/integrations', '/api/autostart']) {
      expect((await h.req({ path, headers: { Cookie: value } })).status, path).toBe(404);
    }
    const page = await h.req({ path: '/', headers: { Cookie: value } });
    expect(page.status).toBe(200);
    expect(page.body).toContain('app.js');
  });

  it('a wrong admin password is refused and counted by the rate limiter', async () => {
    h = await startHarness();
    for (let i = 0; i < 5; i++) expect((await adminLogin(h, 'wrong')).status).toBe(401);
    expect((await adminLogin(h, 'wrong')).status).toBe(429);
  }, 30_000);

  it('login without a valid CSRF token is refused', async () => {
    h = await startHarness();
    const r = await h.req({ method: 'POST', path: '/admin/login', headers: FORM, body: form({ csrf: 'x', password: PASSWORD }) });
    expect(r.status).toBe(403);
  });

  it('a state-changing /api call from a foreign Origin is refused', async () => {
    h = await startHarness();
    const value = cookieOf((await adminLogin(h)).headers['set-cookie'], '__Host-mg_admin').split(';')[0];
    const r = await h.req({
      method: 'POST',
      path: '/api/language',
      headers: { ...JSON_TYPE, Cookie: value, Origin: 'https://evil.example' },
      body: JSON.stringify({ language: 'tr' }),
    });
    expect(r.status).toBe(403);
  });

  it('remote only accepts a Web application OAuth client', async () => {
    h = await startHarness();
    const value = cookieOf((await adminLogin(h)).headers['set-cookie'], '__Host-mg_admin').split(';')[0];
    const post = (body: unknown) =>
      h!.req({
        method: 'POST',
        path: '/api/client',
        headers: { ...JSON_TYPE, Cookie: value, Origin: 'http://localhost' },
        body: JSON.stringify(body),
      });
    const desktop = await post({ installed: { client_id: 'i', client_secret: 's', redirect_uris: [] } });
    expect(desktop.status).toBe(400);
    const wrongUri = await post({ web: { client_id: 'i', client_secret: 's', redirect_uris: ['https://x.example/cb'] } });
    expect(wrongUri.status).toBe(400);
    expect(JSON.parse(wrongUri.body).error).toContain('http://localhost/oauth/google/callback');
    const ok = await post({ web: { client_id: 'i', client_secret: 's', redirect_uris: ['http://localhost/oauth/google/callback'] } });
    expect(ok.status).toBe(200);
  });

  it('connects a Google account through the web callback (state + PKCE + admin cookie)', async () => {
    const seen: { codeVerifier?: string; redirectUri?: string } = {};
    h = await startHarness({
      google: {
        loadClient: async () => ({ clientId: 'cid', clientSecret: 'sec', kind: 'web', redirectUris: [] }),
        exchangeCode: async (a) => {
          seen.codeVerifier = a.codeVerifier;
          seen.redirectUri = a.redirectUri;
          return { refreshToken: 'r', accessToken: 'a', scope: 'https://www.googleapis.com/auth/gmail.modify' };
        },
        getProfileEmail: async () => 'you@example.com',
      },
    });
    const login = await adminLogin(h);
    const admin = cookieOf(login.headers['set-cookie'], '__Host-mg_admin').split(';')[0];
    const cb = cookieOf(login.headers['set-cookie'], '__Host-mg_admin_cb');
    expect(cb).toContain('SameSite=Lax');
    const start = await h.req({
      method: 'POST',
      path: '/api/accounts',
      headers: { ...JSON_TYPE, Cookie: admin, Origin: 'http://localhost' },
      body: JSON.stringify({ name: 'İş Hesabı' }),
    });
    expect(start.status).toBe(200);
    const authUrl = new URL(JSON.parse(start.body).authUrl);
    const id = JSON.parse(start.body).id as string;
    expect(authUrl.searchParams.get('redirect_uri')).toBe('http://localhost/oauth/google/callback');
    expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256');
    const state = authUrl.searchParams.get('state') ?? '';

    const wrongState = await h.req({ path: `/oauth/google/callback?state=nope&code=c`, headers: { Cookie: cb.split(';')[0] } });
    expect(wrongState.status).toBe(400);

    const done = await h.req({ path: `/oauth/google/callback?state=${state}&code=c`, headers: { Cookie: cb.split(';')[0] } });
    expect(done.status).toBe(200);
    expect(seen.redirectUri).toBe('http://localhost/oauth/google/callback');
    expect(seen.codeVerifier?.length).toBeGreaterThan(40);
    const status = await h.req({ path: `/api/accounts/${id}/status`, headers: { Cookie: admin } });
    expect(JSON.parse(status.body)).toMatchObject({ status: 'connected', name: 'İş Hesabı' });
    // The state is single use.
    const again = await h.req({ path: `/oauth/google/callback?state=${state}&code=c`, headers: { Cookie: cb.split(';')[0] } });
    expect(again.status).toBe(400);
  });

  it('the Google callback needs the admin browser cookie', async () => {
    h = await startHarness();
    const r = await h.req({ path: '/oauth/google/callback?state=abc&code=def' });
    expect(r.status).toBe(401);
  });
});

describe('remote proxy handling and admin page limits', () => {
  const fakeReq = (xff: string | undefined, remote = '10.0.0.5') =>
    ({ headers: xff === undefined ? {} : { 'x-forwarded-for': xff }, socket: { remoteAddress: remote } }) as unknown as IncomingMessage;

  it('clientIp uses the socket address unless TRUST_PROXY is on', () => {
    expect(clientIp(fakeReq('203.0.113.9'), false)).toBe('10.0.0.5');
    expect(clientIp(fakeReq('203.0.113.9'), true)).toBe('203.0.113.9');
    expect(clientIp(fakeReq(undefined), true)).toBe('10.0.0.5');
  });

  it('a spoofed leftmost X-Forwarded-For entry is ignored: the rightmost (added by the proxy) wins', () => {
    expect(clientIp(fakeReq('1.2.3.4, 198.51.100.7'), true)).toBe('198.51.100.7');
    expect(clientIp(fakeReq('1.2.3.4,   198.51.100.7  '), true)).toBe('198.51.100.7');
  });

  it('logs once when X-Forwarded-For arrives while TRUST_PROXY is off', async () => {
    const logs: string[] = [];
    h = await startHarness({ log: (s) => logs.push(s) });
    await h.req({ path: '/health', headers: { 'X-Forwarded-For': '1.2.3.4' } });
    await h.req({ path: '/admin/login', headers: { 'X-Forwarded-For': '1.2.3.4' } });
    await h.req({ path: '/admin/login', headers: { 'X-Forwarded-For': '1.2.3.4' } });
    expect(logs.filter((l) => l.includes('TRUST_PROXY')).length).toBe(1);
  });

  it('unauthenticated GET /admin/login is limited per IP', async () => {
    h = await startHarness();
    const statuses: number[] = [];
    for (let i = 0; i < 61; i++) statuses.push((await h.req({ path: '/admin/login' })).status);
    expect(statuses.slice(0, 60).every((s) => s === 200)).toBe(true);
    expect(statuses[60]).toBe(429);
  });

  it('admin cookies are session cookies (no Max-Age)', async () => {
    h = await startHarness();
    const r = await adminLogin(h);
    for (const name of ['__Host-mg_admin', '__Host-mg_admin_cb']) {
      expect(cookieOf(r.headers['set-cookie'], name)).not.toMatch(/Max-Age|Expires/i);
    }
  });
});
