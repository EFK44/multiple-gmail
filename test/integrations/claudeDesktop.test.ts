import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addToClaudeDesktop,
  claudeDesktopTargets,
  claudeDesktopStatus,
  isClaudeDesktopConfigured,
} from '../../src/integrations/claudeDesktop.js';

const FILE = 'claude_desktop_config.json';
const spec = { command: 'C:\\x\\multiple-gmail.exe', args: ['--stdio'] };

let root: string;
let roaming: string;
let local: string;
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mg-cd-'));
  roaming = join(root, 'roaming');
  local = join(root, 'local');
  await mkdir(roaming, { recursive: true });
  await mkdir(local, { recursive: true });
  for (const k of ['APPDATA', 'LOCALAPPDATA']) saved[k] = process.env[k];
  process.env.APPDATA = roaming;
  process.env.LOCALAPPDATA = local;
});
afterEach(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await rm(root, { recursive: true, force: true });
});

const classic = () => join(roaming, 'Claude', FILE);
const store = (pub = 'pzs8sxrjxfjjc') => join(local, 'Claude-Data', `claude_${pub}`, FILE);

describe('claudeDesktopTargets', () => {
  it('falls back to the classic %APPDATA%\\Claude path when nothing exists', () => {
    expect(claudeDesktopTargets('win32')).toEqual([classic()]);
  });

  it('targets a Store v3 Claude-Data folder even when the file does not exist yet', async () => {
    await mkdir(join(local, 'Claude-Data', 'claude_pzs8sxrjxfjjc'), { recursive: true });
    expect(claudeDesktopTargets('win32')).toEqual([store()]);
  });

  it('includes every existing Claude-Data config and an existing classic config', async () => {
    await mkdir(join(local, 'Claude-Data', 'claude_aaa'), { recursive: true });
    await mkdir(join(local, 'Claude-Data', 'claude_bbb'), { recursive: true });
    await writeFile(store('bbb'), '{}');
    await mkdir(join(local, 'Claude-Data', 'other'), { recursive: true });
    await writeFile(join(local, 'Claude-Data', 'stray.json'), '{}');
    await mkdir(join(roaming, 'Claude'), { recursive: true });
    await writeFile(classic(), '{}');
    expect(claudeDesktopTargets('win32')).toEqual([store('aaa'), store('bbb'), classic()]);
  });

  it('does not target the old Packages LocalCache path unless that file exists', async () => {
    const pkg = join(local, 'Packages', 'Claude_pzs8sxrjxfjjc', 'LocalCache', 'Roaming', 'Claude');
    await mkdir(pkg, { recursive: true });
    await mkdir(join(local, 'Claude-Data', 'claude_pzs8sxrjxfjjc'), { recursive: true });
    expect(claudeDesktopTargets('win32')).toEqual([store()]);
  });
});

describe('addToClaudeDesktop on Store v3', () => {
  it('merges into the Claude-Data config and keeps the app preferences', async () => {
    await mkdir(join(local, 'Claude-Data', 'claude_pzs8sxrjxfjjc'), { recursive: true });
    const prefs = {
      preferences: { menuBarEnabled: false, sidebarMode: 'chat', legacyQuickEntryEnabled: true },
      mcpServers: { other: { command: 'other.exe', args: [] } },
      someFlag: 1,
    };
    await writeFile(store(), JSON.stringify(prefs, null, 2));
    expect(await isClaudeDesktopConfigured('win32', spec.command)).toBe(false);
    const written = await addToClaudeDesktop(spec, 'win32');
    expect(written.map((w) => w.path)).toEqual([store()]);
    expect(typeof written[0].backup).toBe('string');
    const doc = JSON.parse(await readFile(store(), 'utf8'));
    expect(doc).toEqual({
      preferences: prefs.preferences,
      mcpServers: { other: prefs.mcpServers.other, 'multiple-gmail': spec },
      someFlag: 1,
    });
    expect(await isClaudeDesktopConfigured('win32', spec.command)).toBe(true);
  });

  it('creates the file inside an existing Claude-Data folder', async () => {
    await mkdir(join(local, 'Claude-Data', 'claude_pzs8sxrjxfjjc'), { recursive: true });
    const written = await addToClaudeDesktop(spec, 'win32');
    expect(written).toEqual([{ path: store(), backup: null, created: true }]);
    expect(JSON.parse(await readFile(store(), 'utf8'))).toEqual({ mcpServers: { 'multiple-gmail': spec } });
  });

  it('is not "configured" while one of several targets still lacks the entry', async () => {
    await mkdir(join(local, 'Claude-Data', 'claude_pzs8sxrjxfjjc'), { recursive: true });
    await mkdir(join(roaming, 'Claude'), { recursive: true });
    await writeFile(classic(), JSON.stringify({ mcpServers: { 'multiple-gmail': spec } }));
    expect(await isClaudeDesktopConfigured('win32', spec.command)).toBe(false);
    await addToClaudeDesktop(spec, 'win32');
    expect(await isClaudeDesktopConfigured('win32', spec.command)).toBe(true);
  });
});

describe('Claude Desktop entry status', () => {
  it('an entry for another multiple-gmail path is outdated, not configured', async () => {
    await mkdir(join(roaming, 'Claude'), { recursive: true });
    const classicFile = join(roaming, 'Claude', FILE);
    await writeFile(classicFile, JSON.stringify({ mcpServers: { 'multiple-gmail': { command: 'D:\old\multiple-gmail.exe', args: ['--stdio'] } } }));
    expect(await claudeDesktopStatus('win32', spec.command)).toEqual({ configured: false, outdated: true });
    await addToClaudeDesktop(spec, 'win32');
    expect(await claudeDesktopStatus('win32', spec.command)).toEqual({ configured: true, outdated: false });
  });
});

describe('Claude Desktop on macOS and Linux', () => {
  let home: string;
  const prev: Record<string, string | undefined> = {};
  beforeEach(async () => {
    home = join(root, 'Masaüstü home');
    await mkdir(home, { recursive: true });
    for (const k of ['HOME', 'USERPROFILE']) prev[k] = process.env[k];
    process.env.HOME = home;
    process.env.USERPROFILE = home;
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('macOS writes ~/Library/Application Support/Claude/claude_desktop_config.json', async () => {
    const target = join(home, 'Library', 'Application Support', 'Claude', FILE);
    expect(claudeDesktopTargets('darwin')).toEqual([target]);
    expect(await isClaudeDesktopConfigured('darwin', spec.command)).toBe(false);
    const posixSpec = { command: '/Applications/a b/multiple-gmail', args: ['--stdio'] };
    expect(await addToClaudeDesktop(posixSpec, 'darwin')).toEqual([{ path: target, backup: null, created: true }]);
    expect(JSON.parse(await readFile(target, 'utf8'))).toEqual({ mcpServers: { 'multiple-gmail': posixSpec } });
    expect(await isClaudeDesktopConfigured('darwin', posixSpec.command)).toBe(true);
  });

  it('Linux targets ~/.config/Claude only when that folder exists', async () => {
    expect(claudeDesktopTargets('linux')).toEqual([]);
    expect(await isClaudeDesktopConfigured('linux', spec.command)).toBe(false);
    await mkdir(join(home, '.config', 'Claude'), { recursive: true });
    expect(claudeDesktopTargets('linux')).toEqual([join(home, '.config', 'Claude', FILE)]);
  });

  it('other systems have no target', () => {
    expect(claudeDesktopTargets('freebsd')).toEqual([]);
  });
});
