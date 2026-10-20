import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { probeExistingInstance } from '../../src/http/singleInstance.js';

let srv: Server | undefined;
afterEach(async () => {
  await new Promise<void>((r) => (srv ? srv.close(() => r()) : r()));
  srv = undefined;
});

function listen(handler: Parameters<typeof createServer>[1]): Promise<number> {
  srv = createServer(handler);
  return new Promise((resolve) => srv!.listen(0, '127.0.0.1', () => resolve((srv!.address() as AddressInfo).port)));
}

describe('probeExistingInstance', () => {
  it('returns a launch URL when /health answers as multiple-gmail', async () => {
    const seen: { auth?: string; path?: string }[] = [];
    const port = await listen((req, res) => {
      seen.push({ auth: req.headers.authorization, path: req.url });
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/health') return res.end(JSON.stringify({ app: 'multiple-gmail', version: '0.1.0' }));
      if (req.url === '/internal/launch' && req.method === 'POST') {
        return res.end(JSON.stringify({ url: `http://127.0.0.1:${port}/?t=abc` }));
      }
      res.statusCode = 404;
      res.end('{}');
    });
    const r = await probeExistingInstance(port, async () => 'the-key');
    expect(r).toEqual({ kind: 'launch', url: `http://127.0.0.1:${port}/?t=abc` });
    expect(seen.find((s) => s.path === '/internal/launch')?.auth).toBe('Bearer the-key');
  });

  it('reports a foreign program on the port', async () => {
    const port = await listen((_req, res) => {
      res.setHeader('Content-Type', 'text/html');
      res.end('<html>other</html>');
    });
    expect(await probeExistingInstance(port, async () => 'k')).toEqual({ kind: 'foreign' });
  });

  it('rejects a launch URL that does not point at the probed port', async () => {
    const port = await listen((req, res) => {
      if (req.url === '/health') return res.end(JSON.stringify({ app: 'multiple-gmail', version: '0.1.0' }));
      res.end(JSON.stringify({ url: 'https://evil.example.com/' }));
    });
    expect(await probeExistingInstance(port, async () => 'k')).toEqual({ kind: 'foreign' });
  });
});
