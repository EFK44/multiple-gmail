import { removeAccount, renameAccount } from '../core/accounts.js';
import { getAccount, loadConfig, NameError, newAccountId, sameName, updateConfig, validateId, validateName } from '../core/config.js';
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
  removeAccount: (id: string) => Promise<{ revoked: boolean }>;
  integrations: Partial<IntegrationsDeps>;
  // Remote mode (serve --remote): no local API key, integrations or autostart, and only Web application clients.
  remote?: { mcpUrl: string; googleRedirectUri: string };
};

export type ApiRequest = {
  method: string;
  // Path after "/api", for example "/state" or "/accounts/<id>/status" (the id URL-encoded).
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
  name?: string;
  clientId?: string;
};

const ok = (json: unknown): ApiResponse => ({ status: 200, json });

// Same text as upload.webWarning and upload.clientChanged in src/web/i18n (a test keeps them equal).
const UPLOAD_TEXT = {
  webWarning: {
    en: "This file belongs to a Web application client. multiple-gmail needs a Desktop app client. Go back to the Google Cloud guide, step 5, and create a Desktop app client.",
    tr: "Bu dosya \"Web application\" türünde bir istemciye ait. multiple-gmail'in \"Desktop app\" türünde bir istemciye ihtiyacı var. Google Cloud rehberinin 5. adımına dön ve \"Desktop app\" istemcisi oluştur.",
  },
  clientChanged: {
    en: "This key file belongs to a different Google client than the one your accounts were connected with. Click Reconnect on every account to sign in again.",
    tr: "Bu anahtar dosyası, hesaplarının bağlandığı istemciden farklı bir Google istemcisine ait. Her hesapta Yeniden bağla düğmesine tıklayıp tekrar oturum aç.",
  },
} as const;
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

function idFrom(raw: string): string | null {
  try {
    return validateId(decodeURIComponent(raw));
  } catch {
    return null;
  }
}


// Wizard JSON API. Authentication (session cookie) and the Origin check happen in the router before this runs.
export function createApi(partial: Partial<ApiDeps> = {}) {
  const deps: ApiDeps = {
    startLoopbackAuth: partial.startLoopbackAuth ?? startLoopbackAuth,
    removeAccount: partial.removeAccount ?? ((id) => removeAccount(id)),
    integrations: partial.integrations ?? {},
    remote: partial.remote,
  };
  const remote = deps.remote;
  const integrations = remote ? null : createIntegrationsApi(deps.integrations);
  // Keyed by account id (for a new account, the id it will be saved under).
  const flows = new Map<string, FlowState>();
  // Flows whose loopback listener is being started (between reservation and authUrl).
  const starting = new Map<string, Promise<string | null>>();
  // New accounts being signed in: id -> name, so a second "add" click with the same name reuses the flow.
  const pendingAdds = new Map<string, string>();
  let nextFlowId = 1;

  // `target` is the display name for a new account; a reconnect goes by the id alone.
  async function beginConnect(alias: string, target: string, email: string | undefined, reconnect: boolean): Promise<ApiResponse> {
    const inFlight = starting.get(alias);
    if (inFlight) {
      const url = await inFlight;
      return url ? ok({ authUrl: url, id: alias }) : fail(409, 'Another sign-in for this account just failed. Try again.');
    }
    // One loopback listener per account: a second click while a sign-in is pending reuses it.
    const pending = flows.get(alias);
    if (pending?.status === 'pending' && pending.authUrl) return ok({ authUrl: pending.authUrl, id: alias });
    // Reserve the id before awaiting so two concurrent requests cannot both start a flow.
    const id = nextFlowId++;
    let resolveUrl!: (u: string | null) => void;
    const urlReady = new Promise<string | null>((r) => (resolveUrl = r));
    starting.set(alias, urlReady);
    let started: Awaited<ReturnType<ApiDeps['startLoopbackAuth']>>;
    try {
      const cfg = await loadConfig();
      started = await deps.startLoopbackAuth(target, { loginHint: email, lang: cfg.language, reconnect, id: alias });
    } catch (e) {
      resolveUrl(null);
      if (e instanceof AccountError) {
        if (e.code === 'invalid_name') return fail(400, e.message);
        // no_client, name_exists, unknown_account: all conflicts with the current setup state.
        return fail(409, e.message);
      }
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
        clearGmailCache(acct.id);
        if (current()) flows.set(alias, { id, status: 'connected', email: acct.email, name: acct.name });
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
    return ok({ authUrl: started.url, id: alias });
  }

  async function state(): Promise<ApiResponse> {
    const cfg = await loadConfig();
    const client = await loadClient().catch(() => null);
    const key = remote ? null : await getLocalApiKey();
    return ok({
      mode: remote ? 'remote' : 'local',
      ...(remote ? { mcpUrl: remote.mcpUrl, googleRedirectUri: remote.googleRedirectUri } : {}),
      hasClient: client !== null,
      // The client ID is public (it appears in every sign-in URL); the wizard shows it for Workspace admin steps.
      // The client secret is never sent to the UI.
      clientId: client?.clientId ?? null,
      clientKind: client?.kind ?? null,
      language: cfg.language,
      accounts: Object.entries(cfg.accounts).map(([id, a]) => ({
        id,
        name: a.name,
        email: a.email,
        status: getAccountStatus(id),
      })),
      ...(key !== null ? { apiKeyMasked: maskKey(key) } : {}),
    });
  }

  async function handle(req: ApiRequest): Promise<ApiResponse> {
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
      if (remote) {
        if (client.kind !== 'web') {
          return fail(400, 'Server mode needs a "Web application" OAuth client, not a Desktop app client.');
        }
        if (!client.redirectUris.includes(remote.googleRedirectUri)) {
          return fail(400, `Add this authorized redirect URI to the OAuth client in Google Cloud, then download the JSON again: ${remote.googleRedirectUri}`);
        }
      }
      const cfg = await loadConfig();
      if (!remote && client.kind !== 'installed') {
        return { status: 400, json: { error: UPLOAD_TEXT.webWarning[cfg.language], code: 'web_client' } };
      }
      // Tokens are bound to the client that issued them: a different client means every account must sign in again.
      // Still saved: the user chose this file.
      const previous = await loadClient().catch(() => null);
      const changed = Object.keys(cfg.accounts).length > 0 && previous !== null && previous.clientId !== client.clientId;
      await saveClient(client);
      return ok({
        ok: true,
        kind: client.kind,
        ...(changed ? { clientChanged: true, warning: UPLOAD_TEXT.clientChanged[cfg.language] } : {}),
      });
    }

    if (path === '/accounts' && method === 'POST') {
      const body = parseJson(req.body);
      if (!body) return fail(400, 'Expected a JSON object.');
      // "alias" is the field name older UIs sent.
      const rawName = typeof body.name === 'string' ? body.name : body.alias;
      if (typeof rawName !== 'string') return fail(400, 'name is required.');
      let name: string;
      try {
        name = validateName(rawName, await loadConfig());
      } catch (e) {
        if (!(e instanceof NameError)) throw e;
        return fail(e.code === 'taken' ? 409 : 400, e.message);
      }
      const email = body.email;
      if (email !== undefined && (typeof email !== 'string' || email.length > 320)) {
        return fail(400, 'email must be a string.');
      }
      for (const pid of pendingAdds.keys()) {
        if (!starting.has(pid) && flows.get(pid)?.status !== 'pending') pendingAdds.delete(pid);
      }
      const id = [...pendingAdds].find(([, pname]) => sameName(pname, name))?.[0] ?? newAccountId();
      pendingAdds.set(id, name);
      return beginConnect(id, name, email ? email.trim() : undefined, false);
    }

    if (parts[0] === 'accounts' && parts.length >= 2) {
      const alias = idFrom(parts[1]);
      if (!alias) return fail(400, 'Invalid account id.');
      if (parts.length === 3 && parts[2] === 'status' && method === 'GET') {
        const flow = flows.get(alias);
        if (flow && flow.status !== 'connected') {
          const { id: _id, authUrl: _url, ...rest } = flow;
          return ok(rest);
        }
        const cfg = await loadConfig();
        const acct = getAccount(cfg, alias);
        if (acct) {
          const live = getAccountStatus(alias);
          return ok({ status: live === 'ok' ? 'connected' : live, email: acct.email, name: acct.name });
        }
        if (flow) {
          const { id: _id, authUrl: _url, ...rest } = flow;
          return ok(rest);
        }
        return fail(404, `Unknown account "${alias}".`);
      }
      if (parts.length === 3 && parts[2] === 'reconnect' && method === 'POST') {
        return beginConnect(alias, alias, undefined, true);
      }
      if (parts.length === 3 && parts[2] === 'rename' && method === 'POST') {
        const body = parseJson(req.body);
        if (!body) return fail(400, 'Expected a JSON object.');
        if (typeof body.name !== 'string') return fail(400, 'name is required.');
        try {
          const acct = await renameAccount(alias, body.name);
          return ok({ ok: true, id: acct.id, name: acct.name });
        } catch (e) {
          if (!(e instanceof AccountError)) throw e;
          if (e.code === 'unknown_account') return fail(404, `Unknown account "${alias}".`);
          return fail(e.code === 'name_exists' ? 409 : 400, e.message);
        }
      }
      if (parts.length === 2 && method === 'DELETE') {
        try {
          const { revoked } = await deps.removeAccount(alias);
          clearGmailCache(alias);
          flows.delete(alias);
          pendingAdds.delete(alias);
          return ok({ ok: true, revoked });
        } catch (e) {
          if (e instanceof AccountError && e.code === 'unknown_account') return fail(404, `Unknown account "${alias}".`);
          return fail(500, 'Could not remove the account.');
        }
      }
    }

    if (remote && (path.startsWith('/apikey') || path === '/autostart' || path.startsWith('/integrations'))) {
      return fail(404, 'Not found.');
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
      await updateConfig((cfg) => {
        cfg.language = language;
      });
      return ok({ ok: true, language });
    }

    if (integrations && (path === '/autostart' || path.startsWith('/integrations'))) {
      const res = await integrations(method, path, req.body);
      if (res) return res;
    }

    return fail(404, 'Not found.');
  }

  // Ids of new accounts whose sign-in is still tracked (tests check that removal drops them).
  return Object.assign(handle, { pendingAddIds: () => [...pendingAdds.keys()] });
}

export type ApiHandler = ReturnType<typeof createApi>;
