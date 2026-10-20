import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { VERSION } from '../../src/version.js';

// Runs only after `npm run build:exe` produced the executable for this OS.
const EXE_NAME = process.platform === 'win32' ? 'multiple-gmail.exe' : 'multiple-gmail';
const EXE = resolve('build', EXE_NAME);
const run = promisify(execFile);
// macOS and Linux: never let the packaged binary reach the runner's real Keychain or Secret Service.
const keyEnv: Record<string, string> =
  process.platform === 'win32' ? {} : { MULTIPLE_GMAIL_MASTER_KEY: randomBytes(32).toString('base64') };

function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const s = createServer();
    s.once('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => ok(port));
    });
  });
}

// CI sets MG_REQUIRE_EXE=1 after building, so a missing binary fails instead of silently skipping.
it.runIf(process.env.MG_REQUIRE_EXE === '1')('the packaged executable was built', () => {
  expect(existsSync(EXE), EXE).toBe(true);
});

describe.skipIf(!existsSync(EXE))('packaged exe', () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'mg-exe-'));
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('--version prints VERSION and no SEA warning', async () => {
    const { stdout, stderr } = await run(EXE, ['--version']);
    expect(stdout.trim()).toBe(VERSION);
    expect(stderr).not.toMatch(/experimental|single executable/i);
  });

  it('runs --stdio from a path with non-ASCII and spaces and lists 11 tools', async () => {
    const dir = join(root, 'Masaüstü test');
    const home = join(root, 'home-stdio');
    await mkdir(dir, { recursive: true });
    const exe = join(dir, EXE_NAME);
    await copyFile(EXE, exe);
    if (process.platform !== 'win32') await chmod(exe, 0o755);
    const transport = new StdioClientTransport({
      command: exe,
      args: ['--stdio'],
      env: { ...(process.env as Record<string, string>), ...keyEnv, MULTIPLE_GMAIL_HOME: home },
      stderr: 'pipe',
    });
    const errors: string[] = [];
    transport.onerror = (e) => errors.push(String(e));
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(11);
      expect(errors).toEqual([]);
    } finally {
      await client.close();
    }
  });

  it('with no args serves /health and the embedded web UI', async () => {
    const home = join(root, 'home-http');
    await mkdir(home, { recursive: true });
    const port = await freePort();
    await writeFile(
      join(home, 'config.json'),
      JSON.stringify({ port, language: 'en', defaultAccount: null, accounts: {} }),
    );
    let child: ChildProcess | undefined;
    try {
      child = spawn(EXE, ['--minimized'], {
        env: { ...process.env, ...keyEnv, MULTIPLE_GMAIL_HOME: home },
        stdio: 'ignore',
      });
      const base = `http://127.0.0.1:${port}`;
      let health: unknown;
      for (let i = 0; i < 100 && health === undefined; i++) {
        try {
          const r = await fetch(`${base}/health`);
          if (r.ok) health = await r.json();
        } catch {
          await new Promise((r) => setTimeout(r, 200));
        }
      }
      expect(health).toMatchObject({ app: 'multiple-gmail', version: VERSION });
      const index = await fetch(`${base}/`);
      expect(index.status).toBe(200);
      expect(await index.text()).toContain('multiple-gmail');
      const css = await fetch(`${base}/styles.css`);
      expect(css.headers.get('content-type')).toMatch(/^text\/css/);
      const i18n = await fetch(`${base}/i18n/en.json`);
      expect(i18n.status).toBe(200);
      expect((await fetch(`${base}/..%2fpackage.json`)).status).toBe(404);
    } finally {
      child?.kill();
    }
  });
});
