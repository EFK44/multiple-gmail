import type { IncomingMessage, ServerResponse } from 'node:http';
import { localhostHostValidation, localhostOriginValidation } from '@modelcontextprotocol/node';
import { VERSION } from '../version.js';
import type { ApiHandler } from './api.js';
import { constantTimeEqual, type SessionStore } from './session.js';
import { readStatic } from './static.js';

export const APP_NAME = 'multiple-gmail';
export const CSP = "default-src 'self'; frame-ancestors 'none'";
export const MAX_JSON_BODY = 1024 * 1024;
// Past this much discarded overflow the connection is dropped instead of drained.
const MAX_DRAIN = 8 * 1024 * 1024;

export type RouterContext = {
  // The bound port (known only after listen, so a getter).
  port: () => number;
  sessions: SessionStore;
  api: ApiHandler;
  mcp: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  getApiKey: () => Promise<string>;
  launchUrl: () => string;
  logError: (msg: string) => void;
};

function securityHeaders(res: ServerResponse): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Frame-Options', 'DENY');
}

function sendJson(res: ServerResponse, status: number, json: unknown, extra: Record<string, string> = {}): void {
  const body = JSON.stringify(json);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...extra });
  res.end(body);
}

function sendText(res: ServerResponse, status: number, text: string, type = 'text/plain; charset=utf-8'): void {
  res.writeHead(status, { 'Content-Type': type });
  res.end(text);
}

async function bearerOk(req: IncomingMessage, getApiKey: () => Promise<string>): Promise<boolean> {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.authorization ?? '');
  if (!m) return false;
  return constantTimeEqual(m[1], await getApiKey());
}

function unauthorized(res: ServerResponse): void {
  sendJson(res, 401, { error: 'Unauthorized.' }, { 'WWW-Authenticate': `Bearer realm="${APP_NAME}"` });
}

type Body = { kind: 'ok'; text: string } | { kind: 'too_large' };

function readBody(req: IncomingMessage, limit: number): Promise<Body> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    const chunks: Buffer[] = [];
    let size = 0;
    let over = Number.isFinite(declared) && declared > limit;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) over = true;
      if (over) {
        chunks.length = 0;
        if (size > MAX_DRAIN) req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(over ? { kind: 'too_large' } : { kind: 'ok', text: Buffer.concat(chunks).toString('utf8') }));
    req.on('error', reject);
  });
}

const isJsonType = (v: string | undefined) => !!v && /^application\/json\s*(;|$)/i.test(v);

export function createRouter(ctx: RouterContext): (req: IncomingMessage, res: ServerResponse) => void {
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();
  const selfOrigin = () => `http://127.0.0.1:${ctx.port()}`;

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // DNS rebinding protection for every route, not only /mcp.
    if (!validateHost(req, res)) return;
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;
    const method = req.method ?? 'GET';

    if (path === '/mcp') {
      if (!validateOrigin(req, res)) return;
      if (!(await bearerOk(req, ctx.getApiKey))) return unauthorized(res);
      return ctx.mcp(req, res);
    }

    securityHeaders(res);

    if (path === '/health') {
      if (method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed.' });
      return sendJson(res, 200, { app: APP_NAME, version: VERSION });
    }

    if (path === '/internal/launch') {
      if (method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed.' });
      // Only the second exe instance calls this; a browser always sends Origin on POST.
      if (req.headers.origin !== undefined) return sendJson(res, 403, { error: 'Forbidden.' });
      if (!(await bearerOk(req, ctx.getApiKey))) return unauthorized(res);
      return sendJson(res, 200, { url: ctx.launchUrl() });
    }

    if (path === '/api' || path.startsWith('/api/')) {
      if (!ctx.sessions.hasSession(req.headers.cookie)) {
        return sendJson(res, 401, { error: 'Not signed in. Open multiple-gmail again to get a new link.' });
      }
      const origin = req.headers.origin;
      if (method !== 'GET' && method !== 'HEAD' && origin !== selfOrigin()) {
        return sendJson(res, 403, { error: 'Forbidden.' });
      }
      const sameOrigin =
        origin !== undefined ? origin === selfOrigin() : req.headers['sec-fetch-site'] === 'same-origin';
      const body = await readBody(req, MAX_JSON_BODY);
      if (body.kind === 'too_large') {
        return sendJson(res, 413, { error: 'Request body too large.' }, { Connection: 'close' });
      }
      if (body.text.length > 0 && !isJsonType(req.headers['content-type'])) {
        return sendJson(res, 415, { error: 'Content-Type must be application/json.' });
      }
      const out = await ctx.api({ method, path: path.slice(4), body: body.text, sameOrigin });
      return sendJson(res, out.status, out.json);
    }

    if (method !== 'GET' && method !== 'HEAD') return sendText(res, 405, 'Method not allowed');

    if (path === '/' && url.searchParams.has('t')) {
      if (!ctx.sessions.consumeLaunchToken(url.searchParams.get('t') ?? '')) {
        return sendText(
          res,
          401,
          'This setup link has expired or was already used. Open multiple-gmail again to get a new link.',
        );
      }
      const id = ctx.sessions.createSession();
      res.writeHead(302, { Location: '/', 'Set-Cookie': ctx.sessions.cookieFor(id) });
      return void res.end();
    }

    const file = await readStatic(path);
    if (!file) return sendText(res, 404, 'Not found');
    res.writeHead(200, { 'Content-Type': file.type, 'Content-Length': String(file.body.length) });
    res.end(method === 'HEAD' ? undefined : file.body);
  }

  return (req, res) => {
    route(req, res).catch((e: unknown) => {
      ctx.logError(`multiple-gmail http error: ${e instanceof Error ? e.message : String(e)}`);
      if (!res.headersSent) sendJson(res, 500, { error: 'Internal error.' });
      else res.destroy();
    });
  };
}
