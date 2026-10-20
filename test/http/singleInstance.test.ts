import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { clientProof, serverProof } from '../../src/http/handshake.js';
import { probeExistingInstance } from '../../src/http/singleInstance.js';

let srv: Server | undefined;
afterEach(async () => {
  await new Promise<void>((r) => (srv ? srv.close(() => r()) : r()));
  srv = undefined;
});

type Seen = { method?: string; path?: string; auth?: string; body: string };

function listen(handler: (req: IncomingMessage, body: string, port: number) => { status?: number; json: unknown }) {
  const seen: Seen[] = [];
  srv = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      seen.push({ method: req.method, path: req.url, auth: req.headers.authorization, body });
      const out = handler(req, body, (srv!.address() as AddressInfo).port);
      res.writeHead(out.status ?? 200, { 'Content-Type': 'application/json' });
      res.end(typeof out.json === 'string' ? out.json : JSON.stringify(out.json));
    });
  });
  return new Promise<{ port: number; seen: Seen[] }>((resolve) =>
    srv!.listen(0, '127.0.0.1', () => resolve({ port: (srv!.address() as AddressInfo).port, seen })),
  );
}

const KEY = 'the-local-key';
const health = { app: 'multiple-gmail', version: '0.1.0' };

describe('probeExistingInstance', () => {
  it('completes the mutual handshake with a genuine instance and never sends the key', async () => {
    const nonceS = 'S'.repeat(43);
    let nonceC = '';
    const { port, seen } = await listen((req, body, p) => {
      if (req.url === '/health') return { json: health };
      if (req.url === '/internal/launch/challenge') {
        nonceC = JSON.parse(body).nonceC;
        return { json: { nonceS, proof: serverProof(KEY, nonceC, nonceS) } };
      }
      const b = JSON.parse(body);
      if (b.nonceS === nonceS && b.proof === clientProof(KEY, nonceS, nonceC)) {
        return { json: { url: `http://127.0.0.1:${p}/?t=abc` } };
      }
      return { status: 401, json: {} };
    });
    const r = await probeExistingInstance(port, async () => KEY);
    expect(r).toEqual({ kind: 'launch', url: `http://127.0.0.1:${port}/?t=abc` });
    for (const s of seen) {
      expect(s.auth).toBeUndefined();
      expect(s.body).not.toContain(KEY);
    }
  });

  it('an impostor that cannot produce the server proof never receives a client proof', async () => {
    const { port, seen } = await listen((req) => {
      if (req.url === '/health') return { json: health };
      return { json: { nonceS: 'S'.repeat(43), proof: 'forged' } };
    });
    expect(await probeExistingInstance(port, async () => KEY)).toEqual({ kind: 'foreign' });
    expect(seen.map((s) => s.path)).toEqual(['/health', '/internal/launch/challenge']);
    for (const s of seen) {
      expect(s.auth).toBeUndefined();
      expect(s.body).not.toContain(KEY);
    }
  });

  it('reports a foreign program on the port', async () => {
    const { port } = await listen(() => ({ json: '<html>other</html>' }));
    expect(await probeExistingInstance(port, async () => KEY)).toEqual({ kind: 'foreign' });
  });

  it('rejects a launch URL that does not point at the probed port', async () => {
    const nonceS = 'S'.repeat(43);
    const { port } = await listen((req, body) => {
      if (req.url === '/health') return { json: health };
      if (req.url === '/internal/launch/challenge') {
        return { json: { nonceS, proof: serverProof(KEY, JSON.parse(body).nonceC, nonceS) } };
      }
      return { json: { url: 'https://evil.example.com/' } };
    });
    expect(await probeExistingInstance(port, async () => KEY)).toEqual({ kind: 'foreign' });
  });
});
