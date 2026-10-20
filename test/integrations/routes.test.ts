import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudeDesktopConfigCandidates } from '../../src/integrations/claudeDesktop.js';
import { geminiSettingsPath } from '../../src/integrations/geminiCli.js';
import { createIntegrationsApi } from '../../src/integrations/routes.js';

let dir: string;
const saved: Record<string, string | undefined> = {};
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mg-int-'));
  for (const k of ['APPDATA', 'LOCALAPPDATA', 'USERPROFILE']) saved[k] = process.env[k];
  process.env.APPDATA = join(dir, 'roaming');
  process.env.LOCALAPPDATA = join(dir, 'local');
  process.env.USERPROFILE = join(dir, 'home');
});
afterEach(async () => {
  for (const k of Object.keys(saved)) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await rm(dir, { recursive: true, force: true });
});

const launch = { command: 'C:\\x\\multiple-gmail.exe', args: ['--stdio'] };

function api(extra: Partial<Parameters<typeof createIntegrationsApi>[0]> = {}) {
  return createIntegrationsApi({
    launch: () => launch,
    port: async () => 47110,
    findClaude: async () => null,
    runClaude: async () => ({ code: 0, stdout: '', stderr: '' }),
    platform: 'win32',
    getAutostart: async () => false,
    setAutostart: async () => {},
    ...extra,
  });
}

describe('claude desktop candidates', () => {
  it('lists the roaming path first, then Store package paths that exist', async () => {
    const pkg = join(dir, 'local', 'Packages', 'Claude_abc123', 'LocalCache', 'Roaming', 'Claude');
    await mkdir(pkg, { recursive: true });
    await mkdir(join(dir, 'local', 'Packages', 'Other_x'), { recursive: true });
    const c = claudeDesktopConfigCandidates();
    expect(c[0]).toBe(join(dir, 'roaming', 'Claude', 'claude_desktop_config.json'));
    expect(c).toContain(join(pkg, 'claude_desktop_config.json'));
    expect(c).toHaveLength(2);
  });
});

describe('integrations routes', () => {
  it('GET /integrations reports state with a placeholder key only', async () => {
    const r = await api()('GET', '/integrations', '');
    const j = r!.json as any;
    expect(j.claudeDesktop.configured).toBe(false);
    expect(j.geminiCli.configPath).toBe(geminiSettingsPath());
    expect(j.claudeCode.available).toBe(false);
    expect(j.claudeCode.command).toContain('claude mcp add --scope user multiple-gmail --');
    expect(j.http.url).toBe('http://127.0.0.1:47110/mcp');
    expect(JSON.stringify(j.http.snippets)).toContain('<YOUR_API_KEY>');
  });

  it('POST gemini-cli creates .gemini/settings.json and then reports configured', async () => {
    const a = api();
    const r = await a('POST', '/integrations/gemini-cli', '');
    expect(r!.status).toBe(200);
    const file = geminiSettingsPath();
    expect(JSON.parse(await readFile(file, 'utf8')).mcpServers['multiple-gmail']).toEqual(launch);
    expect(((await a('GET', '/integrations', ''))!.json as any).geminiCli.configured).toBe(true);
  });

  it('POST gemini-cli with invalid JSON returns 409 and keeps the file', async () => {
    const file = geminiSettingsPath();
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, '{oops');
    const r = await api()('POST', '/integrations/gemini-cli', '');
    expect(r!.status).toBe(409);
    expect((r!.json as any).error).toContain('invalid JSON');
    expect(await readFile(file, 'utf8')).toBe('{oops');
  });

  it('POST claude-desktop writes to the first candidate and names the file', async () => {
    const r = await api()('POST', '/integrations/claude-desktop', '');
    const j = r!.json as any;
    expect(j.written).toEqual([expect.objectContaining({ path: claudeDesktopConfigCandidates()[0], created: true })]);
    expect(((await api()('GET', '/integrations', ''))!.json as any).claudeDesktop.configured).toBe(true);
  });

  it('claude-desktop returns the restart notice and writes every existing config with its own backup', async () => {
    const roaming = join(dir, 'roaming', 'Claude');
    const store = join(dir, 'local', 'Packages', 'Claude_abc', 'LocalCache', 'Roaming', 'Claude');
    for (const d of [roaming, store]) {
      await mkdir(d, { recursive: true });
      await writeFile(join(d, 'claude_desktop_config.json'), '{}');
    }
    const a = api();
    const j = (await a('POST', '/integrations/claude-desktop', ''))!.json as any;
    expect(j.notice).toBe('Fully quit Claude Desktop (system tray > Quit) and reopen it.');
    expect(j.written).toHaveLength(2);
    for (const w of j.written) expect(w.backup).toMatch(/\.bak-\d{14}/);
    expect(new Set(j.written.map((w: any) => w.backup)).size).toBe(2);
    expect(((await a('GET', '/integrations', ''))!.json as any).claudeDesktop.configPaths).toHaveLength(2);
  });

  it('non-Windows claude-desktop and autostart say unsupported', async () => {
    const a = api({ platform: 'linux' });
    expect((await a('POST', '/integrations/claude-desktop', ''))!.json).toEqual({ supported: false });
    expect((await a('GET', '/autostart', ''))!.json).toEqual({ supported: false });
    expect((await a('POST', '/autostart', '{"enabled":true}'))!.json).toEqual({ supported: false });
  });

  it('claude-code POST is refused when claude is not found, and trims output when run', async () => {
    expect((await api()('POST', '/integrations/claude-code', ''))!.status).toBe(409);
    const big = 'x'.repeat(5000);
    let got: string | undefined;
    const r = await api({
      findClaude: async () => 'C:\\bin\\claude.exe',
      runClaude: async (p) => {
        got = p;
        return { code: 0, stdout: big, stderr: '  err  ' };
      },
    })('POST', '/integrations/claude-code', '');
    const j = r!.json as any;
    expect(got).toBe('C:\\bin\\claude.exe');
    expect(j.ok).toBe(true);
    expect(j.stdout.length).toBe(2048);
    expect(j.stderr).toBe('err');
  });

  it('autostart GET and POST', async () => {
    let enabled = false;
    const a = api({ getAutostart: async () => enabled, setAutostart: async (e) => void (enabled = e) });
    expect((await a('GET', '/autostart', ''))!.json).toEqual({ supported: true, enabled: false });
    expect((await a('POST', '/autostart', '{"enabled":true}'))!.json).toEqual({ supported: true, enabled: true });
    expect((await a('POST', '/autostart', '{"enabled":"yes"}'))!.status).toBe(400);
  });

  it('returns null for unrelated paths', async () => {
    expect(await api()('GET', '/state', '')).toBeNull();
  });
});
