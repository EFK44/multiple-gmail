import { clientProof, isNonce, newNonce, proofEqual, serverProof } from './handshake.js';
import { APP_NAME } from './router.js';

export type ProbeResult = { kind: 'launch'; url: string } | { kind: 'foreign' };

const PROBE_TIMEOUT_MS = 3000;

// The port is busy: find out whether the holder is our own running instance, and if so get a fresh one-time
// launch URL from it. The local API key never goes over the wire: the holder must first prove it knows the key
// (server proof over our nonce); only then do we send our own proof. Anything unexpected counts as foreign.
export async function probeExistingInstance(
  port: number,
  getApiKey: () => Promise<string>,
  doFetch: typeof fetch = fetch,
): Promise<ProbeResult> {
  const base = `http://127.0.0.1:${port}`;
  const post = (path: string, body: unknown) =>
    doFetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  try {
    const health = await doFetch(`${base}/health`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    const info = (await health.json()) as { app?: unknown };
    if (!health.ok || info?.app !== APP_NAME) return { kind: 'foreign' };

    const key = await getApiKey();
    const nonceC = newNonce();
    const ch = await post('/internal/launch/challenge', { nonceC });
    if (!ch.ok) return { kind: 'foreign' };
    const { nonceS, proof } = (await ch.json()) as { nonceS?: unknown; proof?: unknown };
    if (!isNonce(nonceS) || !proofEqual(proof, serverProof(key, nonceC, nonceS))) return { kind: 'foreign' };

    const res = await post('/internal/launch', { nonceS, proof: clientProof(key, nonceS, nonceC) });
    if (!res.ok) return { kind: 'foreign' };
    const { url } = (await res.json()) as { url?: unknown };
    if (typeof url !== 'string' || !url.startsWith(`${base}/?t=`)) return { kind: 'foreign' };
    return { kind: 'launch', url };
  } catch {
    return { kind: 'foreign' };
  }
}
