import { gmail, type gmail_v1 } from '@googleapis/gmail';
import { OAuth2Client } from 'google-auth-library';
import { loadConfig } from '../core/config.js';
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
const cache = new Map<string, Promise<Entry>>();

// Drops cached clients (all, or one alias). Clearing an alias also resets its status: used after reconnect and remove.
export function clearGmailCache(alias?: string): void {
  if (alias === undefined) {
    cache.clear();
    return;
  }
  cache.delete(alias);
  setAccountStatus(alias, 'ok');
}

async function build(alias: string): Promise<Entry> {
  const cfg = await loadConfig();
  const account = cfg.accounts[alias];
  if (!account) throw friendly(`Unknown account ${alias}`);
  const client = await loadClient();
  if (!client) throw friendly('No Google OAuth client configured. Open multiple-gmail to finish setup.');
  const token = await loadToken(alias);
  if (!token) {
    setAccountStatus(alias, 'needs_reauth');
    throw friendly(reauthMessage(alias));
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
      } catch {
        // ignored
      }
    })();
  });
  return { api: factory(auth), email: account.email };
}

export function getGmail(alias: string): Promise<Entry> {
  let p = cache.get(alias);
  if (!p) {
    const created = build(alias);
    p = created;
    cache.set(alias, created);
    // A failed build must not stay cached.
    created.catch(() => {
      if (cache.get(alias) === created) cache.delete(alias);
    });
  }
  return p;
}
