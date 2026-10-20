import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { ExpiringDigests } from './session.js';

// Mutual HMAC challenge-response between a second exe instance and the running server. Both sides prove they
// know the local API key without sending it (or anything replayable) over the wire, so a process squatting the
// port learns nothing usable.

export const NONCE_TTL_MS = 30_000;
const MAX_NONCES = 16;
const NONCE_RE = /^[A-Za-z0-9_-]{43}$/;

export const newNonce = () => randomBytes(32).toString('base64url');
export const isNonce = (v: unknown): v is string => typeof v === 'string' && NONCE_RE.test(v);

const hmac = (key: string, msg: string) => createHmac('sha256', key).update(msg, 'utf8').digest('base64url');

// The port is bound into both messages so a proof captured on one port cannot be replayed against another.
export const serverProof = (key: string, port: number, nonceC: string, nonceS: string) =>
  hmac(key, `server|${port}|${nonceC}|${nonceS}`);
export const clientProof = (key: string, port: number, nonceS: string, nonceC: string) =>
  hmac(key, `client|${port}|${nonceS}|${nonceC}`);

export function proofEqual(a: unknown, b: string): boolean {
  if (typeof a !== 'string') return false;
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

// Server side: issues single-use nonceS values (30 s, at most 16 outstanding) and remembers the nonceC each
// one was issued for.
export class HandshakeStore {
  private nonces: ExpiringDigests;
  private clientNonce = new Map<string, string>();

  constructor(now: () => number = Date.now) {
    this.nonces = new ExpiringDigests(now, MAX_NONCES);
  }

  challenge(key: string, port: number, nonceC: string): { nonceS: string; proof: string } {
    const nonceS = newNonce();
    this.nonces.add(nonceS, NONCE_TTL_MS);
    this.clientNonce.set(nonceS, nonceC);
    if (this.clientNonce.size > MAX_NONCES * 2) {
      const oldest = this.clientNonce.keys().next().value;
      if (oldest) this.clientNonce.delete(oldest);
    }
    return { nonceS, proof: serverProof(key, port, nonceC, nonceS) };
  }

  // Consumes nonceS (whether or not the proof is right) and checks the client proof.
  verify(key: string, port: number, nonceS: string, proof: unknown): boolean {
    const hit = this.nonces.find(nonceS);
    const nonceC = this.clientNonce.get(nonceS);
    this.clientNonce.delete(nonceS);
    if (!hit || nonceC === undefined) return false;
    this.nonces.delete(hit);
    return proofEqual(proof, clientProof(key, port, nonceS, nonceC));
  }
}
