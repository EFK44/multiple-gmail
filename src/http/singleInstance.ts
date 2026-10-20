import { APP_NAME } from './router.js';

export type ProbeResult = { kind: 'launch'; url: string } | { kind: 'foreign' };

const PROBE_TIMEOUT_MS = 3000;

// The port is busy: ask whoever holds it whether it is multiple-gmail. If so, get a fresh one-time launch URL
// from it (bearer local API key). Anything unexpected counts as a foreign program.
export async function probeExistingInstance(
  port: number,
  getApiKey: () => Promise<string>,
  doFetch: typeof fetch = fetch,
): Promise<ProbeResult> {
  const base = `http://127.0.0.1:${port}`;
  try {
    const health = await doFetch(`${base}/health`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    const info = (await health.json()) as { app?: unknown };
    if (!health.ok || info?.app !== APP_NAME) return { kind: 'foreign' };
    const res = await doFetch(`${base}/internal/launch`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await getApiKey()}` },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return { kind: 'foreign' };
    const { url } = (await res.json()) as { url?: unknown };
    if (typeof url !== 'string' || !url.startsWith(`${base}/?t=`)) return { kind: 'foreign' };
    return { kind: 'launch', url };
  } catch {
    return { kind: 'foreign' };
  }
}
