import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetMasterKeyCacheForTests, useMasterKey } from '../../src/core/masterKey.js';
import { RemoteStore } from '../../src/remote/store.js';
import {
  FORM,
  JSON_TYPE,
  MCP_URL,
  PASSWORD,
  PUBLIC,
  REDIRECT,
  authorizeQuery,
  exchange,
  form,
  getCode,
  pkce,
  register,
  startHarness,
  txnFrom,
  type Harness,
} from './helpers.js';

let h: Harness;
beforeEach(async () => {
  h = await startHarness();
});
afterEach(async () => {
  await h.close();
});

const json = (body: string) => JSON.parse(body) as Record<string, any>;

async function listTools(token: string): Promise<number> {
  const transport = new StreamableHTTPClientTransport(new URL(`http://localhost:${h.server.port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(transport);
  try {
    return (await client.listTools()).tools.length;
  } finally {
    await client.close();
  }
}

describe('remote oauth: discovery', () => {
  it('authorization server metadata lists S256 and our endpoints', async () => {
    const r = await h.req({ path: '/.well-known/oauth-authorization-server' });
    expect(r.status).toBe(200);
    const m = json(r.body);
    expect(m.code_challenge_methods_supported).toEqual(['S256']);
    expect(m.issuer).toBe(PUBLIC);
    expect(m.authorization_endpoint).toBe(`${PUBLIC}/authorize`);
    expect(m.token_endpoint).toBe(`${PUBLIC}/token`);
    expect(m.registration_endpoint).toBe(`${PUBLIC}/register`);
    expect(m.token_endpoint_auth_methods_supported).toEqual(['none']);
    expect(m.authorization_response_iss_parameter_supported).toBe(true);
  });

  it('protected resource metadata is served at the path-aware and the root well-known URL', async () => {
    for (const path of ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource']) {
      const r = await h.req({ path });
      expect(r.status, path).toBe(200);
      const m = json(r.body);
      expect(m.resource).toBe(MCP_URL);
      expect(m.authorization_servers).toEqual([PUBLIC]);
    }
  });

  it('/mcp without a token -> 401 with resource_metadata in WWW-Authenticate', async () => {
    const r = await h.req({ method: 'POST', path: '/mcp', headers: JSON_TYPE, body: '{}' });
    expect(r.status).toBe(401);
    const challenge = String(r.headers['www-authenticate']);
    expect(challenge).toContain('Bearer');
    expect(challenge).toContain(`resource_metadata="${PUBLIC}/.well-known/oauth-protected-resource/mcp"`);
  });

  it('/mcp with an unknown token -> 401', async () => {
    const r = await h.req({ method: 'POST', path: '/mcp', headers: { ...JSON_TYPE, Authorization: 'Bearer nope' }, body: '{}' });
    expect(r.status).toBe(401);
  });

  it('a foreign Host header is refused', async () => {
    const r = await h.req({ path: '/.well-known/oauth-authorization-server', headers: { Host: 'evil.example' } });
    expect(r.status).toBe(403);
  });

  it('local-only endpoints do not exist in remote mode', async () => {
    const r = await h.req({ method: 'POST', path: '/internal/launch/challenge', headers: JSON_TYPE, body: '{}' });
    expect(r.status).toBe(404);
  });
});

describe('remote oauth: full flow', () => {
  it('register -> authorize -> token -> /mcp tools/list', async () => {
    const clientId = await register(h, { client_name: 'Evil <script>x</script>' });
    const { verifier, challenge } = pkce();
    const page = await h.req({ path: `/authorize?${authorizeQuery(clientId, challenge)}` });
    expect(page.status).toBe(200);
    expect(page.body).toContain('Evil &lt;script&gt;x&lt;/script&gt;');
    expect(page.body).not.toContain('<script>');
    expect(page.body).toContain('client.example.com');
    const csp = String(page.headers['content-security-policy']);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain('form-action');

    const post = await h.req({
      method: 'POST',
      path: '/authorize',
      headers: FORM,
      body: form({ txn: txnFrom(page.body), password: PASSWORD, action: 'approve' }),
    });
    expect(post.status).toBe(302);
    const loc = new URL(String(post.headers.location));
    expect(`${loc.origin}${loc.pathname}`).toBe(REDIRECT);
    expect(loc.searchParams.get('state')).toBe('st-123');
    expect(loc.searchParams.get('iss')).toBe(PUBLIC);
    const code = loc.searchParams.get('code') ?? '';
    expect(code.length).toBeGreaterThan(20);

    const tok = await exchange(h, { clientId, code, verifier });
    expect(tok.status).toBe(200);
    expect(tok.headers['cache-control']).toBe('no-store');
    const t = json(tok.body);
    expect(t.token_type).toBe('Bearer');
    expect(t.expires_in).toBe(3600);
    expect(typeof t.refresh_token).toBe('string');

    expect(await listTools(t.access_token)).toBe(11);
  }, 30_000);

  it('tokens are stored only as hashes in remote-tokens.enc and survive a restart', async () => {
    const c = await getCode(h);
    const t = json((await exchange(h, c)).body);
    const file = join(h.env.MULTIPLE_GMAIL_HOME, 'remote-tokens.enc');
    const blob = await readFile(file);
    expect(blob.includes(Buffer.from(t.access_token))).toBe(false);
    await h.restart();
    const r = await h.req({
      method: 'POST',
      path: '/mcp',
      headers: { ...JSON_TYPE, Accept: 'application/json, text/event-stream', Authorization: `Bearer ${t.access_token}` },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
      }),
    });
    expect(r.status).toBe(200);
  });

  it('refresh rotates; reusing an old refresh token revokes the whole family', async () => {
    const c = await getCode(h);
    const first = json((await exchange(h, c)).body);
    const refresh = (token: string) =>
      h.req({
        method: 'POST',
        path: '/token',
        headers: FORM,
        body: form({ grant_type: 'refresh_token', refresh_token: token, client_id: c.clientId }),
      });
    const r2 = await refresh(first.refresh_token);
    expect(r2.status).toBe(200);
    const second = json(r2.body);
    expect(second.refresh_token).not.toBe(first.refresh_token);

    const reuse = await refresh(first.refresh_token);
    expect(reuse.status).toBe(400);
    expect(json(reuse.body).error).toBe('invalid_grant');

    // The family is gone: the rotated refresh token and its access token no longer work.
    expect(json((await refresh(second.refresh_token)).body).error).toBe('invalid_grant');
    const mcp = await h.req({ method: 'POST', path: '/mcp', headers: { ...JSON_TYPE, Authorization: `Bearer ${second.access_token}` }, body: '{}' });
    expect(mcp.status).toBe(401);
  });
});

describe('remote oauth: token endpoint errors', () => {
  it('wrong code_verifier -> invalid_grant', async () => {
    const c = await getCode(h);
    const r = await exchange(h, { ...c, verifier: pkce().verifier });
    expect(r.status).toBe(400);
    expect(json(r.body).error).toBe('invalid_grant');
  });

  it('a reused code -> invalid_grant and the tokens from its first use are revoked', async () => {
    const c = await getCode(h);
    const first = await exchange(h, c);
    expect(first.status).toBe(200);
    const again = await exchange(h, c);
    expect(again.status).toBe(400);
    expect(json(again.body).error).toBe('invalid_grant');
    const access = json(first.body).access_token;
    const mcp = await h.req({ method: 'POST', path: '/mcp', headers: { ...JSON_TYPE, Authorization: `Bearer ${access}` }, body: '{}' });
    expect(mcp.status).toBe(401);
  });

  it('a different redirect_uri at the token endpoint -> invalid_grant', async () => {
    const c = await getCode(h);
    const r = await h.req({
      method: 'POST',
      path: '/token',
      headers: FORM,
      body: form({
        grant_type: 'authorization_code',
        code: c.code,
        redirect_uri: 'https://client.example.com/other',
        client_id: c.clientId,
        code_verifier: c.verifier,
      }),
    });
    expect(json(r.body).error).toBe('invalid_grant');
  });

  it('unsupported grant type -> unsupported_grant_type', async () => {
    const r = await h.req({ method: 'POST', path: '/token', headers: FORM, body: form({ grant_type: 'password' }) });
    expect(r.status).toBe(400);
    expect(json(r.body).error).toBe('unsupported_grant_type');
  });
});

describe('remote oauth: authorize endpoint', () => {
  it('6th wrong password in the window -> 429', async () => {
    const clientId = await register(h);
    const page = await h.req({ path: `/authorize?${authorizeQuery(clientId, pkce().challenge)}` });
    const txn = txnFrom(page.body);
    const attempt = () =>
      h.req({ method: 'POST', path: '/authorize', headers: FORM, body: form({ txn, password: 'wrong', action: 'approve' }) });
    for (let i = 0; i < 5; i++) expect((await attempt()).status).toBe(401);
    const sixth = await attempt();
    expect(sixth.status).toBe(429);
    // Even the right password is refused while the window is closed.
    const right = await h.req({ method: 'POST', path: '/authorize', headers: FORM, body: form({ txn, password: PASSWORD, action: 'approve' }) });
    expect(right.status).toBe(429);
  }, 30_000);

  it('a redirect_uri that is not registered -> 400 without a redirect', async () => {
    const clientId = await register(h);
    const r = await h.req({
      path: `/authorize?${authorizeQuery(clientId, pkce().challenge, { redirect_uri: 'https://attacker.example/cb' })}`,
    });
    expect(r.status).toBe(400);
    expect(r.headers.location).toBeUndefined();
  });

  it('an unknown client_id -> 400 without a redirect', async () => {
    const r = await h.req({ path: `/authorize?${authorizeQuery('nope', pkce().challenge)}` });
    expect(r.status).toBe(400);
    expect(r.headers.location).toBeUndefined();
  });

  it('missing PKCE or plain method -> redirect with invalid_request', async () => {
    const clientId = await register(h);
    const r = await h.req({ path: `/authorize?${authorizeQuery(clientId, 'x'.repeat(43), { code_challenge_method: 'plain' })}` });
    expect(r.status).toBe(302);
    const loc = new URL(String(r.headers.location));
    expect(loc.searchParams.get('error')).toBe('invalid_request');
    expect(loc.searchParams.get('state')).toBe('st-123');
  });

  it('a resource other than the MCP URL -> invalid_target', async () => {
    const clientId = await register(h);
    const r = await h.req({ path: `/authorize?${authorizeQuery(clientId, pkce().challenge, { resource: 'https://other.example/mcp' })}` });
    expect(r.status).toBe(302);
    expect(new URL(String(r.headers.location)).searchParams.get('error')).toBe('invalid_target');
  });

  it('deny redirects with access_denied', async () => {
    const clientId = await register(h);
    const page = await h.req({ path: `/authorize?${authorizeQuery(clientId, pkce().challenge)}` });
    const r = await h.req({ method: 'POST', path: '/authorize', headers: FORM, body: form({ txn: txnFrom(page.body), action: 'deny' }) });
    expect(r.status).toBe(302);
    expect(new URL(String(r.headers.location)).searchParams.get('error')).toBe('access_denied');
  });

  it('a POST from a foreign Origin is refused', async () => {
    const clientId = await register(h);
    const page = await h.req({ path: `/authorize?${authorizeQuery(clientId, pkce().challenge)}` });
    const r = await h.req({
      method: 'POST',
      path: '/authorize',
      headers: { ...FORM, Origin: 'https://evil.example' },
      body: form({ txn: txnFrom(page.body), password: PASSWORD, action: 'approve' }),
    });
    expect(r.status).toBe(403);
  });
});

describe('remote oauth: dynamic client registration', () => {
  it('rejects a non-https, non-loopback redirect URI', async () => {
    const r = await h.req({
      method: 'POST',
      path: '/register',
      headers: JSON_TYPE,
      body: JSON.stringify({ redirect_uris: ['http://example.com/cb'] }),
    });
    expect(r.status).toBe(400);
    expect(json(r.body).error).toBe('invalid_redirect_uri');
  });

  it('accepts a loopback redirect URI and forces a public client', async () => {
    const r = await h.req({
      method: 'POST',
      path: '/register',
      headers: JSON_TYPE,
      body: JSON.stringify({ redirect_uris: ['http://127.0.0.1:33418/callback'], token_endpoint_auth_method: 'client_secret_basic' }),
    });
    expect(r.status).toBe(201);
    const c = json(r.body);
    expect(c.token_endpoint_auth_method).toBe('none');
    expect(c.client_secret).toBeUndefined();
  });

  it('rejects a redirect URI with a fragment and a non-JSON body', async () => {
    const frag = await h.req({
      method: 'POST',
      path: '/register',
      headers: JSON_TYPE,
      body: JSON.stringify({ redirect_uris: ['https://client.example.com/cb#x'] }),
    });
    expect(frag.status).toBe(400);
    const notJson = await h.req({ method: 'POST', path: '/register', headers: FORM, body: 'a=b' });
    expect(notJson.status).toBe(400);
  });

  it('limits registrations per IP', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 21; i++) {
      const r = await h.req({ method: 'POST', path: '/register', headers: JSON_TYPE, body: JSON.stringify({ redirect_uris: [REDIRECT] }) });
      statuses.push(r.status);
    }
    expect(statuses.slice(0, 20).every((s) => s === 201)).toBe(true);
    expect(statuses[20]).toBe(429);
  });
});

describe('remote oauth: flood limits and resource binding', () => {
  it('unauthenticated GET /authorize is limited per IP', async () => {
    const clientId = await register(h);
    const q = authorizeQuery(clientId, pkce().challenge);
    const statuses: number[] = [];
    for (let i = 0; i < 61; i++) statuses.push((await h.req({ path: `/authorize?${q}` })).status);
    expect(statuses.slice(0, 60).every((s) => s === 200)).toBe(true);
    expect(statuses[60]).toBe(429);
  }, 30_000);

  it('a token whose stored resource is not the MCP URL gets 401', async () => {
    const clientId = await register(h);
    await h.server.close();
    resetMasterKeyCacheForTests();
    useMasterKey(Buffer.from(h.env.MULTIPLE_GMAIL_MASTER_KEY, 'base64'));
    const store = await RemoteStore.open();
    const t = await store.issueTokens({ clientId, resource: 'https://other.example/mcp', scope: 'mcp' });
    await store.flush();
    await h.restart();
    const r = await h.req({ method: 'POST', path: '/mcp', headers: { ...JSON_TYPE, Authorization: `Bearer ${t.accessToken}` }, body: '{}' });
    expect(r.status).toBe(401);
    expect(String(r.headers['www-authenticate'])).toContain('invalid_token');
  });
});
