import type { AccountStatus } from '../core/accounts.js';

// In-memory health of each account, shown in list_accounts and the setup UI.
const accountStatus = new Map<string, AccountStatus>();

export function getAccountStatus(alias: string): AccountStatus {
  return accountStatus.get(alias) ?? 'ok';
}

export function setAccountStatus(alias: string, status: AccountStatus): void {
  accountStatus.set(alias, status);
}

export function reauthMessage(alias: string): string {
  return `Account ${alias} needs re-authorization: open multiple-gmail and click Reconnect for ${alias}.`;
}

type Details = { status?: number; reasons: string[]; text: string };

const num = (v: unknown): number | undefined =>
  typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : undefined;

function details(e: unknown): Details {
  const err = e as {
    code?: unknown;
    message?: unknown;
    status?: unknown;
    response?: { status?: unknown; data?: unknown };
    errors?: { reason?: unknown }[];
  } | null;
  const reasons: string[] = [];
  const texts: string[] = [];
  let status = num(err?.response?.status) ?? num(err?.status) ?? num(err?.code);
  if (typeof err?.message === 'string') texts.push(err.message);
  const data = err?.response?.data as { error?: unknown; error_description?: unknown } | undefined;
  if (data && typeof data === 'object') {
    if (typeof data.error === 'string') {
      reasons.push(data.error);
      texts.push(data.error);
    } else if (data.error && typeof data.error === 'object') {
      const o = data.error as { code?: unknown; message?: unknown; errors?: { reason?: unknown }[] };
      status = status ?? num(o.code);
      if (typeof o.message === 'string') texts.push(o.message);
      for (const x of o.errors ?? []) if (typeof x.reason === 'string') reasons.push(x.reason);
    }
    if (typeof data.error_description === 'string') texts.push(data.error_description);
  }
  for (const x of err?.errors ?? []) if (typeof x.reason === 'string') reasons.push(x.reason);
  return { status, reasons, text: texts.join(' ') };
}

// Marks an error whose message is already written for the AI, so toToolError passes it through.
export function friendly(msg: string): Error {
  return Object.assign(new Error(msg), { mgFriendly: true });
}

// Maps a googleapis/gaxios failure to an error whose message tells the AI what to do. Never includes request data.
export function toToolError(e: unknown, alias: string): Error {
  if (e instanceof Error && (e as Error & { mgFriendly?: boolean }).mgFriendly) return e;
  const d = details(e);
  const has = (r: string) => d.reasons.includes(r);

  if (has('invalid_grant') || /invalid_grant/.test(d.text)) {
    setAccountStatus(alias, 'needs_reauth');
    return friendly(reauthMessage(alias));
  }
  if (d.status === 429 || has('rateLimitExceeded') || has('userRateLimitExceeded')) {
    return friendly(`Gmail rate limit for ${alias}, retry in a minute.`);
  }
  if (
    (d.status === 403 && (has('insufficientPermissions') || /insufficient[^.]*scope/i.test(d.text))) ||
    d.status === 401
  ) {
    setAccountStatus(alias, 'needs_reauth');
    return friendly(reauthMessage(alias));
  }
  const reason = d.text.trim() || 'unexpected error';
  return friendly(`Gmail request failed for ${alias}: ${reason.slice(0, 300)}`);
}
