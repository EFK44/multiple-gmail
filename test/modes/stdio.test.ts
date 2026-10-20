import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterEach, beforeEach, expect, it } from 'vitest';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mg-stdio-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

it('serves list_accounts over stdio with only JSON-RPC on stdout', async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve('node_modules/tsx/dist/cli.mjs'), 'src/main.ts', '--stdio'],
    env: { ...(process.env as Record<string, string>), MULTIPLE_GMAIL_HOME: dir },
    stderr: 'pipe',
  });
  const nonJson: string[] = [];
  transport.onerror = (e) => nonJson.push(String(e));
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(transport);
  try {
    const res = await client.callTool({ name: 'list_accounts', arguments: {} });
    expect(res.isError).not.toBe(true);
    expect(res.structuredContent).toMatchObject({ accounts: [] });
    expect(nonJson).toEqual([]);
  } finally {
    await client.close();
  }
}, 30_000);
