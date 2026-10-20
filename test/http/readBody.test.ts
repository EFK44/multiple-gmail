import type { IncomingMessage } from 'node:http';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { readBody } from '../../src/http/router.js';

function fakeReq(headers: Record<string, string> = {}): PassThrough & { headers: Record<string, string> } {
  return Object.assign(new PassThrough(), { headers });
}

describe('readBody', () => {
  it('reads a small body', async () => {
    const req = fakeReq();
    const p = readBody(req as unknown as IncomingMessage, 100);
    req.end('{"a":1}');
    expect(await p).toEqual({ kind: 'ok', text: '{"a":1}' });
  });

  it('settles as too_large when overflow passes the drain cap and the stream is destroyed', async () => {
    const req = fakeReq();
    const p = readBody(req as unknown as IncomingMessage, 10, 50);
    req.write(Buffer.alloc(30));
    req.write(Buffer.alloc(30));
    expect(await p).toEqual({ kind: 'too_large' });
    expect(req.destroyed).toBe(true);
  });

  it('settles when the client aborts before the end', async () => {
    const req = fakeReq();
    const p = readBody(req as unknown as IncomingMessage, 10);
    req.write(Buffer.alloc(5));
    req.destroy();
    expect(await p).toEqual({ kind: 'too_large' });
  });

  it('a declared Content-Length over the limit is too_large', async () => {
    const req = fakeReq({ 'content-length': '999' });
    const p = readBody(req as unknown as IncomingMessage, 10);
    req.end('x');
    expect(await p).toEqual({ kind: 'too_large' });
  });
});
