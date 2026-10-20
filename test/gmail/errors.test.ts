import { beforeEach, describe, expect, it } from 'vitest';
import { friendly, getAccountStatus, setAccountStatus, toToolError } from '../../src/gmail/errors.js';

beforeEach(() => {
  setAccountStatus('personal', 'ok');
});

describe('toToolError', () => {
  it('maps invalid_grant to a reconnect message and marks needs_reauth', () => {
    const e = toToolError({ response: { data: { error: 'invalid_grant' } } }, 'personal');
    expect(e.message).toContain('Reconnect for personal');
    expect(e.message).toBe(
      'Account personal needs re-authorization: open multiple-gmail and click Reconnect for personal.',
    );
    expect(getAccountStatus('personal')).toBe('needs_reauth');
  });

  it('detects invalid_grant in the error message', () => {
    const e = toToolError(new Error('invalid_grant: Token has been expired or revoked.'), 'personal');
    expect(e.message).toContain('Reconnect for personal');
    expect(getAccountStatus('personal')).toBe('needs_reauth');
  });

  it('maps 429 and rateLimitExceeded', () => {
    expect(toToolError({ response: { status: 429 } }, 'personal').message).toBe(
      'Gmail rate limit for personal, retry in a minute.',
    );
    const r = toToolError(
      { code: 403, response: { status: 403, data: { error: { errors: [{ reason: 'rateLimitExceeded' }] } } } },
      'personal',
    );
    expect(r.message).toContain('rate limit');
    expect(getAccountStatus('personal')).toBe('ok');
  });

  it('maps 403 insufficient scope to reconnect', () => {
    const e = toToolError(
      {
        response: {
          status: 403,
          data: { error: { message: 'Request had insufficient authentication scopes.', errors: [{ reason: 'insufficientPermissions' }] } },
        },
      },
      'personal',
    );
    expect(e.message).toContain('Reconnect for personal');
    expect(getAccountStatus('personal')).toBe('needs_reauth');
  });

  it('wraps other errors with the alias and leaves status alone', () => {
    const e = toToolError({ response: { status: 404, data: { error: { message: 'Requested entity was not found.' } } } }, 'personal');
    expect(e.message).toBe('Gmail request failed for personal: Requested entity was not found.');
    expect(getAccountStatus('personal')).toBe('ok');
    expect(toToolError('weird', 'personal').message).toContain('personal');
  });

  it('keeps already-friendly errors unchanged', () => {
    const orig = friendly('Unknown account zeta');
    expect(toToolError(orig, 'zeta')).toBe(orig);
  });

  it('defaults status to ok for unknown aliases', () => {
    expect(getAccountStatus('never-seen')).toBe('ok');
  });
});
