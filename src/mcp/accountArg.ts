import * as z from 'zod/v4';
import { accountNames, findAccount, loadConfig } from '../core/config.js';
import { friendly } from '../gmail/errors.js';

export const ACCOUNT_DESCRIPTION = 'Account name or email from list_accounts. Use "all" only where noted.';

export const accountParam = z.string().min(1).describe(ACCOUNT_DESCRIPTION);

export const ALL_NOT_ALLOWED = "This tool needs one account; 'all' is only for search_threads, list_labels, list_drafts.";

export type ResolvedAccount = { id: string; name: string };

// Maps a name, email (both case-insensitive) or id to configured accounts, in config order. `all` expands when allowed.
export async function resolveAccounts(
  arg: string,
  allowAll: boolean,
  load: typeof loadConfig = loadConfig,
): Promise<ResolvedAccount[]> {
  const cfg = await load();
  const all = Object.entries(cfg.accounts).map(([id, a]) => ({ id, name: a.name }));
  if (arg.trim().toLowerCase() === 'all') {
    if (!allowAll) throw friendly(ALL_NOT_ALLOWED);
    if (!all.length) throw friendly('No Gmail accounts are connected. Open multiple-gmail to add one.');
    return all;
  }
  const id = findAccount(cfg, arg);
  const hit = id ? all.find((a) => a.id === id) : undefined;
  if (hit) return [hit];
  if (!all.length) throw friendly('No Gmail accounts are connected. Open multiple-gmail to add one.');
  throw friendly(
    `Unknown account "${arg}". Available accounts: ${accountNames(cfg).join(', ')}. Call list_accounts for details.`,
  );
}
