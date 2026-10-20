import { describe, expect, it } from 'vitest';
import { SessionStore, SESSION_COOKIE } from '../../src/http/session.js';

describe('SessionStore', () => {
  it('launch tokens are single use and expire after 2 minutes', () => {
    let now = 0;
    const s = new SessionStore(() => now);
    const a = s.createLaunchToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(s.consumeLaunchToken(a)).toBe(true);
    expect(s.consumeLaunchToken(a)).toBe(false);
    const b = s.createLaunchToken();
    now = 120_001;
    expect(s.consumeLaunchToken(b)).toBe(false);
    expect(s.consumeLaunchToken('')).toBe(false);
  });

  it('sessions are recognized from the cookie header only when issued', () => {
    const s = new SessionStore();
    const id = s.createSession();
    expect(s.hasSession(`other=1; ${SESSION_COOKIE}=${id}`)).toBe(true);
    expect(s.hasSession(`${SESSION_COOKIE}=${id}x`)).toBe(false);
    expect(s.hasSession(undefined)).toBe(false);
    expect(s.cookieFor(id)).toBe(`${SESSION_COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/`);
  });
});
