import type { CallToolResult } from '@modelcontextprotocol/server';
import type { gmail_v1 } from '@googleapis/gmail';
import type { loadConfig } from '../../core/config.js';
import type { GmailApi, getGmail } from '../../gmail/client.js';
import { friendly, toToolError } from '../../gmail/errors.js';
import type { MessageFormat } from '../../gmail/shape.js';
import { resolveAccounts, type ResolvedAccount } from '../accountArg.js';

export type Deps = { getGmail: typeof getGmail; loadConfig: typeof loadConfig };
// `id` is internal (token file, caches); `name` is what tool output shows.
export type Account = { id: string; name: string; api: GmailApi; email: string };

export function ok(data: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 1) }], structuredContent: data };
}

export function fail(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

export const INTERNAL_ERROR = 'Internal error in multiple-gmail; see the app console for details.';

const isFriendly = (e: unknown): e is Error =>
  e instanceof Error && (e as Error & { mgFriendly?: boolean }).mgFriendly === true;

// Runs a tool body. Errors become isError results. Only messages written for the AI are exposed; anything else
// (fs or config failures that may name local paths) is logged to stderr and replaced by a generic message.
export async function run(fn: () => Promise<Record<string, unknown>>): Promise<CallToolResult> {
  try {
    return ok(await fn());
  } catch (e) {
    return fail(safeMessage(e));
  }
}

// HTTP status of a googleapis/gaxios error, if any.
export function httpStatus(e: unknown): number | undefined {
  const err = e as { response?: { status?: unknown }; status?: unknown; code?: unknown } | null;
  for (const v of [err?.response?.status, err?.status, err?.code]) {
    if (typeof v === 'number') return v;
    if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v);
  }
  return undefined;
}

// Opens one account and runs `fn` on it; any failure is mapped by toToolError so raw googleapis errors never escape.
export async function withAccount<T>(deps: Deps, acct: ResolvedAccount, fn: (a: Account) => Promise<T>): Promise<T> {
  const { id, name } = acct;
  try {
    const { api, email } = await deps.getGmail(id);
    return await fn({ id, name, api, email });
  } catch (e) {
    // Local failures (fs, config, our own bugs) are not Gmail errors: leave them for run() to log and hide.
    if (isNetworkError(e)) throw friendly(`Could not reach Gmail for ${name}. Check the internet connection and try again.`);
    if (!isFriendly(e) && !isGoogleError(e)) throw e;
    throw toToolError(e, id, name);
  }
}

const NETWORK_CODES = new Set(['ENOTFOUND', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNREFUSED']);

// Network-level failure (DNS, reset, timeout, refused), possibly wrapped in `cause`.
function isNetworkError(e: unknown): boolean {
  for (let cur = e, i = 0; cur && typeof cur === 'object' && i < 4; i++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === 'string' && NETWORK_CODES.has(code)) return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

// A googleapis/gaxios or google-auth-library failure: it carries an HTTP status or a response.
function isGoogleError(e: unknown): boolean {
  return httpStatus(e) !== undefined || !!(e as { response?: unknown } | null)?.response;
}

// The message an error may show to the AI; anything not written for it is logged and replaced.
export function safeMessage(e: unknown): string {
  if (isFriendly(e)) return e.message.slice(0, 500) || 'unexpected error';
  console.error('multiple-gmail tool error:', e instanceof Error ? (e.stack ?? e.message) : String(e));
  return INTERNAL_ERROR;
}

export async function oneAccount<T>(deps: Deps, arg: string, fn: (a: Account) => Promise<T>): Promise<T> {
  const [acct] = await resolveAccounts(arg, false, deps.loadConfig);
  return withAccount(deps, acct, fn);
}

// Single account: `{ account, ...result }`. `all`: accounts in parallel, config order, failures listed in `errors`.
export async function fanOut(
  deps: Deps,
  arg: string,
  pageToken: string | undefined,
  fn: (a: Account) => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const accts = await resolveAccounts(arg, true, deps.loadConfig);
  if (arg.trim().toLowerCase() !== 'all') {
    const acct = accts[0];
    return { account: acct.name, ...(await withAccount(deps, acct, fn)) };
  }
  if (pageToken) {
    throw friendly('pageToken cannot be used with account "all"; page further with a single account.');
  }
  const settled = await Promise.allSettled(accts.map((acct) => withAccount(deps, acct, fn)));
  const results: Record<string, unknown>[] = [];
  const errors: { account: string; message: string }[] = [];
  settled.forEach((s, i) => {
    if (s.status === 'fulfilled') results.push({ account: accts[i].name, ...s.value });
    else errors.push({ account: accts[i].name, message: safeMessage(s.reason) });
  });
  return { results, errors };
}

// Maps items with at most `limit` calls in flight, keeping order.
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export function apiFormat(f: MessageFormat): 'minimal' | 'metadata' | 'full' {
  return f === 'MINIMAL' ? 'minimal' : f === 'METADATA_ONLY' ? 'metadata' : 'full';
}

export const notDraft = (m: gmail_v1.Schema$Message): boolean => !(m.labelIds ?? []).includes('DRAFT');

export const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
