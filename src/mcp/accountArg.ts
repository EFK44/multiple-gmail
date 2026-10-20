import * as z from 'zod/v4';
import { loadConfig } from '../core/config.js';
import { friendly } from '../gmail/errors.js';

export const ACCOUNT_DESCRIPTION = 'Alias or email from list_accounts. Use "all" only where noted.';

export const accountParam = z.string().min(1).describe(ACCOUNT_DESCRIPTION);

export const ALL_NOT_ALLOWED = "This tool needs one account; 'all' is only for search_threads, list_labels, list_drafts.";

// Maps an alias or email (case-insensitive) to configured aliases, in config order. `all` expands when allowed.
export async function resolveAccounts(
  arg: string,
  allowAll: boolean,
  load: typeof loadConfig = loadConfig,
): Promise<string[]> {
  const cfg = await load();
  const aliases = Object.keys(cfg.accounts);
  const wanted = arg.trim().toLowerCase();
  if (wanted === 'all') {
    if (!allowAll) throw friendly(ALL_NOT_ALLOWED);
    if (!aliases.length) throw friendly('No Gmail accounts are connected. Open multiple-gmail to add one.');
    return aliases;
  }
  const hit =
    aliases.find((a) => a.toLowerCase() === wanted) ??
    aliases.find((a) => cfg.accounts[a].email.toLowerCase() === wanted);
  if (hit) return [hit];
  if (!aliases.length) throw friendly('No Gmail accounts are connected. Open multiple-gmail to add one.');
  throw friendly(`Unknown account "${arg}". Available accounts: ${aliases.join(', ')}. Call list_accounts for details.`);
}
