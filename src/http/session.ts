import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'mg_session';
export const LAUNCH_TOKEN_TTL_MS = 2 * 60 * 1000;
const MAX_LAUNCH_TOKENS = 32;

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

// In-memory launch tokens (one-time, 2 min) and browser sessions. Only digests are stored.
export class SessionStore {
  private launch = new Map<Buffer, number>();
  private sessions = new Set<Buffer>();

  constructor(private readonly now: () => number = Date.now) {}

  createLaunchToken(): string {
    this.prune();
    if (this.launch.size >= MAX_LAUNCH_TOKENS) {
      const oldest = this.launch.keys().next().value;
      if (oldest) this.launch.delete(oldest);
    }
    const token = newSecret();
    this.launch.set(digest(token), this.now() + LAUNCH_TOKEN_TTL_MS);
    return token;
  }

  consumeLaunchToken(token: string): boolean {
    if (!token) return false;
    this.prune();
    const hit = findDigest(this.launch.keys(), token);
    if (!hit) return false;
    this.launch.delete(hit);
    return true;
  }

  createSession(): string {
    const id = newSecret();
    this.sessions.add(digest(id));
    return id;
  }

  cookieFor(id: string): string {
    return `${SESSION_COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/`;
  }

  hasSession(cookieHeader: string | undefined): boolean {
    const id = readCookie(cookieHeader, SESSION_COOKIE);
    if (!id) return false;
    return findDigest(this.sessions, id) !== undefined;
  }

  private prune(): void {
    const t = this.now();
    for (const [k, exp] of this.launch) if (exp < t) this.launch.delete(k);
  }
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}
