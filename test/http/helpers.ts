import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetMasterKeyCacheForTests } from '../../src/core/masterKey.js';

export type RawResponse = { status: number; headers: Record<string, string | string[] | undefined>; body: string };

// node:http request so tests can set Host and other forbidden-in-fetch headers.
export function raw(
  port: number,
  opts: { method?: string; path?: string; headers?: Record<string, string>; body?: string | Buffer } = {},
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, method: opts.method ?? 'GET', path: opts.path ?? '/', headers: opts.headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }),
        );
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

export async function tempHome(prefix: string): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  const prevHome = process.env.MULTIPLE_GMAIL_HOME;
  const prevKey = process.env.MULTIPLE_GMAIL_MASTER_KEY;
  process.env.MULTIPLE_GMAIL_HOME = join(dir, 'home');
  if (process.platform !== 'win32') process.env.MULTIPLE_GMAIL_MASTER_KEY = randomBytes(32).toString('base64');
  resetMasterKeyCacheForTests();
  return {
    dir,
    cleanup: async () => {
      resetMasterKeyCacheForTests();
      if (prevHome === undefined) delete process.env.MULTIPLE_GMAIL_HOME;
      else process.env.MULTIPLE_GMAIL_HOME = prevHome;
      if (prevKey === undefined) delete process.env.MULTIPLE_GMAIL_MASTER_KEY;
      else process.env.MULTIPLE_GMAIL_MASTER_KEY = prevKey;
      await rm(dir, { recursive: true, force: true });
    },
  };
}
