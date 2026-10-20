import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'mg_session';
export const LAUNCH_TOKEN_TTL_MS = 2 * 60 * 1000;
export const SESSION_IDLE_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_LAUNCH_TOKENS = 32;
const MAX_SESSIONS = 64;

const newSecret = () => randomBytes(32).toString('base64url');
const digest = (s: string) => createHash('sha256').update(s, 'utf8').digest();

// Compares fixed-length digests in constant time, visiting every entry so the position of a match does not leak.
function findDigest(entries: Iterable<Buffer>, candidate: string): Buffer | undefined {
  const d = digest(candidate);
  let found: Buffer | undefined;
  for (const e of entries) {
    if (timingSafeEqual(e, d)) found = e;
  }
  return found;
}

export function constantTimeEqual(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

// Map with expiry per entry and a size cap (oldest inserted is evicted first). Keys are digests.
class ExpiringDigests {
  private map = new Map<Buffer, number>();
  constructor(
    private readonly now: () => number,
    private readonly cap: number,
  ) {}

  add(secret: string, ttlMs: number): void {
    this.prune();
    while (this.map.size >= this.cap) {
      const oldest = this.map.keys().next().value;
      if (!oldest) break;
      this.map.delete(oldest);
    }
    this.map.set(digest(secret), this.now() + ttlMs);
  }

  // Returns the stored key on a live match.
  find(secret: string): Buffer | undefined {
    if (!secret) return undefined;
    this.prune();
    return findDigest(this.map.keys(), secret);
  }

  delete(key: Buffer): void {
    this.map.delete(key);
  }

  // Refresh expiry and move to the newest position.
  touch(key: Buffer, ttlMs: number): void {
    this.map.delete(key);
    this.map.set(key, this.now() + ttlMs);
  }

  private prune(): void {
    const t = this.now();
    for (const [k, exp] of this.map) if (exp < t) this.map.delete(k);
  }
}

// In-memory launch tokens (one-time, 2 min), browser sessions (12 h idle, at most 64), and second-instance
// handshake nonces. Only digests are stored.
export class SessionStore {
  private launch: ExpiringDigests;
  private sessions: ExpiringDigests;

  constructor(now: () => number = Date.now) {
    this.launch = new ExpiringDigests(now, MAX_LAUNCH_TOKENS);
    this.sessions = new ExpiringDigests(now, MAX_SESSIONS);
  }

  createLaunchToken(): string {
    const token = newSecret();
    this.launch.add(token, LAUNCH_TOKEN_TTL_MS);
    return token;
  }

  consumeLaunchToken(token: string): boolean {
    const hit = this.launch.find(token);
    if (!hit) return false;
    this.launch.delete(hit);
    return true;
  }

  createSession(): string {
    const id = newSecret();
    this.sessions.add(id, SESSION_IDLE_TTL_MS);
    return id;
  }

  cookieFor(id: string): string {
    return `${SESSION_COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/`;
  }

  hasSession(cookieHeader: string | undefined): boolean {
    const id = readCookie(cookieHeader, SESSION_COOKIE);
    if (!id) return false;
    const hit = this.sessions.find(id);
    if (!hit) return false;
    this.sessions.touch(hit, SESSION_IDLE_TTL_MS);
    return true;
  }
}

export { ExpiringDigests };

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}
