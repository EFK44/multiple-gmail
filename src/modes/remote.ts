import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { hostHeaderValidation, toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, getOAuthProtectedResourceMetadataUrl, requireBearerAuth } from '@modelcontextprotocol/server';
import { createWebAuth, type LoopbackDeps } from '../core/googleAuth.js';
import { keyFromEnv, useMasterKey } from '../core/masterKey.js';
import { createApi } from '../http/api.js';
import { CSP, MAX_JSON_BODY, readBody } from '../http/router.js';
import { readStatic } from '../http/static.js';
import { buildMcpServer } from '../mcp/buildServer.js';
import {
  AdminSessions,
  FAILURE_WINDOW_MS,
  MAX_FAILURES,
  RateLimiter,
  Semaphore,
  clientIp,
  parsePasswordHash,
  verifyPassword,
  type PasswordHash,
} from '../remote/adminAuth.js';
import { SCOPE, createOAuthServer, escapeHtml, readForm, sendHtml, sendJson } from '../remote/oauthServer.js';
import { RemoteStore } from '../remote/store.js';
import { VERSION } from '../version.js';

// Server mode (`serve --remote`, Docker): plain HTTP on HOST:PORT behind a TLS reverse proxy. Everything here is only
// reachable through this module, so the local mode is unchanged by it.

export class RemoteConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RemoteConfigError';
  }
}

export type RemoteConfig = {
  publicUrl: string;
  mcpUrl: string;
  googleRedirectUri: string;
  host: string;
  port: number;
  masterKey: Buffer;
  password: PasswordHash;
  trustProxy: boolean;
  allowInsecure: boolean;
  home: string;
};

type Env = Record<string, string | undefined>;

export function parseRemoteEnv(env: Env): RemoteConfig {
  const allowInsecure = env.MULTIPLE_GMAIL_ALLOW_INSECURE === '1';
  const rawUrl = env.PUBLIC_URL?.trim();
  if (!rawUrl) {
    throw new RemoteConfigError('PUBLIC_URL is not set. Set it to the https address of this server, for example https://mail.example.com');
  }
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new RemoteConfigError(`PUBLIC_URL is not a valid URL: ${rawUrl}`);
  }
  const insecureLocal = allowInsecure && u.protocol === 'http:' && u.hostname === 'localhost';
  if (u.protocol !== 'https:' && !insecureLocal) {
    throw new RemoteConfigError('PUBLIC_URL must start with https:// (put a TLS reverse proxy such as Caddy in front of this server).');
  }
  if ((u.pathname !== '/' && u.pathname !== '') || u.search || u.hash || u.username || u.password) {
    throw new RemoteConfigError('PUBLIC_URL must be only scheme and host (and port), without a path, query or fragment.');
  }
  const publicUrl = u.origin;

  const hashValue = env.ADMIN_PASSWORD_HASH?.trim();
  if (!hashValue) {
    throw new RemoteConfigError('ADMIN_PASSWORD_HASH is not set. Create one with: multiple-gmail hash-password');
  }
  let password: PasswordHash;
  try {
    password = parsePasswordHash(hashValue);
  } catch (e) {
    throw new RemoteConfigError((e as Error).message);
  }

  let masterKey: Buffer;
  try {
    masterKey = keyFromEnv(env.MULTIPLE_GMAIL_MASTER_KEY);
  } catch (e) {
    throw new RemoteConfigError((e as Error).message);
  }

  const portRaw = env.PORT?.trim() || '8080';
  if (!/^\d{1,5}$/.test(portRaw) || Number(portRaw) > 65535) throw new RemoteConfigError(`PORT must be a number from 0 to 65535, got: ${portRaw}`);

  return {
    publicUrl,
    mcpUrl: `${publicUrl}/mcp`,
    googleRedirectUri: `${publicUrl}/oauth/google/callback`,
    host: env.HOST?.trim() || '0.0.0.0',
    port: Number(portRaw),
    masterKey,
    password,
    trustProxy: env.TRUST_PROXY === '1',
    allowInsecure,
    home: env.MULTIPLE_GMAIL_HOME?.trim() || '/data',
  };
}

export type RemoteServerDeps = {
  log?: (s: string) => void;
  logError?: (s: string) => void;
  // Google sign-in dependencies (tests stub the token exchange).
  google?: LoopbackDeps;
  now?: () => number;
};

export type RemoteServer = { port: number; close(): Promise<void> };

const LOGIN_CSS = `body{font-family:system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;line-height:1.5;color:#1d1d1f;background:#fafafa}
h1{font-size:1.4rem}label{display:block;margin:1rem 0 .25rem;font-weight:600}
input[type=password]{width:100%;box-sizing:border-box;padding:.6rem;font-size:1rem;border:1px solid #888;border-radius:.4rem}
.actions{display:flex;gap:.5rem;margin-top:1rem}button{padding:.6rem 1.2rem;font-size:1rem;border-radius:.4rem;border:1px solid #1a56db;background:#1a56db;color:#fff;cursor:pointer}
button.secondary{background:transparent;color:#1a56db}.error{color:#b00020;font-weight:600}
@media (prefers-color-scheme:dark){body{background:#1c1c1e;color:#f2f2f7}input[type=password]{background:#2c2c2e;color:#f2f2f7}button.secondary{color:#8ab4ff;border-color:#8ab4ff}.error{color:#ff8a80}}`;

function writeWebResponse(res: ServerResponse, r: Response, body: Buffer): void {
  const headers: Record<string, string> = {};
  r.headers.forEach((v, k) => (headers[k] = v));
  res.writeHead(r.status, headers);
  res.end(body);
}

export async function createRemoteServer(opts: { env: Env; deps?: RemoteServerDeps }): Promise<RemoteServer> {
  const cfg = parseRemoteEnv(opts.env);
  const deps = opts.deps ?? {};
  const log = deps.log ?? ((s: string) => console.log(s));
  const logError = deps.logError ?? ((s: string) => console.error(s));
  const now = deps.now ?? Date.now;

  // Data dir and master key come from the environment in remote mode, on every platform.
  process.env.MULTIPLE_GMAIL_HOME = cfg.home;
  useMasterKey(cfg.masterKey);

  const store = await RemoteStore.open(now);
  const loginLimiter = new RateLimiter(MAX_FAILURES, FAILURE_WINDOW_MS, now);
  // Shared by both password forms (OAuth consent and admin login).
  const verifySlots = new Semaphore(4);
  const oauth = createOAuthServer({
    publicUrl: cfg.publicUrl,
    mcpUrl: cfg.mcpUrl,
    store,
    password: cfg.password,
    loginLimiter,
    registerLimiter: new RateLimiter(20, 60 * 60 * 1000, now),
    verifySlots,
    trustProxy: cfg.trustProxy,
    allowInsecure: cfg.allowInsecure,
    now,
  });
  const admin = new AdminSessions(now);
  const webAuth = createWebAuth({ redirectUri: cfg.googleRedirectUri, deps: deps.google });
  const api = createApi({
    startLoopbackAuth: webAuth.startWebAuth,
    remote: { mcpUrl: cfg.mcpUrl, googleRedirectUri: cfg.googleRedirectUri },
  });

  const mcpUrl = new URL(cfg.mcpUrl);
  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(mcpUrl);
  const gate = requireBearerAuth({ verifier: oauth.verifier, expectedResource: mcpUrl, resourceMetadataUrl, requiredScopes: [SCOPE] });
  const mcpHandler = createMcpHandler(() => buildMcpServer(), { onerror: (e) => logError(`multiple-gmail mcp error: ${e.message}`) });
  const mcpNode = toNodeHandler(mcpHandler, { onerror: (e) => logError(`multiple-gmail mcp error: ${e.message}`) });

  const validateHost = hostHeaderValidation([new URL(cfg.publicUrl).hostname]);
  const https = cfg.publicUrl.startsWith('https:');

  function baseHeaders(res: ServerResponse): void {
    if (https) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
  }

  function loginPage(res: ServerResponse, status: number, error?: string, headers: Record<string, string> = {}): void {
    const body =
      `<h1>multiple-gmail</h1><p>Sign in with the admin password to manage this server.</p>` +
      (error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : '') +
      `<form method="post" action="/admin/login">` +
      `<input type="hidden" name="csrf" value="${escapeHtml(admin.createCsrf())}">` +
      `<label for="password">Admin password</label>` +
      `<input id="password" name="password" type="password" autocomplete="current-password" autofocus required>` +
      `<div class="actions"><button type="submit">Sign in</button></div></form>`;
    sendHtml(res, status, 'Sign in', body, { headers });
  }

  const foreignOrigin = (req: IncomingMessage) => {
    const o = req.headers.origin;
    return o !== undefined && o !== cfg.publicUrl;
  };

  async function adminLogin(req: IncomingMessage, res: ServerResponse, method: string): Promise<void> {
    if (method === 'GET' || method === 'HEAD') {
      if (admin.has(req.headers.cookie)) {
        res.writeHead(302, { Location: '/', 'Cache-Control': 'no-store' });
        return void res.end();
      }
      return loginPage(res, 200);
    }
    if (method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed.' });
    if (foreignOrigin(req)) return sendHtml(res, 403, 'Forbidden', '<h1>Forbidden</h1>');
    const f = await readForm(req, 4096);
    if (!f || !admin.consumeCsrf(f.get('csrf') ?? '')) {
      return sendHtml(res, 403, 'Expired', '<h1>This page expired</h1><p><a href="/admin/login">Open the sign-in page again.</a></p>');
    }
    const ip = clientIp(req, cfg.trustProxy);
    if (loginLimiter.blocked(ip)) {
      const wait = loginLimiter.retryAfter(ip);
      return loginPage(res, 429, `Too many wrong passwords. Try again in ${Math.ceil(wait / 60)} minutes.`, { 'Retry-After': String(wait) });
    }
    const release = verifySlots.tryAcquire();
    if (!release) return loginPage(res, 503, 'The server is busy. Try again in a moment.', { 'Retry-After': '5' });
    let ok: boolean;
    try {
      ok = await verifyPassword(f.get('password') ?? '', cfg.password);
    } finally {
      release();
    }
    if (!ok) {
      loginLimiter.record(ip);
      return loginPage(res, 401, 'Wrong password.');
    }
    res.writeHead(303, { Location: '/', 'Set-Cookie': admin.create().cookies, 'Cache-Control': 'no-store' });
    res.end();
  }

  async function serveMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const auth = await gate(new Request(cfg.mcpUrl, { headers: { authorization: req.headers.authorization ?? '' } }));
    if (auth instanceof Response) {
      return writeWebResponse(res, auth, Buffer.from(await auth.arrayBuffer()));
    }
    // toNodeHandler forwards req.auth to the handler as authInfo.
    (req as IncomingMessage & { auth?: typeof auth }).auth = auth;
    await mcpNode(req, res);
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', cfg.publicUrl);
    const path = url.pathname;
    const method = req.method ?? 'GET';
    // Container health checks call this by IP, so it skips the Host check; it reveals nothing but the version.
    if (path === '/health' && method === 'GET') return sendJson(res, 200, { app: 'multiple-gmail', version: VERSION });
    if (!validateHost(req, res)) return;
    baseHeaders(res);

    if (path === '/mcp') return serveMcp(req, res);
    if (await oauth.handle(req, res, url)) return;

    if (path === '/admin/style.css') {
      res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-cache' });
      return void res.end(method === 'HEAD' ? undefined : LOGIN_CSS);
    }
    if (path === '/admin/login') return adminLogin(req, res, method);
    if (path === '/admin/logout') {
      if (method !== 'POST' || foreignOrigin(req)) return sendJson(res, 405, { error: 'Method not allowed.' });
      res.writeHead(303, { Location: '/admin/login', 'Set-Cookie': admin.destroy(req.headers.cookie), 'Cache-Control': 'no-store' });
      return void res.end();
    }

    if (path === '/oauth/google/callback') {
      if (method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed.' });
      // Only the admin's browser may complete a Google sign-in (state + PKCE are checked by the flow itself).
      if (!admin.hasCallback(req.headers.cookie)) {
        return sendHtml(res, 401, 'Sign in first', '<h1>Sign in first</h1><p><a href="/admin/login">Sign in</a> and start the account connection again.</p>');
      }
      return webAuth.handleCallback(url.searchParams, res);
    }

    if (path === '/api' || path.startsWith('/api/')) {
      res.setHeader('Cache-Control', 'no-store');
      if (!admin.has(req.headers.cookie)) return sendJson(res, 401, { error: 'Not signed in.', login: '/admin/login' });
      const origin = req.headers.origin;
      if (method !== 'GET' && method !== 'HEAD' && origin !== cfg.publicUrl) return sendJson(res, 403, { error: 'Forbidden.' });
      const sameOrigin = origin !== undefined ? origin === cfg.publicUrl : req.headers['sec-fetch-site'] === 'same-origin';
      const body = await readBody(req, MAX_JSON_BODY);
      if (body.kind === 'too_large') return sendJson(res, 413, { error: 'Request body too large.' }, { Connection: 'close' });
      if (body.text.length > 0 && !/^application\/json\s*(;|$)/i.test(req.headers['content-type'] ?? '')) {
        return sendJson(res, 415, { error: 'Content-Type must be application/json.' });
      }
      const out = await api({ method, path: path.slice(4), body: body.text, sameOrigin });
      return sendJson(res, out.status, out.json);
    }

    if (method !== 'GET' && method !== 'HEAD') return sendJson(res, 404, { error: 'Not found.' });
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cache-Control', 'no-store');
    if (!admin.has(req.headers.cookie)) {
      res.writeHead(302, { Location: '/admin/login' });
      return void res.end();
    }
    const file = await readStatic(path);
    if (!file) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return void res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': file.type, 'Content-Length': String(file.body.length) });
    res.end(method === 'HEAD' ? undefined : file.body);
  }

  const server = createServer((req, res) => {
    route(req, res).catch((e: unknown) => {
      logError(`multiple-gmail http error: ${e instanceof Error ? e.message : String(e)}`);
      if (!res.headersSent) sendJson(res, 500, { error: 'Internal error.' });
      else res.destroy();
    });
  });
  // Bounds slow clients.
  server.requestTimeout = 60_000;
  server.headersTimeout = 20_000;

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(cfg.port, cfg.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;
  server.on('error', (e) => logError(`multiple-gmail http error: ${e.message}`));
  log(`multiple-gmail ${VERSION} remote mode`);
  log(`Listening on ${cfg.host}:${port}. Public URL: ${cfg.publicUrl}`);
  log(`MCP endpoint (add this as a custom connector): ${cfg.mcpUrl}`);
  log(`Setup: ${cfg.publicUrl}/admin/login`);

  let closing: Promise<void> | undefined;
  return {
    port,
    close: () =>
      (closing ??= (async () => {
        await mcpHandler.close().catch(() => {});
        await new Promise<void>((r) => {
          server.close(() => r());
          server.closeAllConnections();
        });
        await store.flush();
      })()),
  };
}

// CLI entry for `serve --remote`.
export async function runRemoteMode(
  env: Env,
  io: { error: (s: string) => void },
  deps: RemoteServerDeps = {},
): Promise<number> {
  let srv: RemoteServer;
  try {
    srv = await createRemoteServer({ env, deps });
  } catch (e) {
    if (e instanceof RemoteConfigError) {
      io.error(e.message);
      return 1;
    }
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EADDRINUSE' || code === 'EACCES') {
      io.error(`Cannot listen on ${env.HOST || '0.0.0.0'}:${env.PORT || '8080'} (${code}). Change PORT or HOST.`);
      return 1;
    }
    throw e;
  }
  const stop = () => void srv.close().finally(() => process.exit(0));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return 0;
}
