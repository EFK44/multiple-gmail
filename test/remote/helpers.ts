import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetMasterKeyCacheForTests } from '../../src/core/masterKey.js';
import { hashPassword } from '../../src/remote/adminAuth.js';
import { createRemoteServer, type RemoteServer, type RemoteServerDeps } from '../../src/modes/remote.js';
import { raw, type RawResponse } from '../http/helpers.js';

export const PASSWORD = 'correct horse battery staple';
export const PUBLIC = 'http://localhost';
export const MCP_URL = `${PUBLIC}/mcp`;
export const REDIRECT = 'https://client.example.com/cb';

let cachedHash: string | undefined;
export async function passwordHash(): Promise<string> {
  cachedHash ??= await hashPassword(PASSWORD);
  return cachedHash;
}

export type Harness = {
  env: Record<string, string>;
  server: RemoteServer;
  req: (opts: { method?: string; path?: string; headers?: Record<string, string>; body?: string }) => Promise<RawResponse>;
  restart: () => Promise<void>;
  close: () => Promise<void>;
};

export async function baseEnv(dir: string): Promise<Record<string, string>> {
  return {
    PUBLIC_URL: PUBLIC,
    MULTIPLE_GMAIL_ALLOW_INSECURE: '1',
    PORT: '0',
    HOST: '127.0.0.1',
    MULTIPLE_GMAIL_MASTER_KEY: randomBytes(32).toString('base64'),
    ADMIN_PASSWORD_HASH: await passwordHash(),
    MULTIPLE_GMAIL_HOME: join(dir, 'home'),
  };
}

export async function startHarness(deps: RemoteServerDeps = {}): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'mg-remote-'));
  const prevHome = process.env.MULTIPLE_GMAIL_HOME;
  const env = await baseEnv(dir);
  process.env.MULTIPLE_GMAIL_HOME = env.MULTIPLE_GMAIL_HOME;
  resetMasterKeyCacheForTests();
  const start = () => createRemoteServer({ env, deps: { log: () => {}, logError: () => {}, ...deps } });
  const h: Harness = {
    env,
    server: await start(),
    req: (opts) =>
      raw(h.server.port, { ...opts, headers: { Host: `localhost:${h.server.port}`, ...(opts.headers ?? {}) } }),
    restart: async () => {
      await h.server.close();
      resetMasterKeyCacheForTests();
      h.server = await start();
    },
    close: async () => {
      await h.server.close();
      resetMasterKeyCacheForTests();
      if (prevHome === undefined) delete process.env.MULTIPLE_GMAIL_HOME;
      else process.env.MULTIPLE_GMAIL_HOME = prevHome;
      await rm(dir, { recursive: true, force: true });
    },
  };
  return h;
}

export const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
export const FORM = { 'Content-Type': 'application/x-www-form-urlencoded' };
export const JSON_TYPE = { 'Content-Type': 'application/json' };

export function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

export async function register(h: Harness, body: Record<string, unknown> = {}): Promise<string> {
  const r = await h.req({
    method: 'POST',
    path: '/register',
    headers: JSON_TYPE,
    body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: 'Test client', ...body }),
  });
  if (r.status !== 201) throw new Error(`register failed: ${r.status} ${r.body}`);
  return (JSON.parse(r.body) as { client_id: string }).client_id;
}

export function authorizeQuery(clientId: string, challenge: string, extra: Record<string, string> = {}): string {
  return new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'st-123',
    resource: MCP_URL,
    ...extra,
  }).toString();
}

export function txnFrom(html: string): string {
  const m = /name="txn" value="([^"]+)"/.exec(html);
  if (!m) throw new Error('no txn in page');
  return m[1];
}

// Register, authorize with the password, and return the code plus the PKCE verifier.
export async function getCode(h: Harness): Promise<{ clientId: string; code: string; verifier: string }> {
  const clientId = await register(h);
  const { verifier, challenge } = pkce();
  const page = await h.req({ path: `/authorize?${authorizeQuery(clientId, challenge)}` });
  if (page.status !== 200) throw new Error(`authorize page ${page.status}: ${page.body}`);
  const r = await h.req({
    method: 'POST',
    path: '/authorize',
    headers: FORM,
    body: form({ txn: txnFrom(page.body), password: PASSWORD, action: 'approve' }),
  });
  if (r.status !== 302) throw new Error(`authorize post ${r.status}: ${r.body}`);
  const loc = new URL(String(r.headers.location));
  return { clientId, code: loc.searchParams.get('code') ?? '', verifier };
}

export async function exchange(h: Harness, c: { clientId: string; code: string; verifier: string }) {
  return h.req({
    method: 'POST',
    path: '/token',
    headers: FORM,
    body: form({
      grant_type: 'authorization_code',
      code: c.code,
      redirect_uri: REDIRECT,
      client_id: c.clientId,
      code_verifier: c.verifier,
      resource: MCP_URL,
    }),
  });
}
