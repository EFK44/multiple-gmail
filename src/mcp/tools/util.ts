import type { CallToolResult } from '@modelcontextprotocol/server';
import type { gmail_v1 } from '@googleapis/gmail';
import type { loadConfig } from '../../core/config.js';
import type { GmailApi, getGmail } from '../../gmail/client.js';
import { friendly, toToolError } from '../../gmail/errors.js';
import type { MessageFormat } from '../../gmail/shape.js';
import { resolveAccounts } from '../accountArg.js';

export type Deps = { getGmail: typeof getGmail; loadConfig: typeof loadConfig };
export type Account = { alias: string; api: GmailApi; email: string };

export function ok(data: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 1) }], structuredContent: data };
}

export function fail(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

// Runs a tool body. Errors become isError results; only messages are exposed, never error objects.
export async function run(fn: () => Promise<Record<string, unknown>>): Promise<CallToolResult> {
  try {
    return ok(await fn());
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'unexpected error';
    return fail(msg.slice(0, 500) || 'unexpected error');
  }
}

// Opens one account and runs `fn` on it; any failure is mapped by toToolError so raw googleapis errors never escape.
export async function withAccount<T>(deps: Deps, alias: string, fn: (a: Account) => Promise<T>): Promise<T> {
  try {
    const { api, email } = await deps.getGmail(alias);
    return await fn({ alias, api, email });
  } catch (e) {
    throw toToolError(e, alias);
  }
}

export async function oneAccount<T>(deps: Deps, arg: string, fn: (a: Account) => Promise<T>): Promise<T> {
  const [alias] = await resolveAccounts(arg, false, deps.loadConfig);
  return withAccount(deps, alias, fn);
}

// Single account: `{ account, ...result }`. `all`: accounts in parallel, config order, failures listed in `errors`.
export async function fanOut(
  deps: Deps,
  arg: string,
  pageToken: string | undefined,
  fn: (a: Account) => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const aliases = await resolveAccounts(arg, true, deps.loadConfig);
  if (arg.trim().toLowerCase() !== 'all') {
    const alias = aliases[0];
    return { account: alias, ...(await withAccount(deps, alias, fn)) };
  }
  if (pageToken) {
    throw friendly('pageToken cannot be used with account "all"; page further with a single account.');
  }
  const settled = await Promise.allSettled(aliases.map((alias) => withAccount(deps, alias, fn)));
  const results: Record<string, unknown>[] = [];
  const errors: { account: string; message: string }[] = [];
  settled.forEach((s, i) => {
    if (s.status === 'fulfilled') results.push({ account: aliases[i], ...s.value });
    else errors.push({ account: aliases[i], message: s.reason instanceof Error ? s.reason.message : 'unexpected error' });
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
