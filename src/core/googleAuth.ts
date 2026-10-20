import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gmail } from '@googleapis/gmail';
import { CodeChallengeMethod, OAuth2Client } from 'google-auth-library';
import { AccountError, REVOKE_URL, type ConnectedAccount } from './accounts.js';
import { findAccount, getAccount, loadConfig, NameError, newAccountId, sameName, saveConfig, validateId, validateName, withConfigLock } from './config.js';
import { loadClient, saveToken, type OAuthClient } from './secrets.js';

export type { ConnectedAccount } from './accounts.js';
export { AccountError } from './accounts.js';

export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const PERMISSIONS_URL = 'https://myaccount.google.com/permissions';

export type OAuthErrorCode = 'admin_blocked' | 'user_denied' | 'unknown';

export function classifyOAuthError(error: string | null): OAuthErrorCode {
  if (error === 'admin_policy_enforced') return 'admin_blocked';
  if (error === 'access_denied') return 'user_denied';
  return 'unknown';
}

// Error with a machine-readable code so the HTTP layer can show, for example, Workspace admin steps.
export class AuthFlowError extends Error {
  readonly code: OAuthErrorCode | 'timeout';
  constructor(code: OAuthErrorCode | 'timeout', message: string) {
    super(message);
    this.name = 'AuthFlowError';
    this.code = code;
  }
}

export function beginAuth(opts: {
  id: string;
  client: OAuthClient;
  redirectUri: string;
  loginHint?: string;
}): { url: string; state: string; codeVerifier: string } {
  validateId(opts.id);
  const state = randomBytes(32).toString('base64url');
  const codeVerifier = randomBytes(32).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
  const oauth = new OAuth2Client({ clientId: opts.client.clientId, redirectUri: opts.redirectUri });
  const url = oauth.generateAuthUrl({
    scope: GMAIL_SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    response_type: 'code',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: CodeChallengeMethod.S256,
    redirect_uri: opts.redirectUri,
    ...(opts.loginHint ? { login_hint: opts.loginHint } : {}),
  });
  return { url, state, codeVerifier };
}

export type TokenSet = {
  refreshToken?: string | null;
  accessToken?: string | null;
  expiryDate?: number | null;
  scope?: string | null;
};

export type LoopbackDeps = {
  loadClient?: () => Promise<OAuthClient | null>;
  exchangeCode?: (a: {
    client: OAuthClient;
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }) => Promise<TokenSet>;
  getProfileEmail?: (accessToken: string, client: OAuthClient) => Promise<string>;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

export type LoopbackOptions = {
  loginHint?: string;
  lang?: 'en' | 'tr';
  reconnect?: boolean;
  // New account: the id to store it under (generated when omitted). Reconnect: the exact id to reconnect.
  id?: string;
  deps?: LoopbackDeps;
};

// Short reason from a Google/gaxios error, never including request data.
function googleReason(err: unknown): string {
  const e = err as { response?: { status?: number; data?: { error?: unknown; error_description?: unknown } } };
  const data = e?.response?.data;
  const parts: string[] = [];
  if (typeof e?.response?.status === 'number') parts.push(`HTTP ${e.response.status}`);
  if (data && typeof data.error === 'string') parts.push(data.error);
  const nested = data?.error as { message?: unknown } | undefined;
  if (nested && typeof nested === 'object' && typeof nested.message === 'string') parts.push(nested.message);
  if (data && typeof data.error_description === 'string') parts.push(data.error_description);
  return parts.length ? parts.join(' ') : 'network or unexpected error';
}

async function defaultExchangeCode(a: {
  client: OAuthClient;
  code: string;
  codeVerifier: string;
  redirectUri: string;
}): Promise<TokenSet> {
  const oauth = new OAuth2Client({
    clientId: a.client.clientId,
    clientSecret: a.client.clientSecret,
    redirectUri: a.redirectUri,
  });
  let tokens;
  try {
    ({ tokens } = await oauth.getToken({ code: a.code, codeVerifier: a.codeVerifier, redirect_uri: a.redirectUri }));
  } catch (err) {
    // Rethrow without the request config: the original error object carries the code and client secret.
    throw new Error(`Google token exchange failed: ${googleReason(err)}`);
  }
  return {
    refreshToken: tokens.refresh_token,
    accessToken: tokens.access_token,
    expiryDate: tokens.expiry_date,
    scope: tokens.scope,
  };
}

async function defaultGetProfileEmail(accessToken: string, client: OAuthClient): Promise<string> {
  const auth = new OAuth2Client({ clientId: client.clientId, clientSecret: client.clientSecret });
  auth.setCredentials({ access_token: accessToken });
  let res;
  try {
    res = await gmail({ version: 'v1', auth }).users.getProfile({ userId: 'me' });
  } catch (err) {
    // Rethrow without the request config: the original error object carries the bearer token.
    throw new Error(`Reading the Gmail profile failed: ${googleReason(err)}`);
  }
  const email = res.data.emailAddress;
  if (!email) throw new Error('Gmail did not return the account email address.');
  return email;
}

export function formatDuration(ms: number): string {
  if (ms >= 60_000) {
    const n = Math.round(ms / 60_000);
    return `${n} minute${n === 1 ? '' : 's'}`;
  }
  const n = Math.max(1, Math.round(ms / 1000));
  return `${n} second${n === 1 ? '' : 's'}`;
}

// Best effort: a refresh token that will not be stored must not stay valid at Google. Errors are ignored.
async function revokeQuietly(doFetch: typeof fetch, token: string): Promise<void> {
  try {
    await doFetch(REVOKE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }).toString(),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // ignored
  }
}

function sameEmail(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}

function hasScope(scope: string | null | undefined, wanted: string): boolean {
  return (scope ?? '').split(/\s+/).includes(wanted);
}

type PageKind = 'success' | 'admin_blocked' | 'user_denied' | 'failed' | 'invalid';

const PAGES: Record<'en' | 'tr', Record<PageKind, { title: string; text: string }>> = {
  en: {
    success: {
      title: 'Account connected',
      text: 'The account is connected. You can close this window and return to multiple-gmail.',
    },
    admin_blocked: {
      title: 'Access blocked by administrator',
      text: 'Your Google Workspace administrator blocked this app. Return to multiple-gmail for the steps to allow it.',
    },
    user_denied: {
      title: 'Sign-in cancelled',
      text: 'Access was not granted. You can close this window and try again from multiple-gmail.',
    },
    failed: {
      title: 'Connection failed',
      text: 'The account could not be connected. Return to multiple-gmail for details.',
    },
    invalid: {
      title: 'Invalid request',
      text: 'This sign-in link is invalid or has expired. Start again from multiple-gmail.',
    },
  },
  tr: {
    success: {
      title: 'Hesap bağlandı',
      text: 'Hesap bağlandı. Bu pencereyi kapatıp multiple-gmail uygulamasına dönebilirsiniz.',
    },
    admin_blocked: {
      title: 'Erişim yönetici tarafından engellendi',
      text: 'Google Workspace yöneticiniz bu uygulamayı engelledi. İzin verme adımları için multiple-gmail uygulamasına dönün.',
    },
    user_denied: {
      title: 'Giriş iptal edildi',
      text: 'Erişim izni verilmedi. Bu pencereyi kapatıp multiple-gmail üzerinden yeniden deneyebilirsiniz.',
    },
    failed: {
      title: 'Bağlantı başarısız',
      text: 'Hesap bağlanamadı. Ayrıntılar için multiple-gmail uygulamasına dönün.',
    },
    invalid: {
      title: 'Geçersiz istek',
      text: 'Bu giriş bağlantısı geçersiz veya süresi dolmuş. multiple-gmail üzerinden yeniden başlayın.',
    },
  },
};

// Static, fixed text only: nothing from the request is reflected into the page.
function sendPage(res: ServerResponse, status: number, lang: 'en' | 'tr', kind: PageKind): void {
  const p = PAGES[lang][kind];
  const html =
    `<!doctype html><html lang="${lang}"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1"><title>${p.title}</title></head>` +
    `<body style="font-family:system-ui,sans-serif;max-width:36rem;margin:3rem auto;padding:0 1rem">` +
    `<h1>${p.title}</h1><p>${p.text}</p></body></html>`;
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    Connection: 'close',
  });
  res.end(html);
}

function sendPlain(res: ServerResponse, status: number): void {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close' });
  res.end(status === 404 ? 'Not found' : 'Method not allowed');
}

type CompleteArgs = {
  id: string;
  // Display name for a new account (a reconnect keeps the stored name).
  name: string;
  reconnect: boolean;
  client: OAuthClient;
  codeVerifier: string;
  redirectUri: string;
  exchangeCode: NonNullable<LoopbackDeps['exchangeCode']>;
  getProfileEmail: NonNullable<LoopbackDeps['getProfileEmail']>;
  doFetch: typeof fetch;
  // True once the flow has timed out or finished: nothing may be saved then.
  cancelled: () => boolean;
  // Called after the Google network calls, before the local file work.
  networkDone: () => void;
};

// Shared by the loopback (local) and web (remote) flows: exchange the code, check the grant, and save the account.
function completeAuth(c: CompleteArgs): (code: string) => Promise<ConnectedAccount> {
  const { id: a, name, client, codeVerifier, redirectUri, exchangeCode, getProfileEmail, doFetch } = c;
  return async (code: string): Promise<ConnectedAccount> => {
    const tokens = await exchangeCode({ client, code, codeVerifier, redirectUri });
    if (!tokens.refreshToken) {
      throw new Error(
        `Google did not return a refresh token. Remove this app's access at ${PERMISSIONS_URL} and try again.`,
      );
    }
    if (!hasScope(tokens.scope, GMAIL_SCOPE)) {
      throw new Error(
        'Gmail access was not granted. Try again and tick the Gmail permission checkbox on the Google consent screen.',
      );
    }
    if (!tokens.accessToken) throw new Error('Google did not return an access token. Try again.');
    const email = (await getProfileEmail(tokens.accessToken, client)).trim();
    // The network calls are done; the remaining steps are local file work and are not bounded by the Google timeout.
    c.networkDone();

    const refreshToken = tokens.refreshToken;
    // Checks and the config write run under the config lock, so a concurrent sign-in or rename cannot be lost.
    return withConfigLock(async () => {
      const now = await loadConfig();
      // Revoking a refresh token revokes the whole grant, so never do it for an email that is already connected.
      const alreadyConnected = Object.values(now.accounts).some((entry) => sameEmail(entry.email, email));
      const reject = async (message: string): Promise<never> => {
        if (!alreadyConnected) await revokeQuietly(doFetch, refreshToken);
        throw new Error(message);
      };
      if (c.cancelled()) throw new Error('Google sign-in timed out.');
      const current = getAccount(now, a);
      if (c.reconnect) {
        if (!current) return reject(`No account "${name}" to reconnect.`);
        if (!sameEmail(current.email, email)) {
          return reject(`Signed in as ${email} but the account "${current.name}" belongs to ${current.email}`);
        }
      } else if (current) {
        return reject(`The account "${current.name}" already exists, use Reconnect.`);
      }
      for (const [other, entry] of Object.entries(now.accounts)) {
        if (other !== a && sameEmail(entry.email, email)) {
          return reject(`This Google account (${email}) is already connected as "${entry.name}".`);
        }
        if (!c.reconnect && other !== a && (sameName(entry.name, name) || sameName(other, name))) {
          return reject(`An account named "${entry.name}" already exists.`);
        }
      }

      if (c.cancelled()) throw new Error('Google sign-in timed out.');
      await saveToken(a, {
        refreshToken,
        ...(tokens.accessToken ? { accessToken: tokens.accessToken } : {}),
        ...(typeof tokens.expiryDate === 'number' ? { expiryDate: tokens.expiryDate } : {}),
        scope: tokens.scope ?? GMAIL_SCOPE,
      });
      const finalName = current?.name ?? name;
      // Re-load right before saving: the token write above awaited, and another process may have changed the file.
      const fresh = await loadConfig();
      fresh.accounts[a] = { name: finalName, email, addedAt: current?.addedAt ?? new Date().toISOString() };
      await saveConfig(fresh);
      return { id: a, name: finalName, email };
    });
  };
}

// Checks shared by both flows before a sign-in starts.
// `target` is the new display name, or (reconnect) a name, email or id of an existing account.
async function prepareAuth(target: string, opts: LoopbackOptions) {
  const deps = opts.deps ?? {};
  const cfg = await loadConfig();
  let a: string;
  let name: string;
  let existing;
  if (opts.reconnect) {
    const found = opts.id !== undefined ? validateId(opts.id) : findAccount(cfg, target);
    existing = found ? getAccount(cfg, found) : undefined;
    if (!found || !existing) throw new AccountError('unknown_account', `No account "${target}" to reconnect.`);
    a = found;
    name = existing.name;
  } else {
    try {
      name = validateName(target, cfg);
    } catch (e) {
      if (!(e instanceof NameError)) throw e;
      throw new AccountError(e.code === 'taken' ? 'name_exists' : 'invalid_name', e.message);
    }
    a = validateId(opts.id ?? newAccountId());
    if (getAccount(cfg, a)) throw new AccountError('name_exists', `An account with id "${a}" already exists.`);
  }
  const client = await (deps.loadClient ?? loadClient)();
  if (!client) throw new AccountError('no_client', 'No OAuth client has been uploaded yet. Upload the OAuth client JSON first.');
  return {
    a,
    name,
    client,
    existing,
    lang: opts.lang ?? cfg.language,
    exchangeCode: deps.exchangeCode ?? defaultExchangeCode,
    getProfileEmail: deps.getProfileEmail ?? defaultGetProfileEmail,
    timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    doFetch: deps.fetch ?? fetch,
  };
}

function callbackError(error: string): AuthFlowError {
  const kind = classifyOAuthError(error);
  const msg =
    kind === 'admin_blocked'
      ? 'Access blocked: your Google Workspace administrator does not allow this app. Mark the OAuth client as Trusted in the Admin console (Security > API controls > third-party app access) and try again.'
      : kind === 'user_denied'
        ? 'Google sign-in was cancelled or access was denied.'
        : 'Google sign-in failed. Try again.';
  return new AuthFlowError(kind, msg);
}

export async function startLoopbackAuth(
  target: string,
  opts: LoopbackOptions = {},
): Promise<{ url: string; id: string; done: Promise<ConnectedAccount> }> {
  const { a, name, client, existing, lang, exchangeCode, getProfileEmail, timeoutMs, doFetch } = await prepareAuth(target, opts);

  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const auth = beginAuth({ id: a, client, redirectUri, loginHint: opts.loginHint ?? existing?.email });

  let settled = false;
  let resolveDone!: (v: ConnectedAccount) => void;
  let rejectDone!: (e: Error) => void;
  const done = new Promise<ConnectedAccount>((res, rej) => {
    resolveDone = res;
    rejectDone = rej;
  });

  let exchangeTimer: NodeJS.Timeout | undefined;
  const shutdown = () => {
    clearTimeout(timer);
    clearTimeout(exchangeTimer);
    server.close();
    server.closeAllConnections();
  };
  const finish = (result: { ok: ConnectedAccount } | { err: Error }) => {
    if (settled) return;
    settled = true;
    // Let the response flush before dropping connections.
    setImmediate(shutdown);
    if ('ok' in result) resolveDone(result.ok);
    else rejectDone(result.err);
  };

  const exchangeBound = Math.min(timeoutMs, 60_000);
  const timer = setTimeout(() => {
    finish({ err: new AuthFlowError('timeout', `Google sign-in timed out after ${formatDuration(timeoutMs)}. Start again.`) });
  }, timeoutMs);
  timer.unref?.();

  const complete = completeAuth({
    id: a,
    name,
    reconnect: !!opts.reconnect,
    client,
    codeVerifier: auth.codeVerifier,
    redirectUri,
    exchangeCode,
    getProfileEmail,
    doFetch,
    cancelled: () => settled,
    networkDone: () => clearTimeout(exchangeTimer),
  });

  let handling = false;
  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    const reqUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (reqUrl.pathname !== '/callback') return sendPlain(res, 404);
    if (req.method !== 'GET') return sendPlain(res, 405);
    const q = reqUrl.searchParams;
    const state = q.get('state');
    if (settled || handling || !state || !safeEqual(state, auth.state)) {
      return sendPage(res, 400, lang, 'invalid');
    }
    handling = true;
    // The flow timer is replaced by a bound on the exchange itself, so a hung Google call cannot leave the server open.
    clearTimeout(timer);
    exchangeTimer = setTimeout(() => {
      finish({
        err: new AuthFlowError('timeout', `Google sign-in timed out after ${formatDuration(exchangeBound)}. Start again.`),
      });
    }, exchangeBound);
    exchangeTimer.unref?.();

    const error = q.get('error');
    if (error) {
      const err = callbackError(error);
      sendPage(res, 200, lang, err.code === 'unknown' ? 'failed' : (err.code as PageKind));
      return finish({ err });
    }
    const code = q.get('code');
    if (!code) {
      sendPage(res, 400, lang, 'failed');
      return finish({ err: new AuthFlowError('unknown', 'Google did not return an authorization code. Try again.') });
    }
    complete(code).then(
      (acct) => {
        sendPage(res, 200, lang, 'success');
        finish({ ok: acct });
      },
      (err: unknown) => {
        sendPage(res, 200, lang, 'failed');
        finish({ err: err instanceof Error ? err : new Error('Connecting the account failed.') });
      },
    );
  });

  return { url: auth.url, id: a, done };
}

// ---------- web flow (remote mode) ----------

export type WebAuthStart = (
  target: string,
  opts?: Omit<LoopbackOptions, 'deps'>,
) => Promise<{ url: string; id: string; done: Promise<ConnectedAccount> }>;

type WebFlow = {
  lang: 'en' | 'tr';
  complete: (code: string) => Promise<ConnectedAccount>;
  finish: (r: { ok: ConnectedAccount } | { err: Error }) => void;
  isSettled: () => boolean;
};

const MAX_WEB_FLOWS = 16;

// Remote mode: Google redirects the browser to redirectUri (PUBLIC_URL + /oauth/google/callback) on this server, so
// there is no per-flow listener. startWebAuth is the sibling of startLoopbackAuth (same beginAuth, same checks, same
// completion); handleCallback answers the callback request. The caller authenticates the callback request itself.
export function createWebAuth(o: { redirectUri: string; deps?: LoopbackDeps }): {
  startWebAuth: WebAuthStart;
  handleCallback: (query: URLSearchParams, res: ServerResponse) => Promise<void>;
} {
  const flows = new Map<string, WebFlow>();

  const startWebAuth: WebAuthStart = async (target, opts = {}) => {
    const p = await prepareAuth(target, { ...opts, deps: o.deps });
    const auth = beginAuth({ id: p.a, client: p.client, redirectUri: o.redirectUri, loginHint: opts.loginHint ?? p.existing?.email });
    const key = createHash('sha256').update(auth.state, 'utf8').digest('hex');
    let settled = false;
    let resolveDone!: (v: ConnectedAccount) => void;
    let rejectDone!: (e: Error) => void;
    const done = new Promise<ConnectedAccount>((res, rej) => {
      resolveDone = res;
      rejectDone = rej;
    });
    let exchangeTimer: NodeJS.Timeout | undefined;
    const finish = (r: { ok: ConnectedAccount } | { err: Error }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(exchangeTimer);
      flows.delete(key);
      if ('ok' in r) resolveDone(r.ok);
      else rejectDone(r.err);
    };
    const timer = setTimeout(() => {
      finish({ err: new AuthFlowError('timeout', `Google sign-in timed out after ${formatDuration(p.timeoutMs)}. Start again.`) });
    }, p.timeoutMs);
    timer.unref?.();
    const exchangeBound = Math.min(p.timeoutMs, 60_000);
    const complete = completeAuth({
      id: p.a,
      name: p.name,
      reconnect: !!opts.reconnect,
      client: p.client,
      codeVerifier: auth.codeVerifier,
      redirectUri: o.redirectUri,
      exchangeCode: p.exchangeCode,
      getProfileEmail: p.getProfileEmail,
      doFetch: p.doFetch,
      cancelled: () => settled,
      networkDone: () => clearTimeout(exchangeTimer),
    });
    // Oldest pending flow is dropped when too many are open.
    while (flows.size >= MAX_WEB_FLOWS) {
      const oldest = flows.values().next().value;
      if (!oldest) break;
      oldest.finish({ err: new AuthFlowError('timeout', 'Too many sign-ins were started. Start again.') });
    }
    flows.set(key, {
      lang: p.lang,
      complete: (code) => {
        exchangeTimer = setTimeout(() => {
          finish({ err: new AuthFlowError('timeout', `Google sign-in timed out after ${formatDuration(exchangeBound)}. Start again.`) });
        }, exchangeBound);
        exchangeTimer.unref?.();
        return complete(code);
      },
      finish,
      isSettled: () => settled,
    });
    // Always handled by the caller; avoid an unhandled rejection if it is not.
    done.catch(() => {});
    return { url: auth.url, id: p.a, done };
  };

  async function handleCallback(q: URLSearchParams, res: ServerResponse): Promise<void> {
    const state = q.get('state');
    const key = state ? createHash('sha256').update(state, 'utf8').digest('hex') : '';
    const flow = key ? flows.get(key) : undefined;
    const lang: 'en' | 'tr' = flow?.lang ?? 'en';
    if (!flow || flow.isSettled()) return sendPage(res, 400, lang, 'invalid');
    // Single use: a second callback with the same state is invalid.
    flows.delete(key);
    const error = q.get('error');
    if (error) {
      const err = callbackError(error);
      sendPage(res, 200, lang, err.code === 'unknown' ? 'failed' : (err.code as PageKind));
      return flow.finish({ err });
    }
    const code = q.get('code');
    if (!code) {
      sendPage(res, 400, lang, 'failed');
      return flow.finish({ err: new AuthFlowError('unknown', 'Google did not return an authorization code. Try again.') });
    }
    try {
      const acct = await flow.complete(code);
      sendPage(res, 200, lang, 'success');
      flow.finish({ ok: acct });
    } catch (err) {
      sendPage(res, 200, lang, 'failed');
      flow.finish({ err: err instanceof Error ? err : new Error('Connecting the account failed.') });
    }
  }

  return { startWebAuth, handleCallback };
}
