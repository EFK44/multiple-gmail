import { gmail, type gmail_v1 } from '@googleapis/gmail';
import { stat } from 'node:fs/promises';
import { OAuth2Client } from 'google-auth-library';
import { getAccount, loadConfig, validateId } from '../core/config.js';
import { tokenPath } from '../core/paths.js';
import { loadClient, loadToken, saveToken } from '../core/secrets.js';
import { friendly, reauthMessage, setAccountStatus } from './errors.js';

// The subset of gmail_v1.Gmail that the tools use. Tests inject fakes.
export type GmailApi = {
  users: {
    getProfile: gmail_v1.Resource$Users['getProfile'];
    threads: Pick<gmail_v1.Resource$Users$Threads, 'list' | 'get' | 'modify'>;
    messages: Pick<gmail_v1.Resource$Users$Messages, 'get' | 'send'>;
    drafts: Pick<gmail_v1.Resource$Users$Drafts, 'list' | 'get' | 'create' | 'send'>;
    labels: Pick<gmail_v1.Resource$Users$Labels, 'list'>;
  };
};

export type GmailFactory = (auth: OAuth2Client) => GmailApi;

const defaultFactory: GmailFactory = (auth) => gmail({ version: 'v1', auth }) as unknown as GmailApi;
let factory: GmailFactory = defaultFactory;

export function setGmailFactoryForTests(f: GmailFactory | null): void {
  factory = f ?? defaultFactory;
}

type Entry = { api: GmailApi; email: string };
// What a cached client was built from: another process (a reconnect in the setup window) may replace the token file,
// so a long-lived process compares the file signature, then the refresh token, before reusing a client.
type Cached = Entry & { refreshToken: string; sig: string };
const cache = new Map<string, Promise<Cached>>();

// Drops cached clients (all, or one id). Clearing an id also resets its status: used after reconnect and remove.
export function clearGmailCache(alias?: string): void {
  if (alias === undefined) {
    cache.clear();
    return;
  }
  cache.delete(alias);
  setAccountStatus(alias, 'ok');
}

// Drops one cached client but keeps its status (used when Google rejected its credentials).
export function evictGmail(id: string): void {
  cache.delete(id);
}

async function tokenSig(id: string): Promise<string> {
  try {
    const s = await stat(tokenPath(validateId(id)));
    return `${s.mtimeMs}:${s.ctimeMs}:${s.size}:${s.ino}`;
  } catch {
    return 'missing';
  }
}

async function build(alias: string): Promise<Cached> {
  const cfg = await loadConfig();
  const account = getAccount(cfg, alias);
  if (!account) throw friendly(`Unknown account ${alias}`);
  const client = await loadClient();
  if (!client) throw friendly('No Google OAuth client configured. Open multiple-gmail to finish setup.');
  const sig = await tokenSig(alias);
  const token = await loadToken(alias);
  if (!token) {
    setAccountStatus(alias, 'needs_reauth');
    throw friendly(reauthMessage(account.name));
  }
  const auth = new OAuth2Client({ clientId: client.clientId, clientSecret: client.clientSecret });
  auth.setCredentials({
    refresh_token: token.refreshToken,
    access_token: token.accessToken,
    expiry_date: token.expiryDate,
    scope: token.scope,
  });
  // Persist refreshed access tokens (and a rotated refresh token). Failures must not break the API call.
  auth.on('tokens', (t) => {
    void (async () => {
      try {
        const cur = await loadToken(alias);
        const refreshToken = t.refresh_token ?? cur?.refreshToken;
        if (!refreshToken) return;
        const accessToken = t.access_token ?? cur?.accessToken;
        const expiryDate = typeof t.expiry_date === 'number' ? t.expiry_date : cur?.expiryDate;
        await saveToken(alias, {
          refreshToken,
          ...(accessToken ? { accessToken } : {}),
          ...(typeof expiryDate === 'number' ? { expiryDate } : {}),
          scope: t.scope ?? cur?.scope ?? token.scope,
        });
        // Our own rotation must not look like a reconnect from elsewhere.
        entry.refreshToken = refreshToken;
      } catch {
        // ignored
      }
    })();
  });
  const entry: Cached = { api: factory(auth), email: account.email, refreshToken: token.refreshToken, sig };
  return entry;
}

function start(id: string): Promise<Cached> {
  const created = build(id);
  cache.set(id, created);
  // A failed build must not stay cached.
  created.catch(() => {
    if (cache.get(id) === created) cache.delete(id);
  });
  return created;
}

export async function getGmail(id: string): Promise<Entry> {
  const p = cache.get(id);
  if (!p) return start(id);
  const entry = await p;
  const sig = await tokenSig(id);
  if (sig === entry.sig) return entry;
  const token = await loadToken(id);
  if (token && token.refreshToken === entry.refreshToken) {
    entry.sig = sig;
    return entry;
  }
  // The token changed elsewhere (reconnect) or was removed: rebuild from the current files.
  const again = cache.get(id);
  return again && again !== p ? again : start(id);
}
