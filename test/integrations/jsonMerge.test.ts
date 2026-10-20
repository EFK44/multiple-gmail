import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mergeMcpServer } from '../../src/integrations/jsonMerge.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mg-merge-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const entry = { command: 'C:\\x\\multiple-gmail.exe', args: ['--stdio'] };

describe('mergeMcpServer', () => {
  it('creates a missing file (and its folder)', async () => {
    const file = join(dir, 'sub', 'cfg.json');
    const r = await mergeMcpServer(file, 'mcpServers', 'multiple-gmail', entry);
    expect(r).toEqual({ backup: null, created: true });
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ mcpServers: { 'multiple-gmail': entry } });
  });

  it('keeps other servers and unrelated keys, and writes a timestamped backup', async () => {
    const file = join(dir, 'cfg.json');
    const original = JSON.stringify({ theme: 'dark', mcpServers: { other: { command: 'x' } } });
    await writeFile(file, original);
    const r = await mergeMcpServer(file, 'mcpServers', 'multiple-gmail', entry);
    expect(r.created).toBe(false);
    expect(r.backup).toMatch(/cfg\.json\.bak-\d{14}$/);
    expect(await readFile(r.backup!, 'utf8')).toBe(original);
    const out = JSON.parse(await readFile(file, 'utf8'));
    expect(out.theme).toBe('dark');
    expect(out.mcpServers.other).toEqual({ command: 'x' });
    expect(out.mcpServers['multiple-gmail']).toEqual(entry);
  });

  it('treats an empty file as {}', async () => {
    const file = join(dir, 'cfg.json');
    await writeFile(file, '  \n');
    await mergeMcpServer(file, 'mcpServers', 'multiple-gmail', entry);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ mcpServers: { 'multiple-gmail': entry } });
  });

  it('throws on invalid JSON and leaves the file untouched with no backup', async () => {
    const file = join(dir, 'cfg.json');
    await writeFile(file, '{ "mcpServers": ');
    await expect(mergeMcpServer(file, 'mcpServers', 'multiple-gmail', entry)).rejects.toThrow(
      `Could not read ${file}: invalid JSON. Fix or move it, nothing was changed.`,
    );
    expect(await readFile(file, 'utf8')).toBe('{ "mcpServers": ');
    expect(await readdir(dir)).toEqual(['cfg.json']);
  });

  it('rejects a non-object mcpServers without changing the file', async () => {
    const file = join(dir, 'cfg.json');
    await writeFile(file, '{"mcpServers":[]}');
    await expect(mergeMcpServer(file, 'mcpServers', 'multiple-gmail', entry)).rejects.toThrow(/nothing was changed/);
    expect(await readFile(file, 'utf8')).toBe('{"mcpServers":[]}');
  });

  it('round-trips an exe path with non-ASCII characters and spaces', async () => {
    const file = join(dir, 'cfg.json');
    const exe = 'C:\\Users\\x\\Masaüstü\\a b\\multiple-gmail.exe';
    await mergeMcpServer(file, 'mcpServers', 'multiple-gmail', { command: exe, args: ['--stdio'] });
    expect(JSON.parse(await readFile(file, 'utf8')).mcpServers['multiple-gmail'].command).toBe(exe);
  });

  it('never overwrites a backup made in the same second', async () => {
    const file = join(dir, 'cfg.json');
    await writeFile(file, '{"first":true}');
    const a = await mergeMcpServer(file, 'mcpServers', 'multiple-gmail', entry);
    const b = await mergeMcpServer(file, 'mcpServers', 'multiple-gmail', entry);
    expect(a.backup).not.toBe(b.backup);
    expect(await readFile(a.backup!, 'utf8')).toBe('{"first":true}');
  });
});
