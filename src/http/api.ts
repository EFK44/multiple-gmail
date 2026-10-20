import { removeAccount } from '../core/accounts.js';
import { loadConfig, saveConfig, validateAlias } from '../core/config.js';
import { AccountError, AuthFlowError, startLoopbackAuth } from '../core/googleAuth.js';
import {
  getLocalApiKey,
  loadClient,
  parseClientJson,
  rotateLocalApiKey,
  saveClient,
} from '../core/secrets.js';
import { clearGmailCache } from '../gmail/client.js';
import { getAccountStatus } from '../gmail/errors.js';
import { createIntegrationsApi, type IntegrationsDeps } from '../integrations/routes.js';

export type ApiDeps = {
  startLoopbackAuth: typeof startLoopbackAuth;
  removeAccount: (alias: string) => Promise<{ revoked: boolean }>;
  integrations: Partial<IntegrationsDeps>;
};

export type ApiRequest = {
  method: string;
  // Path after "/api", for example "/state" or "/accounts/alpha/status".
  path: string;
  // Raw request body (utf8), "" when there is none.
  body: string;
  // True when the request is provably same-origin (checked by the router).
  sameOrigin: boolean;
};

export type ApiResponse = { status: number; json: unknown };

type FlowState = {
  id: number;
  authUrl?: string;
  status: 'pending' | 'connected' | 'failed';
  reason?: string;
  message?: string;
  email?: string;
  clientId?: string;
};

const ok = (json: unknown): ApiResponse => ({ status: 200, json });
const fail = (status: number, error: string): ApiResponse => ({ status, json: { error } });

export function maskKey(key: string): string {
  return `****${key.slice(-4)}`;
}

function parseJson(body: string): Record<string, unknown> | null {
  if (!body) return {};
  try {
    const v: unknown = JSON.parse(body);
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function aliasFrom(raw: string): string | null {
  try {
    return validateAlias(decodeURIComponent(raw));
  } catch {
    return null;
  }
}

// Wizard JSON API. Authentication (session cookie) and the Origin check happen in the router before this runs.
export function createApi(partial: Partial<ApiDeps> = {}) {
  const deps: ApiDeps = {
    startLoopbackAuth: partial.startLoopbackAuth ?? startLoopbackAuth,
    removeAccount: partial.removeAccount ?? ((alias) => removeAccount(alias)),
    integrations: partial.integrations ?? {},
  };
  const integrations = createIntegrationsApi(deps.integrations);
  const flows = new Map<string, FlowState>();
  // Flows whose loopback listener is being started (between reservation and authUrl).
  const starting = new Map<string, Promise<string | null>>();
  let nextFlowId = 1;

  async function beginConnect(alias: string, email: string | undefined, reconnect: boolean): Promise<ApiResponse> {
    const inFlight = starting.get(alias);
    if (inFlight) {
      const url = await inFlight;
      return url ? ok({ authUrl: url }) : fail(409, 'Another sign-in for this account just failed. Try again.');
    }
    // One loopback listener per alias: a second click while a sign-in is pending reuses it.
    const pending = flows.get(alias);
    if (pending?.status === 'pending' && pending.authUrl) return ok({ authUrl: pending.authUrl });
    // Reserve the alias before awaiting so two concurrent requests cannot both start a flow.
    const id = nextFlowId++;
    let resolveUrl!: (u: string | null) => void;
    const urlReady = new Promise<string | null>((r) => (resolveUrl = r));
    starting.set(alias, urlReady);
    let started: Awaited<ReturnType<ApiDeps['startLoopbackAuth']>>;
    try {
      const cfg = await loadConfig();
      started = await deps.startLoopbackAuth(alias, { loginHint: email, lang: cfg.language, reconnect });
    } catch (e) {
      resolveUrl(null);
      // no_client, alias_exists, unknown_alias: all conflicts with the current setup state.
      if (e instanceof AccountError) return fail(409, e.message);
      return fail(500, 'Could not start Google sign-in.');
    } finally {
      starting.delete(alias);
    }
    resolveUrl(started.url);
    flows.set(alias, { id, status: 'pending', authUrl: started.url });
    const current = () => flows.get(alias)?.id === id;
    // Always handled: an unhandled rejection here would crash the server.
    started.done.then(
      (acct) => {
        clearGmailCache(acct.alias);
        if (current()) flows.set(alias, { id, status: 'connected', email: acct.email });
      },
      async (e: unknown) => {
        const reason = e instanceof AuthFlowError ? e.code : 'unknown';
        // AuthFlowError messages are written for users; anything else may carry internals.
        const message = e instanceof AuthFlowError ? e.message : 'Google sign-in did not complete. Try again.';
        const state: FlowState = { id, status: 'failed', reason, message };
        if (reason === 'admin_blocked') {
          state.clientId = (await loadClient().catch(() => null))?.clientId;
        }
        if (current()) flows.set(alias, state);
      },
    ).catch(() => {});
    return ok({ authUrl: started.url });
  }

  async function state(): Promise<ApiResponse> {
    const cfg = await loadConfig();
    const client = await loadClient().catch(() => null);
    const key = await getLocalApiKey();
    return ok({
      hasClient: client !== null,
      language: cfg.language,
      defaultAccount: cfg.defaultAccount,
      accounts: Object.entries(cfg.accounts).map(([alias, a]) => ({
        alias,
        email: a.email,
        status: getAccountStatus(alias),
      })),
      apiKeyMasked: maskKey(key),
    });
  }

  return async function handle(req: ApiRequest): Promise<ApiResponse> {
    const { method, path } = req;
    const parts = path.split('/').filter(Boolean);

    if (path === '/state' && method === 'GET') return state();

    if (path === '/client' && method === 'POST') {
      let client;
      try {
        client = parseClientJson(req.body);
      } catch (e) {
        return fail(400, (e as Error).message);
      }
      await saveClient(client);
      return ok({ ok: true, kind: client.kind });
    }

    if (path === '/accounts' && method === 'POST') {
      const body = parseJson(req.body);
      if (!body) return fail(400, 'Expected a JSON object.');
      if (typeof body.alias !== 'string') return fail(400, 'alias is required.');
      let alias: string;
      try {
        alias = validateAlias(body.alias);
      } catch (e) {
        return fail(400, (e as Error).message);
      }
      const email = body.email;
      if (email !== undefined && (typeof email !== 'string' || email.length > 320)) {
        return fail(400, 'email must be a string.');
      }
      return beginConnect(alias, email ? email.trim() : undefined, false);
    }

    if (parts[0] === 'accounts' && parts.length >= 2) {
      const alias = aliasFrom(parts[1]);
      if (!alias) return fail(400, 'Invalid account alias.');
      if (parts.length === 3 && parts[2] === 'status' && method === 'GET') {
        const flow = flows.get(alias);
        if (flow && flow.status !== 'connected') {
          const { id: _id, authUrl: _url, ...rest } = flow;
          return ok(rest);
        }
        const cfg = await loadConfig();
        if (cfg.accounts[alias]) {
          const live = getAccountStatus(alias);
          return ok({ status: live === 'ok' ? 'connected' : live, email: cfg.accounts[alias].email });
        }
        if (flow) {
          const { id: _id, authUrl: _url, ...rest } = flow;
          return ok(rest);
        }
        return fail(404, `Unknown account "${alias}".`);
      }
      if (parts.length === 3 && parts[2] === 'reconnect' && method === 'POST') {
        return beginConnect(alias, undefined, true);
      }
      if (parts.length === 2 && method === 'DELETE') {
        try {
          const { revoked } = await deps.removeAccount(alias);
          clearGmailCache(alias);
          flows.delete(alias);
          return ok({ ok: true, revoked });
        } catch (e) {
          if (e instanceof AccountError && e.code === 'unknown_alias') return fail(404, `Unknown account "${alias}".`);
          return fail(500, 'Could not remove the account.');
        }
      }
    }

    if (path === '/apikey' && method === 'GET') {
      if (!req.sameOrigin) return fail(403, 'Forbidden.');
      return ok({ apiKey: await getLocalApiKey() });
    }

    if (path === '/apikey/rotate' && method === 'POST') {
      return ok({ apiKeyMasked: maskKey(await rotateLocalApiKey()) });
    }

    if (path === '/language' && method === 'POST') {
      const body = parseJson(req.body);
      const language = body?.language;
      if (language !== 'en' && language !== 'tr') return fail(400, 'language must be "en" or "tr".');
      const cfg = await loadConfig();
      await saveConfig({ ...cfg, language });
      return ok({ ok: true, language });
    }

    if (path === '/autostart' || path.startsWith('/integrations')) {
      const res = await integrations(method, path, req.body);
      if (res) return res;
    }

    return fail(404, 'Not found.');
  };
}

export type ApiHandler = ReturnType<typeof createApi>;
