import { loadConfig, saveConfig, NameError, getAccount, validateId, validateName, withConfigLock } from './config.js';
import { deleteToken, loadToken, type StoredToken } from './secrets.js';

export type ConnectedAccount = { id: string; name: string; email: string };

// Typed setup errors so callers branch on code, not on message text.
export type AccountErrorCode = 'no_client' | 'name_exists' | 'unknown_account' | 'invalid_name';
export class AccountError extends Error {
  readonly code: AccountErrorCode;
  constructor(code: AccountErrorCode, message: string) {
    super(message);
    this.name = 'AccountError';
    this.code = code;
  }
}

export type AccountStatus = 'ok' | 'needs_reauth' | 'error';

export const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

export type RemoveDeps = { fetch?: typeof fetch };

// Revokes the grant at Google (failure tolerated and reported), then always deletes the local token and config entry.
export async function removeAccount(id: string, deps: RemoveDeps = {}): Promise<{ revoked: boolean }> {
  const a = validateId(id);
  const doFetch = deps.fetch ?? fetch;
  const cfg = await loadConfig();
  let token: StoredToken | null = null;
  let tokenUnreadable = false;
  try {
    token = await loadToken(a);
  } catch {
    // A corrupt or undecryptable token file must not block local removal.
    tokenUnreadable = true;
  }
  if (!getAccount(cfg, a) && !token && !tokenUnreadable) {
    throw new AccountError('unknown_account', `No account with id "${a}".`);
  }

  let revoked = false;
  const secret = token?.refreshToken || token?.accessToken;
  if (secret) {
    try {
      const res = await doFetch(REVOKE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: secret }).toString(),
        signal: AbortSignal.timeout(15_000),
      });
      revoked = res.ok;
    } catch {
      revoked = false;
    }
  }

  await deleteToken(a);
  await withConfigLock(async () => {
    const fresh = await loadConfig();
    if (getAccount(fresh, a) || fresh.defaultAccount === a) {
      delete fresh.accounts[a];
      if (fresh.defaultAccount === a) fresh.defaultAccount = null;
      await saveConfig(fresh);
    }
  });
  return { revoked };
}

// Changes the display name only; the id (token file, caches) stays.
export function renameAccount(id: string, newName: string): Promise<ConnectedAccount> {
  return withConfigLock(() => renameLocked(id, newName));
}

async function renameLocked(id: string, newName: string): Promise<ConnectedAccount> {
  const cfg = await loadConfig();
  const entry = getAccount(cfg, id);
  if (!entry) throw new AccountError('unknown_account', `No account with id "${id}".`);
  let name: string;
  try {
    name = validateName(newName, cfg, id);
  } catch (e) {
    if (!(e instanceof NameError)) throw e;
    throw new AccountError(e.code === 'taken' ? 'name_exists' : 'invalid_name', e.message);
  }
  cfg.accounts[id] = { ...entry, name };
  await saveConfig(cfg);
  return { id, name, email: entry.email };
}
