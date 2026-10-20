import { loadConfig, saveConfig, validateAlias } from './config.js';
import { deleteToken, loadToken, type StoredToken } from './secrets.js';

export type ConnectedAccount = { alias: string; email: string };

// Typed setup errors so callers branch on code, not on message text.
export type AccountErrorCode = 'no_client' | 'alias_exists' | 'unknown_alias';
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
export async function removeAccount(alias: string, deps: RemoveDeps = {}): Promise<{ revoked: boolean }> {
  const a = validateAlias(alias);
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
  if (!cfg.accounts[a] && !token && !tokenUnreadable) {
    throw new AccountError('unknown_alias', `No account named "${a}".`);
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
  const fresh = await loadConfig();
  if (fresh.accounts[a] || fresh.defaultAccount === a) {
    delete fresh.accounts[a];
    if (fresh.defaultAccount === a) fresh.defaultAccount = null;
    await saveConfig(fresh);
  }
  return { revoked };
}
