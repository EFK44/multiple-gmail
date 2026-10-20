import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  OAuthError,
  OAuthErrorCode,
  oauthMetadataResponse,
  type AuthInfo,
  type AuthMetadataOptions,
  type OAuthMetadata,
  type OAuthTokenVerifier,
} from '@modelcontextprotocol/server';
import { readBody } from '../http/router.js';
import { clientIp, verifyPassword, type PasswordHash, type RateLimiter, type Semaphore } from './adminAuth.js';
import { digestHex, type RemoteStore } from './store.js';

// Minimal OAuth 2.1 authorization server for remote mode, with one resource (PUBLIC_URL/mcp) and one owner who signs
// in with the admin password. Public clients only (PKCE S256), dynamic client registration (RFC 7591), metadata
// (RFC 8414, RFC 9728), exact redirect URI matching, RFC 8707 resource binding and RFC 9207 `iss` in responses.

export const SCOPE = 'mcp';
const CODE_TTL_MS = 60 * 1000;
const TXN_TTL_MS = 10 * 60 * 1000;
const MAX_TXNS = 500;
const MAX_CODES = 100;
const MAX_FORM = 8 * 1024;
const MAX_REGISTER = 16 * 1024;
const MAX_REDIRECT_URIS = 10;
const MAX_URI_LEN = 2000;
const MAX_NAME = 100;
const MAX_STATE = 1024;
const VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;
const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;

export type OAuthServerOptions = {
  publicUrl: string;
  mcpUrl: string;
  store: RemoteStore;
  password: PasswordHash;
  loginLimiter: RateLimiter;
  registerLimiter: RateLimiter;
  // Unauthenticated page loads (GET /authorize) per IP, so a flood cannot evict the owner's pending request.
  pageLimiter: RateLimiter;
  verifySlots: Semaphore;
  trustProxy: boolean;
  allowInsecure: boolean;
  now?: () => number;
};

// ---------- small HTTP helpers (shared with the remote router) ----------

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    Pragma: 'no-cache',
    ...headers,
  });
  res.end(text);
}

// The page CSP: no scripts at all, the shared stylesheet only, forms only to us (plus, for the consent page, the
// client's redirect origin: browsers apply form-action to the redirect that follows the POST).
export function sendHtml(
  res: ServerResponse,
  status: number,
  title: string,
  body: string,
  opts: { formTargets?: string[]; headers?: Record<string, string> } = {},
): void {
  const formAction = ["'self'", ...(opts.formTargets ?? [])].join(' ');
  const html =
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<meta name="referrer" content="no-referrer"><title>${escapeHtml(title)}</title>` +
    `<link rel="stylesheet" href="/admin/style.css"></head><body><main>${body}</main></body></html>`;
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': `default-src 'none'; style-src 'self'; img-src 'self'; form-action ${formAction}; frame-ancestors 'none'; base-uri 'none'`,
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    ...(opts.headers ?? {}),
  });
  res.end(html);
}

export const isFormType = (v: string | undefined) => !!v && /^application\/x-www-form-urlencoded\s*(;|$)/i.test(v);
const isJsonType = (v: string | undefined) => !!v && /^application\/json\s*(;|$)/i.test(v);

// Parses a urlencoded body. Returns null for a wrong type, an oversized body, or a repeated parameter (RFC 6749 3.1).
export async function readForm(req: IncomingMessage, limit = MAX_FORM): Promise<Map<string, string> | null> {
  if (!isFormType(req.headers['content-type'])) return null;
  const body = await readBody(req, limit);
  if (body.kind !== 'ok') return null;
  const params = new URLSearchParams(body.text);
  const out = new Map<string, string>();
  for (const [k, v] of params) {
    if (out.has(k)) return null;
    out.set(k, v);
  }
  return out;
}

const sha256b64url = (s: string) => createHash('sha256').update(s, 'ascii').digest('base64url');

function safeEqualStr(a: string, b: string): boolean {
  const da = createHash('sha256').update(a).digest();
  const db = createHash('sha256').update(b).digest();
  return timingSafeEqual(da, db) && a.length === b.length;
}

// Accepted redirect URIs: https anywhere, or http on a loopback host (native apps, RFC 8252). No fragment, no
// credentials, no other schemes.
export function validRedirectUri(raw: unknown): raw is string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_URI_LEN) return false;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.hash || raw.includes('#') || u.username || u.password) return false;
  if (u.protocol === 'https:') return true;
  if (u.protocol === 'http:') return u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
  return false;
}

// ---------- the server ----------

type Txn = {
  clientId: string;
  redirectUri: string;
  state?: string;
  codeChallenge: string;
  resource: string;
  scope: string;
  exp: number;
};

type CodeRec = Omit<Txn, 'state' | 'exp'> & { exp: number };

export function createOAuthServer(o: OAuthServerOptions) {
  const now = o.now ?? Date.now;
  const issuer = o.publicUrl;
  const txns = new Map<string, Txn>();
  const codes = new Map<string, CodeRec>();
  // Codes already redeemed (digest -> token family), kept until the code would have expired, so a replay revokes
  // what the first redemption issued (OAuth 2.1 section 4.1.3).
  const redeemed = new Map<string, { family: string; exp: number }>();

  const oauthMetadata: OAuthMetadata = {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    registration_endpoint: `${issuer}/register`,
    revocation_endpoint: `${issuer}/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [SCOPE],
    authorization_response_iss_parameter_supported: true,
  };
  const metadataOptions: AuthMetadataOptions = {
    oauthMetadata,
    resourceServerUrl: new URL(o.mcpUrl),
    scopesSupported: [SCOPE],
    resourceName: 'multiple-gmail',
    dangerouslyAllowInsecureIssuerUrl: o.allowInsecure,
  };

  const prune = () => {
    const t = now();
    for (const [k, v] of txns) if (v.exp <= t) txns.delete(k);
    for (const [k, v] of codes) if (v.exp <= t) codes.delete(k);
    for (const [k, v] of redeemed) if (v.exp <= t) redeemed.delete(k);
  };
  const capped = <V>(m: Map<string, V>, cap: number) => {
    while (m.size >= cap) {
      const k = m.keys().next().value;
      if (k === undefined) break;
      m.delete(k);
    }
  };

  const verifier: OAuthTokenVerifier = {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      const rec = o.store.verifyAccess(token);
      if (!rec) throw new OAuthError(OAuthErrorCode.InvalidToken, 'Invalid or expired access token');
      return {
        token,
        clientId: rec.clientId,
        scopes: rec.scope.split(' ').filter(Boolean),
        expiresAt: Math.floor(rec.exp / 1000),
        resource: new URL(rec.resource),
      };
    },
  };

  // ----- metadata -----

  async function metadata(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    // The root form is served too: some clients probe it before the path-aware one.
    const target = path === '/.well-known/oauth-protected-resource' ? '/.well-known/oauth-protected-resource/mcp' : path;
    const request = new Request(`${issuer}${target}`, { method: req.method ?? 'GET', headers: { origin: req.headers.origin ?? '' } });
    const r = oauthMetadataResponse(request, metadataOptions);
    if (!r) return sendJson(res, 404, { error: 'not_found' });
    const headers: Record<string, string> = {};
    r.headers.forEach((v, k) => (headers[k] = v));
    res.writeHead(r.status, headers);
    res.end(req.method === 'HEAD' ? undefined : Buffer.from(await r.arrayBuffer()));
  }

  // ----- registration (RFC 7591) -----

  async function register(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const cors = { 'Access-Control-Allow-Origin': '*' };
    const ip = clientIp(req, o.trustProxy);
    if (o.registerLimiter.blocked(ip)) {
      return sendJson(res, 429, { error: 'too_many_requests' }, { ...cors, 'Retry-After': String(o.registerLimiter.retryAfter(ip)) });
    }
    const bad = (error: string, description: string) => sendJson(res, 400, { error, error_description: description }, cors);
    if (!isJsonType(req.headers['content-type'])) return bad('invalid_client_metadata', 'Content-Type must be application/json.');
    const body = await readBody(req, MAX_REGISTER);
    if (body.kind !== 'ok') return bad('invalid_client_metadata', 'Request body too large.');
    let meta: Record<string, unknown>;
    try {
      const v: unknown = JSON.parse(body.text);
      if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error();
      meta = v as Record<string, unknown>;
    } catch {
      return bad('invalid_client_metadata', 'Body must be a JSON object.');
    }
    const uris = meta.redirect_uris;
    if (!Array.isArray(uris) || uris.length === 0 || uris.length > MAX_REDIRECT_URIS) {
      return bad('invalid_redirect_uri', `redirect_uris must list 1 to ${MAX_REDIRECT_URIS} URIs.`);
    }
    if (!uris.every(validRedirectUri)) {
      return bad('invalid_redirect_uri', 'Each redirect URI must be https, or http on localhost or 127.0.0.1, without a fragment.');
    }
    const grants = meta.grant_types;
    if (grants !== undefined && (!Array.isArray(grants) || !grants.every((g) => g === 'authorization_code' || g === 'refresh_token'))) {
      return bad('invalid_client_metadata', 'Only the authorization_code and refresh_token grant types are supported.');
    }
    const responses = meta.response_types;
    if (responses !== undefined && (!Array.isArray(responses) || !responses.every((r) => r === 'code'))) {
      return bad('invalid_client_metadata', 'Only the code response type is supported.');
    }
    const rawName = meta.client_name;
    const clientName =
      typeof rawName === 'string' ? rawName.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_NAME) : undefined;
    o.registerLimiter.record(ip);
    const rec = await o.store.registerClient({ clientName: clientName || undefined, redirectUris: uris as string[] });
    if (!rec) {
      return bad('invalid_client_metadata', 'Too many registered clients. Delete remote-tokens.enc on the server to reset all clients.');
    }
    // Public client: whatever auth method was asked for, the answer is "none" and no secret is issued.
    return sendJson(
      res,
      201,
      {
        client_id: rec.clientId,
        client_id_issued_at: rec.createdAt,
        redirect_uris: rec.redirectUris,
        ...(rec.clientName ? { client_name: rec.clientName } : {}),
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      },
      cors,
    );
  }

  // ----- authorization endpoint -----

  function redirectWith(res: ServerResponse, redirectUri: string, params: Record<string, string | undefined>): void {
    const u = new URL(redirectUri);
    for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
    u.searchParams.set('iss', issuer);
    res.writeHead(302, { Location: u.href, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    res.end();
  }

  function invalidRequestPage(res: ServerResponse, why: string): void {
    sendHtml(
      res,
      400,
      'Invalid sign-in request',
      `<h1>Invalid sign-in request</h1><p>${escapeHtml(why)}</p><p>Nothing was shared. Start the connection again from your AI app.</p>`,
    );
  }

  function consentPage(res: ServerResponse, status: number, txnId: string, t: Txn, error?: string): void {
    const client = o.store.getClient(t.clientId);
    const name = client?.clientName ?? 'An unnamed app';
    const target = new URL(t.redirectUri);
    const body =
      `<h1>Allow access to your Gmail accounts?</h1>` +
      `<p><strong>${escapeHtml(name)}</strong> wants to use multiple-gmail on this server. It will be able to read, ` +
      `label and draft mail and, with your approval in the chat, send mail in all connected accounts.</p>` +
      `<p>After you allow it, you are sent back to <strong>${escapeHtml(target.host)}</strong>. ` +
      `If you did not start this, choose Deny.</p>` +
      (error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : '') +
      `<form method="post" action="/authorize">` +
      `<input type="hidden" name="txn" value="${escapeHtml(txnId)}">` +
      `<label for="password">Admin password</label>` +
      `<input id="password" name="password" type="password" autocomplete="current-password" autofocus>` +
      `<div class="actions"><button type="submit" name="action" value="approve">Allow</button>` +
      `<button type="submit" name="action" value="deny" class="secondary">Deny</button></div>` +
      `</form>`;
    sendHtml(res, status, 'Allow access', body, { formTargets: [target.origin] });
  }

  async function authorizeGet(res: ServerResponse, q: URLSearchParams): Promise<void> {
    for (const k of new Set(q.keys())) {
      if (q.getAll(k).length > 1) return invalidRequestPage(res, `The parameter ${k} is repeated.`);
    }
    const clientId = q.get('client_id') ?? '';
    const client = clientId ? o.store.getClient(clientId) : undefined;
    if (!client) return invalidRequestPage(res, 'This app is not registered with this server.');
    const redirectUri = q.get('redirect_uri') ?? '';
    // Exact string match against a registered URI; anything else is answered here, never by redirecting.
    if (!client.redirectUris.includes(redirectUri)) return invalidRequestPage(res, 'The return address of this app is not registered.');

    const state = q.get('state') ?? undefined;
    if (state !== undefined && state.length > MAX_STATE) return invalidRequestPage(res, 'The state parameter is too long.');
    const fail = (error: string, description: string) => redirectWith(res, redirectUri, { error, error_description: description, state });
    if (q.get('response_type') !== 'code') return fail('unsupported_response_type', 'Only response_type=code is supported.');
    const challenge = q.get('code_challenge') ?? '';
    if (q.get('code_challenge_method') !== 'S256' || !CHALLENGE_RE.test(challenge)) {
      return fail('invalid_request', 'PKCE with code_challenge_method=S256 is required.');
    }
    const resource = q.get('resource') ?? o.mcpUrl;
    if (resource !== o.mcpUrl) return fail('invalid_target', `The only resource on this server is ${o.mcpUrl}.`);

    prune();
    capped(txns, MAX_TXNS);
    const txnId = randomBytes(32).toString('base64url');
    const txn: Txn = { clientId, redirectUri, state, codeChallenge: challenge, resource, scope: SCOPE, exp: now() + TXN_TTL_MS };
    txns.set(txnId, txn);
    consentPage(res, 200, txnId, txn);
  }

  async function authorizePost(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== 'null' && origin !== issuer) {
      return sendHtml(res, 403, 'Forbidden', '<h1>Forbidden</h1><p>This form can only be sent from this server.</p>');
    }
    const f = await readForm(req);
    if (!f) return invalidRequestPage(res, 'The form could not be read.');
    prune();
    const txnId = f.get('txn') ?? '';
    const txn = txns.get(txnId);
    if (!txn) return invalidRequestPage(res, 'This sign-in page has expired. Start the connection again from your AI app.');

    if (f.get('action') === 'deny') {
      txns.delete(txnId);
      return redirectWith(res, txn.redirectUri, { error: 'access_denied', error_description: 'The owner denied access.', state: txn.state });
    }

    const ip = clientIp(req, o.trustProxy);
    if (o.loginLimiter.blocked(ip)) {
      const wait = o.loginLimiter.retryAfter(ip);
      return sendHtml(
        res,
        429,
        'Too many attempts',
        `<h1>Too many attempts</h1><p>Too many wrong passwords. Try again in ${Math.ceil(wait / 60)} minutes.</p>`,
        { headers: { 'Retry-After': String(wait) } },
      );
    }
    const release = o.verifySlots.tryAcquire();
    if (!release) return sendHtml(res, 503, 'Busy', '<h1>Busy</h1><p>The server is busy. Try again in a moment.</p>', { headers: { 'Retry-After': '5' } });
    let ok: boolean;
    try {
      ok = await verifyPassword(f.get('password') ?? '', o.password);
    } finally {
      release();
    }
    if (!ok) {
      o.loginLimiter.record(ip);
      return consentPage(res, 401, txnId, txn, 'Wrong password.');
    }
    txns.delete(txnId);
    capped(codes, MAX_CODES);
    const code = randomBytes(32).toString('base64url');
    codes.set(digestHex(code), {
      clientId: txn.clientId,
      redirectUri: txn.redirectUri,
      codeChallenge: txn.codeChallenge,
      resource: txn.resource,
      scope: txn.scope,
      exp: now() + CODE_TTL_MS,
    });
    redirectWith(res, txn.redirectUri, { code, state: txn.state });
  }

  // ----- token endpoint -----

  // client_id from the form, or from HTTP Basic for clients that always send it there (the secret is ignored:
  // there are no confidential clients).
  function clientIdOf(req: IncomingMessage, f: Map<string, string>): string {
    const fromForm = f.get('client_id');
    if (fromForm) return fromForm;
    const m = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(req.headers.authorization ?? '');
    if (!m) return '';
    const decoded = Buffer.from(m[1], 'base64').toString('utf8');
    const i = decoded.indexOf(':');
    try {
      return decodeURIComponent(i >= 0 ? decoded.slice(0, i) : decoded);
    } catch {
      return '';
    }
  }

  async function token(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const cors = { 'Access-Control-Allow-Origin': '*' };
    const err = (status: number, error: string, description: string) =>
      sendJson(res, status, { error, error_description: description }, cors);
    const f = await readForm(req);
    if (!f) return err(400, 'invalid_request', 'Expected an application/x-www-form-urlencoded body without repeated parameters.');
    const grant = f.get('grant_type');
    const clientId = clientIdOf(req, f);
    const issued = (t: { accessToken: string; refreshToken: string; expiresIn: number; scope: string }) =>
      sendJson(
        res,
        200,
        { access_token: t.accessToken, token_type: 'Bearer', expires_in: t.expiresIn, refresh_token: t.refreshToken, scope: t.scope },
        cors,
      );

    if (grant === 'authorization_code') {
      prune();
      const code = f.get('code') ?? '';
      const key = digestHex(code);
      const rec = codes.get(key);
      if (!rec) {
        const replay = redeemed.get(key);
        if (replay) {
          redeemed.delete(key);
          await o.store.revokeFamily(replay.family);
        }
        return err(400, 'invalid_grant', 'The code is invalid, expired, or already used.');
      }
      // Single use, whatever the outcome below.
      codes.delete(key);
      if (!clientId || !o.store.getClient(clientId) || clientId !== rec.clientId) {
        return err(400, 'invalid_grant', 'The code was issued to another client.');
      }
      if (f.get('redirect_uri') !== rec.redirectUri) return err(400, 'invalid_grant', 'redirect_uri does not match the authorization request.');
      const verifierStr = f.get('code_verifier') ?? '';
      if (!VERIFIER_RE.test(verifierStr) || !safeEqualStr(sha256b64url(verifierStr), rec.codeChallenge)) {
        return err(400, 'invalid_grant', 'code_verifier does not match the code_challenge.');
      }
      const resource = f.get('resource');
      if (resource !== undefined && resource !== rec.resource) return err(400, 'invalid_target', 'resource does not match the authorization request.');
      const tokens = await o.store.issueTokens({ clientId: rec.clientId, resource: rec.resource, scope: rec.scope });
      redeemed.set(key, { family: tokens.family, exp: now() + CODE_TTL_MS });
      return issued(tokens);
    }

    if (grant === 'refresh_token') {
      const refresh = f.get('refresh_token') ?? '';
      if (!refresh || !clientId) return err(400, 'invalid_request', 'refresh_token and client_id are required.');
      const resource = f.get('resource');
      if (resource !== undefined && resource !== o.mcpUrl) return err(400, 'invalid_target', `The only resource on this server is ${o.mcpUrl}.`);
      const r = await o.store.rotateRefresh(refresh, clientId);
      if (r.kind !== 'ok') return err(400, 'invalid_grant', 'The refresh token is invalid, expired, or revoked.');
      return issued(r.tokens);
    }

    return err(400, 'unsupported_grant_type', 'Supported grant types: authorization_code, refresh_token.');
  }

  // ----- revocation (RFC 7009): always 200, revokes the whole token family -----

  async function revoke(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const cors = { 'Access-Control-Allow-Origin': '*' };
    const f = await readForm(req);
    if (!f) return sendJson(res, 400, { error: 'invalid_request' }, cors);
    await o.store.revokeToken(f.get('token') ?? '');
    res.writeHead(200, { 'Cache-Control': 'no-store', ...cors });
    res.end();
  }

  function preflight(res: ServerResponse): void {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '600',
    });
    res.end();
  }

  // Returns false when the path is not an OAuth route.
  async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const path = url.pathname;
    const method = req.method ?? 'GET';
    if (path.startsWith('/.well-known/oauth-')) {
      await metadata(req, res, path.replace(/\/$/, ''));
      return true;
    }
    if (path === '/register' || path === '/token' || path === '/revoke') {
      if (method === 'OPTIONS') return preflight(res), true;
      if (method !== 'POST') return sendJson(res, 405, { error: 'invalid_request' }, { Allow: 'POST, OPTIONS' }), true;
      if (path === '/register') await register(req, res);
      else if (path === '/token') await token(req, res);
      else await revoke(req, res);
      return true;
    }
    if (path === '/authorize') {
      if (method === 'GET') {
        const ip = clientIp(req, o.trustProxy);
        if (o.pageLimiter.blocked(ip)) {
          sendHtml(res, 429, 'Too many requests', '<h1>Too many requests</h1><p>Try again later.</p>', {
            headers: { 'Retry-After': String(o.pageLimiter.retryAfter(ip)) },
          });
          return true;
        }
        o.pageLimiter.record(ip);
        await authorizeGet(res, url.searchParams);
      }
      else if (method === 'POST') await authorizePost(req, res);
      else sendJson(res, 405, { error: 'invalid_request' }, { Allow: 'GET, POST' });
      return true;
    }
    return false;
  }

  return { handle, verifier, oauthMetadata };
}
