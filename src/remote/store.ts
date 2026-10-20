import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { dataDir } from '../core/paths.js';
import { readSealed, writeSealed } from '../core/secrets.js';

// Registered OAuth clients and issued tokens for remote mode. Tokens are opaque random values; only their SHA-256
// digests are kept, sealed (AES-256-GCM with the master key) in remote-tokens.enc. Deleting that file revokes every
// token and forgets every client.

export const MAX_CLIENTS = 50;
export const ACCESS_TTL_MS = 60 * 60 * 1000;
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_TOKENS = 1000;
const FILE = 'remote-tokens.enc';

export type ClientRecord = {
  clientId: string;
  clientName?: string;
  redirectUris: string[];
  createdAt: number;
};

type AccessRecord = { hash: string; clientId: string; family: string; exp: number; resource: string; scope: string };
type RefreshRecord = AccessRecord & { used: boolean };

type FileShape = { v: 1; clients: ClientRecord[]; access: AccessRecord[]; refresh: RefreshRecord[] };

export type IssuedTokens = { accessToken: string; refreshToken: string; expiresIn: number; scope: string; family: string };

export type RotateResult =
  | { kind: 'ok'; tokens: IssuedTokens }
  // Unknown, expired, revoked, or bound to another client.
  | { kind: 'invalid' }
  // An already rotated token came back: its family is revoked.
  | { kind: 'reused' };

const newToken = () => randomBytes(32).toString('base64url');
export const digestHex = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

export class RemoteStore {
  private clients = new Map<string, ClientRecord>();
  private access = new Map<string, AccessRecord>();
  private refresh = new Map<string, RefreshRecord>();
  private saving: Promise<void> = Promise.resolve();

  private constructor(private readonly now: () => number) {}

  static async open(now: () => number = Date.now): Promise<RemoteStore> {
    const store = new RemoteStore(now);
    const buf = await readSealed(join(dataDir(), FILE));
    if (buf) {
      const data = JSON.parse(buf.toString('utf8')) as Partial<FileShape>;
      for (const c of data.clients ?? []) store.clients.set(c.clientId, c);
      for (const a of data.access ?? []) store.access.set(a.hash, a);
      for (const r of data.refresh ?? []) store.refresh.set(r.hash, r);
    }
    store.prune();
    return store;
  }

  private prune(): void {
    const t = this.now();
    for (const [k, a] of this.access) if (a.exp <= t) this.access.delete(k);
    for (const [k, r] of this.refresh) if (r.exp <= t) this.refresh.delete(k);
    // Oldest first (insertion order) when over the cap.
    for (const map of [this.access, this.refresh] as Map<string, AccessRecord>[]) {
      while (map.size > MAX_TOKENS) {
        const oldest = map.keys().next().value;
        if (oldest === undefined) break;
        map.delete(oldest);
      }
    }
  }

  // Serialized, and awaited by callers so a token is on disk before it is handed out.
  private persist(): Promise<void> {
    this.prune();
    const data: FileShape = {
      v: 1,
      clients: [...this.clients.values()],
      access: [...this.access.values()],
      refresh: [...this.refresh.values()],
    };
    const body = Buffer.from(JSON.stringify(data), 'utf8');
    const next = this.saving.then(() => writeSealed(join(dataDir(), FILE), body));
    this.saving = next.catch(() => {});
    return next;
  }

  getClient(clientId: string): ClientRecord | undefined {
    return this.clients.get(clientId);
  }

  private hasLiveTokens(clientId: string): boolean {
    const t = this.now();
    for (const r of this.refresh.values()) if (r.clientId === clientId && !r.used && r.exp > t) return true;
    for (const a of this.access.values()) if (a.clientId === clientId && a.exp > t) return true;
    return false;
  }

  // Returns null when MAX_CLIENTS clients exist and every one of them still holds live tokens.
  async registerClient(meta: { clientName?: string; redirectUris: string[] }): Promise<ClientRecord | null> {
    this.prune();
    if (this.clients.size >= MAX_CLIENTS) {
      const idle = [...this.clients.values()].find((c) => !this.hasLiveTokens(c.clientId));
      if (!idle) return null;
      this.clients.delete(idle.clientId);
    }
    const rec: ClientRecord = {
      clientId: randomBytes(18).toString('base64url'),
      ...(meta.clientName ? { clientName: meta.clientName } : {}),
      redirectUris: [...meta.redirectUris],
      createdAt: Math.floor(this.now() / 1000),
    };
    this.clients.set(rec.clientId, rec);
    await this.persist();
    return rec;
  }

  private mint(clientId: string, resource: string, scope: string, family: string): IssuedTokens {
    const t = this.now();
    const accessToken = newToken();
    const refreshToken = newToken();
    this.access.set(digestHex(accessToken), { hash: digestHex(accessToken), clientId, family, exp: t + ACCESS_TTL_MS, resource, scope });
    this.refresh.set(digestHex(refreshToken), {
      hash: digestHex(refreshToken),
      clientId,
      family,
      exp: t + REFRESH_TTL_MS,
      resource,
      scope,
      used: false,
    });
    return { accessToken, refreshToken, expiresIn: ACCESS_TTL_MS / 1000, scope, family };
  }

  async issueTokens(a: { clientId: string; resource: string; scope: string }): Promise<IssuedTokens> {
    const tokens = this.mint(a.clientId, a.resource, a.scope, randomBytes(16).toString('base64url'));
    await this.persist();
    return tokens;
  }

  verifyAccess(token: string): { clientId: string; exp: number; resource: string; scope: string } | null {
    const rec = this.access.get(digestHex(token));
    if (!rec || rec.exp <= this.now()) return null;
    if (!this.clients.has(rec.clientId)) return null;
    return { clientId: rec.clientId, exp: rec.exp, resource: rec.resource, scope: rec.scope };
  }

  async rotateRefresh(token: string, clientId: string): Promise<RotateResult> {
    const rec = this.refresh.get(digestHex(token));
    if (!rec || rec.exp <= this.now() || !this.clients.has(rec.clientId)) return { kind: 'invalid' };
    if (rec.used) {
      await this.revokeFamily(rec.family);
      return { kind: 'reused' };
    }
    if (rec.clientId !== clientId) return { kind: 'invalid' };
    // Kept (marked used) until it expires so a replay is recognized and revokes the family.
    rec.used = true;
    const tokens = this.mint(rec.clientId, rec.resource, rec.scope, rec.family);
    await this.persist();
    return { kind: 'ok', tokens };
  }

  async revokeFamily(family: string): Promise<void> {
    for (const [k, a] of this.access) if (a.family === family) this.access.delete(k);
    for (const [k, r] of this.refresh) if (r.family === family) this.refresh.delete(k);
    await this.persist();
  }

  // RFC 7009: an access or refresh token revokes its whole family; an unknown token is ignored.
  async revokeToken(token: string): Promise<void> {
    if (!token) return;
    const d = digestHex(token);
    const rec = this.access.get(d) ?? this.refresh.get(d);
    if (rec) await this.revokeFamily(rec.family);
  }

  // Waits for pending writes (shutdown, tests).
  async flush(): Promise<void> {
    await this.saving;
  }
}
