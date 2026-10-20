import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { saveConfig } from '../../src/core/config.js';
import { AccountError, AuthFlowError } from '../../src/core/googleAuth.js';
import { setAccountStatus } from '../../src/gmail/errors.js';
import { clientProof, newNonce, serverProof } from '../../src/http/handshake.js';
import { probeExistingInstance } from '../../src/http/singleInstance.js';
import { getLocalApiKey, loadClient } from '../../src/core/secrets.js';
import { startLocalServer, type LocalServer, type LocalServerDeps } from '../../src/modes/localHttp.js';
import { raw, tempHome } from './helpers.js';

let home: Awaited<ReturnType<typeof tempHome>>;
let server: LocalServer | undefined;

beforeEach(async () => {
  home = await tempHome('mg-http-');
});
afterEach(async () => {
  await server?.close();
  server = undefined;
  await home.cleanup();
});

async function start(deps: LocalServerDeps = {}): Promise<LocalServer> {
  server = await startLocalServer({ port: 0, openBrowser: false }, { log: () => {}, ...deps });
  return server;
}

const portOf = (s: LocalServer) => Number(new URL(s.url).port);
const origin = (s: LocalServer) => `http://127.0.0.1:${portOf(s)}`;

async function session(s: LocalServer, launchUrl?: string): Promise<string> {
  let url = launchUrl;
  if (!url) {
    const probe = await probeExistingInstance(portOf(s), getLocalApiKey);
    if (probe.kind !== 'launch') throw new Error('handshake failed');
    url = probe.url;
  }
  const u = new URL(url);
  const r = await raw(portOf(s), { path: u.pathname + u.search });
  expect(r.status).toBe(302);
  const cookie = String(r.headers['set-cookie']);
  return cookie.split(';')[0];
}

function api(s: LocalServer, cookie: string, method: string, path: string, body?: unknown, extra: Record<string, string> = {}) {
  const headers: Record<string, string> = { Cookie: cookie, ...extra };
  if (method !== 'GET' && !('Origin' in extra)) headers.Origin = origin(s);
  let data: string | undefined;
  if (body !== undefined) {
    data = typeof body === 'string' ? body : JSON.stringify(body);
    headers['Content-Type'] = 'application/json';
  }
  return raw(portOf(s), { method, path, headers, body: data });
}

describe('local http server', () => {
  it('binds 127.0.0.1 and launch url uses 127.0.0.1', async () => {
    const s = await start();
    expect(s.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?t=[A-Za-z0-9_-]{43}$/);
  });

  it('GET /health answers without secrets', async () => {
    const s = await start();
    const r = await raw(portOf(s), { path: '/health' });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ app: 'multiple-gmail', version: expect.any(String) });
  });

  it('/mcp without bearer -> 401', async () => {
    const s = await start();
    const r = await raw(portOf(s), {
      method: 'POST',
      path: '/mcp',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: '{}',
    });
    expect(r.status).toBe(401);
    expect(r.headers['www-authenticate']).toMatch(/^Bearer/);
  });

  it('/mcp with a wrong bearer -> 401', async () => {
    const s = await start();
    const r = await raw(portOf(s), { method: 'POST', path: '/mcp', headers: { Authorization: 'Bearer nope' }, body: '{}' });
    expect(r.status).toBe(401);
  });

  it('/mcp with bearer and Host evil.com -> 403', async () => {
    const s = await start();
    const key = await getLocalApiKey();
    const r = await raw(portOf(s), {
      method: 'POST',
      path: '/mcp',
      headers: { Host: 'evil.com', Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(r.status).toBe(403);
  });

  it('/mcp with bearer and a foreign Origin -> 403', async () => {
    const s = await start();
    const key = await getLocalApiKey();
    const r = await raw(portOf(s), {
      method: 'POST',
      path: '/mcp',
      headers: { Origin: 'http://evil.com', Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(r.status).toBe(403);
  });

  it('/mcp with bearer serves tools/list with 11 tools', async () => {
    const s = await start();
    const key = await getLocalApiKey();
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${portOf(s)}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${key}` } },
    });
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(11);
    } finally {
      await client.close();
    }
  }, 30_000);

  it('/mcp still answers a 2025-era initialize (legacy stateless posture)', async () => {
    const s = await start();
    const key = await getLocalApiKey();
    const r = await raw(portOf(s), {
      method: 'POST',
      path: '/mcp',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
      }),
    });
    expect(r.status).toBe(200);
    expect(r.body).toContain('"protocolVersion":"2025-06-18"');
  });

  it('/api/state without cookie -> 401', async () => {
    const s = await start();
    const r = await raw(portOf(s), { path: '/api/state' });
    expect(r.status).toBe(401);
    expect(r.headers['cache-control']).toBe('no-store');
  });

  it('launch token works once, second use -> 401', async () => {
    const s = await start();
    const u = new URL(s.url);
    const first = await raw(portOf(s), { path: u.pathname + u.search });
    expect(first.status).toBe(302);
    expect(first.headers.location).toBe('/');
    const cookie = String(first.headers['set-cookie']);
    expect(cookie).toMatch(/^mg_session=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=\//);
    const second = await raw(portOf(s), { path: u.pathname + u.search });
    expect(second.status).toBe(401);
  });

  it('launch token expires after 2 minutes', async () => {
    let now = 1_000_000;
    const s = await start({ now: () => now });
    now += 2 * 60 * 1000 + 1;
    const u = new URL(s.url);
    const r = await raw(portOf(s), { path: u.pathname + u.search });
    expect(r.status).toBe(401);
  });

  it('GET /api/state with session returns state and security headers', async () => {
    const s = await start();
    await saveConfig({
      port: 47110,
      language: 'tr',
      defaultAccount: 'alpha',
      accounts: { alpha: { email: 'you@example.com', addedAt: '2026-10-01T00:00:00.000Z' } },
    });
    const cookie = await session(s, s.url);
    const r = await api(s, cookie, 'GET', '/api/state');
    expect(r.status).toBe(200);
    const body = JSON.parse(r.body);
    expect(body).toMatchObject({
      hasClient: false,
      language: 'tr',
      accounts: [{ alias: 'alpha', email: 'you@example.com', status: 'ok' }],
    });
    const key = await getLocalApiKey();
    expect(body.apiKeyMasked).not.toContain(key);
    expect(body.apiKeyMasked.endsWith(key.slice(-4))).toBe(true);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['referrer-policy']).toBe('no-referrer');
    expect(r.headers['x-frame-options']).toBe('DENY');
    expect(r.headers['content-security-policy']).toBe("default-src 'self'; frame-ancestors 'none'");
  });

  it('DELETE /api/accounts/x with Origin evil.com -> 403', async () => {
    const remove = vi.fn(async () => ({ revoked: true }));
    const s = await start({ removeAccount: remove });
    const cookie = await session(s);
    const r = await api(s, cookie, 'DELETE', '/api/accounts/x', undefined, { Origin: 'http://evil.com' });
    expect(r.status).toBe(403);
    const none = await raw(portOf(s), { method: 'DELETE', path: '/api/accounts/x', headers: { Cookie: cookie } });
    expect(none.status).toBe(403);
    expect(remove).not.toHaveBeenCalled();
  });

  it('DELETE /api/accounts/:alias removes with the right origin', async () => {
    const remove = vi.fn(async () => ({ revoked: true }));
    const s = await start({ removeAccount: remove });
    const cookie = await session(s);
    const r = await api(s, cookie, 'DELETE', '/api/accounts/alpha');
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ ok: true, revoked: true });
    expect(remove).toHaveBeenCalledWith('alpha');
  });

  it('rejects requests with a foreign Host on the UI too', async () => {
    const s = await start();
    const r = await raw(portOf(s), { path: '/api/state', headers: { Host: 'evil.com' } });
    expect(r.status).toBe(403);
  });

  it('POST /api/client stores a valid client and rejects invalid ones', async () => {
    const s = await start();
    const cookie = await session(s);
    const bad = await api(s, cookie, 'POST', '/api/client', '{"type":"service_account"}');
    expect(bad.status).toBe(400);
    expect(JSON.parse(bad.body).error).toMatch(/service account/i);
    const ok = await api(s, cookie, 'POST', '/api/client', {
      installed: { client_id: 'id-1', client_secret: 'sec-1', redirect_uris: ['http://localhost'] },
    });
    expect(ok.status).toBe(200);
    expect(ok.body).not.toContain('sec-1');
    expect((await loadClient())?.clientId).toBe('id-1');
  });

  it('GET /api/state exposes the non-secret client ID, never the client secret', async () => {
    const s = await start();
    const cookie = await session(s);
    const before = JSON.parse((await api(s, cookie, 'GET', '/api/state')).body);
    expect(before.clientId).toBeNull();
    await api(s, cookie, 'POST', '/api/client', {
      installed: { client_id: 'id-1.apps.googleusercontent.com', client_secret: 'sec-1', redirect_uris: ['http://localhost'] },
    });
    const r = await api(s, cookie, 'GET', '/api/state');
    const body = JSON.parse(r.body);
    expect(body.hasClient).toBe(true);
    expect(body.clientId).toBe('id-1.apps.googleusercontent.com');
    expect(body.clientKind).toBe('installed');
    expect(r.body).not.toContain('sec-1');
  });

  it('rejects bodies over 1 MB with 413', async () => {
    const s = await start();
    const cookie = await session(s);
    const r = await api(s, cookie, 'POST', '/api/client', 'x'.repeat(1024 * 1024 + 10));
    expect(r.status).toBe(413);
  });

  it('requires application/json for non-empty bodies', async () => {
    const s = await start();
    const cookie = await session(s);
    const r = await raw(portOf(s), {
      method: 'POST',
      path: '/api/language',
      headers: { Cookie: cookie, Origin: origin(s), 'Content-Type': 'text/plain' },
      body: '{"language":"tr"}',
    });
    expect(r.status).toBe(415);
  });

  it('POST /api/language saves the language', async () => {
    const s = await start();
    const cookie = await session(s);
    const r = await api(s, cookie, 'POST', '/api/language', { language: 'tr' });
    expect(r.status).toBe(200);
    const st = JSON.parse((await api(s, cookie, 'GET', '/api/state')).body);
    expect(st.language).toBe('tr');
    const bad = await api(s, cookie, 'POST', '/api/language', { language: 'xx' });
    expect(bad.status).toBe(400);
  });

  it('GET /api/apikey needs same-origin; rotate changes the key', async () => {
    const s = await start();
    const cookie = await session(s);
    const cross = await api(s, cookie, 'GET', '/api/apikey');
    expect(cross.status).toBe(403);
    const ok = await api(s, cookie, 'GET', '/api/apikey', undefined, { 'Sec-Fetch-Site': 'same-origin' });
    expect(ok.status).toBe(200);
    expect(ok.headers['cache-control']).toBe('no-store');
    const before = JSON.parse(ok.body).apiKey;
    expect(before).toBe(await getLocalApiKey());
    const viaOrigin = await api(s, cookie, 'GET', '/api/apikey', undefined, { Origin: origin(s) });
    expect(viaOrigin.status).toBe(200);
    const rot = await api(s, cookie, 'POST', '/api/apikey/rotate');
    expect(rot.status).toBe(200);
    const after = await getLocalApiKey();
    expect(after).not.toBe(before);
    expect(JSON.parse(rot.body).apiKeyMasked.endsWith(after.slice(-4))).toBe(true);
  });

  it('account connect flow: pending, then connected; failures carry the reason', async () => {
    let resolveDone!: (v: { alias: string; email: string }) => void;
    let rejectDone!: (e: Error) => void;
    const calls: unknown[] = [];
    const startAuth = vi.fn(async (alias: string, opts: unknown) => {
      calls.push(opts);
      const done = new Promise<{ alias: string; email: string }>((res, rej) => {
        if (alias === 'alpha') resolveDone = res;
        else rejectDone = rej;
      });
      return { url: `https://accounts.example.com/auth?a=${alias}`, done };
    });
    const s = await start({ startLoopbackAuth: startAuth });
    const cookie = await session(s);
    const bad = await api(s, cookie, 'POST', '/api/accounts', { alias: 'All' });
    expect(bad.status).toBe(400);

    const r = await api(s, cookie, 'POST', '/api/accounts', { alias: 'alpha', email: 'you@example.com' });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ authUrl: 'https://accounts.example.com/auth?a=alpha' });
    expect(calls[0]).toMatchObject({ loginHint: 'you@example.com' });
    let st = await api(s, cookie, 'GET', '/api/accounts/alpha/status');
    expect(JSON.parse(st.body)).toEqual({ status: 'pending' });
    resolveDone({ alias: 'alpha', email: 'you@example.com' });
    await new Promise((r2) => setTimeout(r2, 10));
    st = await api(s, cookie, 'GET', '/api/accounts/alpha/status');
    expect(JSON.parse(st.body)).toEqual({ status: 'connected', email: 'you@example.com' });

    await api(s, cookie, 'POST', '/api/accounts', { alias: 'beta' });
    rejectDone(new AuthFlowError('admin_blocked', 'blocked'));
    await new Promise((r2) => setTimeout(r2, 10));
    st = await api(s, cookie, 'GET', '/api/accounts/beta/status');
    expect(JSON.parse(st.body)).toMatchObject({ status: 'failed', reason: 'admin_blocked' });

    const unknown = await api(s, cookie, 'GET', '/api/accounts/gamma/status');
    expect(unknown.status).toBe(404);
  });

  it('reconnect passes reconnect: true', async () => {
    const startAuth = vi.fn(async () => ({ url: 'https://accounts.example.com/x', done: new Promise<never>(() => {}) }));
    const s = await start({ startLoopbackAuth: startAuth });
    const cookie = await session(s);
    const r = await api(s, cookie, 'POST', '/api/accounts/alpha/reconnect');
    expect(r.status).toBe(200);
    expect(startAuth).toHaveBeenCalledWith('alpha', expect.objectContaining({ reconnect: true }));
  });

  it('maps a missing OAuth client to 409', async () => {
    const startAuth = vi.fn(async () => {
      throw new AccountError('no_client', 'No OAuth client has been uploaded yet. Upload the OAuth client JSON first.');
    });
    const s = await start({ startLoopbackAuth: startAuth });
    const cookie = await session(s);
    const r = await api(s, cookie, 'POST', '/api/accounts', { alias: 'alpha' });
    expect(r.status).toBe(409);
  });

  it('serves the setup page with CSP', async () => {
    const s = await start();
    const r = await raw(portOf(s), { path: '/' });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/^text\/html/);
    expect(r.headers['content-security-policy']).toBe("default-src 'self'; frame-ancestors 'none'");
    expect(r.body).toContain('multiple-gmail');
  });

  describe('second-instance handshake', () => {
    const post = (s: LocalServer, path: string, body: unknown, headers: Record<string, string> = {}) =>
      raw(portOf(s), {
        method: 'POST',
        path,
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });

    it('real handshake works and the server proof verifies', async () => {
      const s = await start();
      const key = await getLocalApiKey();
      const nonceC = newNonce();
      const ch = await post(s, '/internal/launch/challenge', { nonceC });
      expect(ch.status).toBe(200);
      const { nonceS, proof } = JSON.parse(ch.body);
      expect(proof).toBe(serverProof(key, portOf(s), nonceC, nonceS));
      expect(ch.body).not.toContain(key);
      const r = await post(s, '/internal/launch', { nonceS, proof: clientProof(key, portOf(s), nonceS, nonceC) });
      expect(r.status).toBe(200);
      expect(JSON.parse(r.body).url.startsWith(`http://127.0.0.1:${portOf(s)}/?t=`)).toBe(true);
      expect((await probeExistingInstance(portOf(s), getLocalApiKey)).kind).toBe('launch');
    });

    it('a replayed nonceS is rejected', async () => {
      const s = await start();
      const key = await getLocalApiKey();
      const nonceC = newNonce();
      const { nonceS } = JSON.parse((await post(s, '/internal/launch/challenge', { nonceC })).body);
      const body = { nonceS, proof: clientProof(key, portOf(s), nonceS, nonceC) };
      expect((await post(s, '/internal/launch', body)).status).toBe(200);
      expect((await post(s, '/internal/launch', body)).status).toBe(401);
    });

    it('a wrong client proof is rejected and burns the nonce', async () => {
      const s = await start();
      const key = await getLocalApiKey();
      const nonceC = newNonce();
      const { nonceS } = JSON.parse((await post(s, '/internal/launch/challenge', { nonceC })).body);
      const wrong = await post(s, '/internal/launch', { nonceS, proof: clientProof('wrong-key', portOf(s), nonceS, nonceC) });
      expect(wrong.status).toBe(401);
      const right = await post(s, '/internal/launch', { nonceS, proof: clientProof(key, portOf(s), nonceS, nonceC) });
      expect(right.status).toBe(401);
    });

    it('nonces expire after 30 s', async () => {
      let now = 5_000_000;
      const s = await start({ now: () => now });
      const key = await getLocalApiKey();
      const nonceC = newNonce();
      const { nonceS } = JSON.parse((await post(s, '/internal/launch/challenge', { nonceC })).body);
      now += 30_001;
      const r = await post(s, '/internal/launch', { nonceS, proof: clientProof(key, portOf(s), nonceS, nonceC) });
      expect(r.status).toBe(401);
    });

    it('the bearer key is not accepted; browsers and foreign hosts are refused', async () => {
      const s = await start();
      const key = await getLocalApiKey();
      const bearer = await raw(portOf(s), {
        method: 'POST',
        path: '/internal/launch',
        headers: { Authorization: `Bearer ${key}` },
      });
      expect(bearer.status).not.toBe(200);
      for (const path of ['/internal/launch/challenge', '/internal/launch']) {
        expect((await post(s, path, { nonceC: newNonce() }, { Origin: 'http://evil.com' })).status).toBe(403);
        expect((await post(s, path, { nonceC: newNonce() }, { Host: 'evil.com' })).status).toBe(403);
      }
    });
  });

  it('HEAD does not consume a launch token', async () => {
    const s = await start();
    const u = new URL(s.url);
    const head = await raw(portOf(s), { method: 'HEAD', path: u.pathname + u.search });
    expect(head.status).not.toBe(302);
    const get = await raw(portOf(s), { path: u.pathname + u.search });
    expect(get.status).toBe(302);
  });

  it('concurrent connects for one alias share one pending flow', async () => {
    const startAuth = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 30));
      return { url: 'https://accounts.example.com/one', done: new Promise<never>(() => {}) };
    });
    const s = await start({ startLoopbackAuth: startAuth });
    const cookie = await session(s);
    const [a, b] = await Promise.all([
      api(s, cookie, 'POST', '/api/accounts', { alias: 'alpha' }),
      api(s, cookie, 'POST', '/api/accounts', { alias: 'alpha' }),
    ]);
    const c = await api(s, cookie, 'POST', '/api/accounts', { alias: 'alpha' });
    for (const r of [a, b, c]) {
      expect(r.status).toBe(200);
      expect(JSON.parse(r.body)).toEqual({ authUrl: 'https://accounts.example.com/one' });
    }
    expect(startAuth).toHaveBeenCalledTimes(1);
  });

  it('status of a configured account reflects the live Gmail status', async () => {
    const s = await start();
    await saveConfig({
      port: 47110,
      language: 'en',
      defaultAccount: 'alpha',
      accounts: { alpha: { email: 'you@example.com', addedAt: '2026-10-01T00:00:00.000Z' } },
    });
    const cookie = await session(s);
    const status = async () => JSON.parse((await api(s, cookie, 'GET', '/api/accounts/alpha/status')).body).status;
    expect(await status()).toBe('connected');
    setAccountStatus('alpha', 'needs_reauth');
    expect(await status()).toBe('needs_reauth');
    setAccountStatus('alpha', 'error');
    expect(await status()).toBe('error');
    setAccountStatus('alpha', 'ok');
  });

  it('a failed flow with a non-AuthFlowError shows a generic message', async () => {
    let rejectDone!: (e: Error) => void;
    const startAuth = vi.fn(async () => ({
      url: 'https://accounts.example.com/x',
      done: new Promise<never>((_r, rej) => (rejectDone = rej)),
    }));
    const s = await start({ startLoopbackAuth: startAuth });
    const cookie = await session(s);
    await api(s, cookie, 'POST', '/api/accounts', { alias: 'alpha' });
    rejectDone(new Error('internal detail with a secret path'));
    await new Promise((r) => setTimeout(r, 10));
    const st = JSON.parse((await api(s, cookie, 'GET', '/api/accounts/alpha/status')).body);
    expect(st).toMatchObject({ status: 'failed', reason: 'unknown' });
    expect(st.message).not.toContain('secret');
  });

  it('opens the browser only when asked', async () => {
    const openUrl = vi.fn(async () => {});
    server = await startLocalServer({ port: 0, openBrowser: true }, { log: () => {}, openUrl });
    expect(openUrl).toHaveBeenCalledWith(server.url);
    await server.close();
    server = await startLocalServer({ port: 0, openBrowser: false }, { log: () => {}, openUrl });
    expect(openUrl).toHaveBeenCalledTimes(1);
  });
});
