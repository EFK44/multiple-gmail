import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { ExpiringDigests, readCookie } from '../http/session.js';

// ---------- password hashing (scrypt) ----------

export const MIN_PASSWORD_LENGTH = 12;
const DEFAULT = { N: 2 ** 15, r: 8, p: 1 };
const KEY_LEN = 32;
const SALT_LEN = 16;
// Bounds for parameters read from ADMIN_PASSWORD_HASH: weak enough to be useless, or heavy enough to stall the server.
const N_MIN = 2 ** 14;
const N_MAX = 2 ** 20;
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;

export type PasswordHash = { N: number; r: number; p: number; salt: Buffer; hash: Buffer };

function scryptAsync(password: string, salt: Buffer, len: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password, salt, len, opts, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

const maxmem = (N: number, r: number, p: number) => 128 * N * r * (p + 1) + 1024 * 1024;

export async function hashPassword(password: string): Promise<string> {
  const { N, r, p } = DEFAULT;
  const salt = randomBytes(SALT_LEN);
  const hash = await scryptAsync(password, salt, KEY_LEN, { N, r, p, maxmem: maxmem(N, r, p) });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

const HASH_HELP = 'ADMIN_PASSWORD_HASH is invalid. Create one with: multiple-gmail hash-password';

export function parsePasswordHash(value: string): PasswordHash {
  const parts = value.trim().split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') throw new Error(HASH_HELP);
  const [N, r, p] = parts.slice(1, 4).map((x) => (/^\d{1,10}$/.test(x) ? Number(x) : NaN));
  const powerOfTwo = Number.isInteger(N) && N > 1 && (N & (N - 1)) === 0;
  if (!powerOfTwo || N < N_MIN || N > N_MAX) throw new Error(`${HASH_HELP} (N out of range)`);
  if (!(r >= 1 && r <= 32) || !(p >= 1 && p <= 4)) throw new Error(`${HASH_HELP} (r or p out of range)`);
  if (!B64.test(parts[4]) || !B64.test(parts[5])) throw new Error(HASH_HELP);
  const salt = Buffer.from(parts[4], 'base64');
  const hash = Buffer.from(parts[5], 'base64');
  if (salt.length < 16 || hash.length < 16 || hash.length > 64) throw new Error(HASH_HELP);
  return { N, r, p, salt, hash };
}

// Always runs the full scrypt and compares in constant time.
export async function verifyPassword(password: string, h: PasswordHash): Promise<boolean> {
  if (typeof password !== 'string' || password.length === 0 || password.length > 1024) {
    // Still spend the time so a length check does not answer faster.
    await scryptAsync('x', h.salt, h.hash.length, { N: h.N, r: h.r, p: h.p, maxmem: maxmem(h.N, h.r, h.p) });
    return false;
  }
  const got = await scryptAsync(password, h.salt, h.hash.length, { N: h.N, r: h.r, p: h.p, maxmem: maxmem(h.N, h.r, h.p) });
  return timingSafeEqual(got, h.hash);
}

// ---------- failed-login rate limiting ----------

export const MAX_FAILURES = 5;
export const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const MAX_TRACKED_IPS = 10_000;

// Sliding window of timestamps per key (an IP). blocked() is true once `limit` events sit inside the window.
export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  private live(key: string): number[] {
    const t = this.now();
    const list = (this.hits.get(key) ?? []).filter((x) => t - x < this.windowMs);
    if (list.length) this.hits.set(key, list);
    else this.hits.delete(key);
    return list;
  }

  blocked(key: string): boolean {
    return this.live(key).length >= this.limit;
  }

  // Seconds until the oldest event leaves the window.
  retryAfter(key: string): number {
    const list = this.live(key);
    if (!list.length) return 0;
    return Math.max(1, Math.ceil((list[0] + this.windowMs - this.now()) / 1000));
  }

  record(key: string): void {
    const list = this.live(key);
    list.push(this.now());
    this.hits.delete(key);
    this.hits.set(key, list);
    while (this.hits.size > MAX_TRACKED_IPS) {
      const oldest = this.hits.keys().next().value;
      if (oldest === undefined) break;
      this.hits.delete(oldest);
    }
  }
}

// Client address for rate limiting. Behind a reverse proxy (TRUST_PROXY=1) the rightmost X-Forwarded-For entry is
// the address the proxy itself saw; entries left of it are client-supplied and can be forged.
export function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    const value = Array.isArray(xff) ? xff.join(',') : xff;
    const last = value?.split(',').map((s) => s.trim()).filter(Boolean).pop();
    if (last) return last.slice(0, 64);
  }
  return req.socket.remoteAddress ?? 'unknown';
}

// ---------- admin sessions ----------

export const ADMIN_COOKIE = '__Host-mg_admin';
// Lax companion cookie: Google's redirect back to /oauth/google/callback is a cross-site navigation, which never
// carries a SameSite=Strict cookie. It authorizes nothing but that callback.
export const ADMIN_CB_COOKIE = '__Host-mg_admin_cb';
export const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const CSRF_TTL_MS = 15 * 60 * 1000;

const secret = () => randomBytes(32).toString('base64url');

export class AdminSessions {
  private sessions: ExpiringDigests;
  private callbacks: ExpiringDigests;
  private csrf: ExpiringDigests;

  constructor(now: () => number = Date.now) {
    this.sessions = new ExpiringDigests(now, 16);
    this.callbacks = new ExpiringDigests(now, 16);
    this.csrf = new ExpiringDigests(now, 500);
  }

  create(): { cookies: string[] } {
    const id = secret();
    const cb = secret();
    this.sessions.add(id, ADMIN_SESSION_TTL_MS);
    this.callbacks.add(cb, ADMIN_SESSION_TTL_MS);
    // Session cookies (no Max-Age): the browser drops them on close, the server expires them after 12 h idle.
    return {
      cookies: [
        `${ADMIN_COOKIE}=${id}; Path=/; Secure; HttpOnly; SameSite=Strict`,
        `${ADMIN_CB_COOKIE}=${cb}; Path=/; Secure; HttpOnly; SameSite=Lax`,
      ],
    };
  }

  has(cookieHeader: string | undefined): boolean {
    const id = readCookie(cookieHeader, ADMIN_COOKIE);
    if (!id) return false;
    const hit = this.sessions.find(id);
    if (!hit) return false;
    this.sessions.touch(hit, ADMIN_SESSION_TTL_MS);
    // The callback cookie slides with the session it was issued with.
    const cb = readCookie(cookieHeader, ADMIN_CB_COOKIE);
    const cbHit = cb ? this.callbacks.find(cb) : undefined;
    if (cbHit) this.callbacks.touch(cbHit, ADMIN_SESSION_TTL_MS);
    return true;
  }

  hasCallback(cookieHeader: string | undefined): boolean {
    const id = readCookie(cookieHeader, ADMIN_CB_COOKIE);
    return !!id && !!this.callbacks.find(id);
  }

  destroy(cookieHeader: string | undefined): string[] {
    const id = readCookie(cookieHeader, ADMIN_COOKIE);
    const cb = readCookie(cookieHeader, ADMIN_CB_COOKIE);
    if (id) {
      const hit = this.sessions.find(id);
      if (hit) this.sessions.delete(hit);
    }
    if (cb) {
      const hit = this.callbacks.find(cb);
      if (hit) this.callbacks.delete(hit);
    }
    return [
      `${ADMIN_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`,
      `${ADMIN_CB_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`,
    ];
  }

  createCsrf(): string {
    const t = secret();
    this.csrf.add(t, CSRF_TTL_MS);
    return t;
  }

  // Single use.
  consumeCsrf(token: string): boolean {
    const hit = this.csrf.find(token);
    if (!hit) return false;
    this.csrf.delete(hit);
    return true;
  }
}

// Bounds concurrent scrypt runs (each one takes about 32 MB and tens of milliseconds).
export class Semaphore {
  private active = 0;
  constructor(private readonly max: number) {}
  tryAcquire(): (() => void) | null {
    if (this.active >= this.max) return null;
    this.active++;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.active--;
      }
    };
  }
}
