import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli, type CliIo } from '../../src/modes/cli.js';
import { saveConfig } from '../../src/core/config.js';

let dir: string;
let prev: string | undefined;
beforeEach(async () => {
  prev = process.env.MULTIPLE_GMAIL_HOME;
  dir = await mkdtemp(join(tmpdir(), 'mg-cli-'));
  process.env.MULTIPLE_GMAIL_HOME = dir;
});
afterEach(async () => {
  if (prev === undefined) delete process.env.MULTIPLE_GMAIL_HOME;
  else process.env.MULTIPLE_GMAIL_HOME = prev;
  await rm(dir, { recursive: true, force: true });
});

function io(over: Partial<CliIo> = {}): CliIo & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    log: (s) => out.push(s),
    error: (s) => err.push(s),
    isTty: false,
    confirm: async () => '',
    openUrl: async () => {},
    ...over,
  };
}

describe('cli', () => {
  it('lists no accounts', async () => {
    const o = io();
    expect(await runCli(['accounts', 'list'], o)).toBe(0);
    expect(o.out.join('\n')).toContain('No accounts connected');
  });

  it('lists connected accounts', async () => {
    await saveConfig({
      port: 47110,
      language: 'en',
      defaultAccount: 'alpha',
      accounts: { alpha: { email: 'you@example.com', addedAt: '2026-10-01T00:00:00.000Z' } },
    });
    const o = io();
    expect(await runCli(['accounts', 'list'], o)).toBe(0);
    expect(o.out.join('\n')).toContain('alpha');
    expect(o.out.join('\n')).toContain('you@example.com');
  });

  it('remove of an unknown account exits 1', async () => {
    const o = io();
    expect(await runCli(['accounts', 'remove', 'ghost', '--yes'], o)).toBe(1);
    expect(o.err.join('\n')).toContain('Unknown account');
  });

  it('remove asks for the alias on a TTY and aborts on mismatch', async () => {
    await saveConfig({
      port: 47110,
      language: 'en',
      defaultAccount: 'alpha',
      accounts: { alpha: { email: 'you@example.com', addedAt: '2026-10-01T00:00:00.000Z' } },
    });
    const o = io({ isTty: true, confirm: async () => 'nope' });
    expect(await runCli(['accounts', 'remove', 'alpha'], o)).toBe(1);
    expect(o.err.join('\n')).toContain('Cancelled');
  });

  it('add without an OAuth client says setup must be finished in the app', async () => {
    const o = io();
    expect(await runCli(['accounts', 'add', '--alias', 'alpha'], o)).toBe(1);
    expect(o.err.join('\n')).toMatch(/app/i);
  });

  it('add with an existing alias suggests reconnect', async () => {
    await saveConfig({
      port: 47110,
      language: 'en',
      defaultAccount: 'alpha',
      accounts: { alpha: { email: 'you@example.com', addedAt: '2026-10-01T00:00:00.000Z' } },
    });
    const o = io();
    expect(await runCli(['accounts', 'add', '--alias', 'alpha'], o)).toBe(1);
    expect(o.err.join('\n')).toContain('accounts reconnect alpha');
  });

  it('gen-key prints 32 random bytes as base64', async () => {
    const o = io();
    expect(await runCli(['gen-key'], o)).toBe(0);
    expect(Buffer.from(o.out.join('').trim(), 'base64')).toHaveLength(32);
  });

  it('unknown commands exit 1 and show usage', async () => {
    const o = io();
    expect(await runCli(['bogus'], o)).toBe(1);
    expect(o.err.join('\n')).toContain('Usage');
  });

  it('--version and --help exit 0', async () => {
    const o = io();
    expect(await runCli(['--version'], o)).toBe(0);
    expect(o.out.join('\n')).toMatch(/\d+\.\d+\.\d+/);
    expect(await runCli(['--help'], o)).toBe(0);
  });

  it('modes that are not built yet exit 2', async () => {
    for (const args of [[], ['--minimized'], ['serve', '--remote']]) {
      const o = io();
      expect(await runCli(args, o)).toBe(2);
      expect(o.err.join('\n')).toContain('Not available yet');
    }
  });
});
