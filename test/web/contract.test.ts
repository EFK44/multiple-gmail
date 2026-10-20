import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApi } from '../../src/http/api.js';
import { tempHome } from '../http/helpers.js';

// The wizard (src/web/app.js) reads these exact fields. This test runs the real API and integration routes
// (only the process-level dependencies are stubbed) so a renamed field fails here instead of silently in the UI.

let cleanup: () => Promise<void>;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  const home = await tempHome('mg-contract-');
  cleanup = home.cleanup;
  // Claude Desktop and Gemini CLI paths derive from these; keep the real profile untouched.
  for (const k of ['APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'HOME']) savedEnv[k] = process.env[k];
  process.env.APPDATA = join(home.dir, 'roaming');
  process.env.LOCALAPPDATA = join(home.dir, 'local');
  process.env.USERPROFILE = join(home.dir, 'profile');
  process.env.HOME = join(home.dir, 'profile');
});

afterEach(async () => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await cleanup();
});

function wizardApi(available = true) {
  let autostart = false;
  const handle = createApi({
    integrations: {
      launch: () => ({ command: 'C:\\x\\multiple-gmail.exe', args: ['--stdio'] }),
      port: async () => 47110,
      findClaude: async () => (available ? 'C:\\x\\claude.exe' : null),
      runClaude: async () => ({ code: 1, stdout: 'out', stderr: 'err' }),
      platform: 'win32',
      getAutostart: async () => autostart,
      setAutostart: async (e: boolean) => {
        autostart = e;
      },
    },
  });
  return (method: string, path: string, body: unknown = '') =>
    handle({ method, path, body: typeof body === 'string' ? body : JSON.stringify(body), sameOrigin: true });
}

const asObj = (v: unknown) => v as Record<string, any>;

// The Windows master key goes through DPAPI (a PowerShell spawn), which is slow when the suite runs in parallel.
describe('wizard API contract', { timeout: 30000 }, () => {
  it('GET /state has the fields the wizard reads', async () => {
    const api = wizardApi();
    await api('POST', '/client', { installed: { client_id: 'id-1', client_secret: 'sec-1', redirect_uris: [] } });
    const s = asObj((await api('GET', '/state')).json);
    expect(typeof s.hasClient).toBe('boolean');
    expect(s.clientId).toBe('id-1');
    expect(s.clientKind).toBe('installed');
    expect(['en', 'tr']).toContain(s.language);
    expect(Array.isArray(s.accounts)).toBe(true);
    expect(typeof s.apiKeyMasked).toBe('string');
    expect(JSON.stringify(s)).not.toContain('sec-1');
  });

  it('GET /integrations has the fields the AI screen reads', async () => {
    const r = await wizardApi()('GET', '/integrations');
    expect(r.status).toBe(200);
    const j = asObj(r.json);
    expect(j.claudeDesktop.supported).toBe(true);
    expect(typeof j.claudeDesktop.configured).toBe('boolean');
    expect(Array.isArray(j.claudeDesktop.configPaths)).toBe(true);
    expect(typeof j.geminiCli.configured).toBe('boolean');
    expect(typeof j.claudeCode.available).toBe('boolean');
    expect(typeof j.claudeCode.command).toBe('string');
    expect(j.http.url).toBe('http://127.0.0.1:47110/mcp');
    for (const k of ['cursor', 'vscode', 'generic']) {
      expect(j.http.snippets[k]).toContain('<YOUR_API_KEY>');
    }
  });

  it('POST claude-desktop and gemini-cli return ok, written [{path, backup}] and the restart notice', async () => {
    const api = wizardApi();
    const cd = asObj((await api('POST', '/integrations/claude-desktop', {})).json);
    expect(cd.ok).toBe(true);
    expect(typeof cd.notice).toBe('string');
    expect(cd.written.length).toBeGreaterThan(0);
    for (const w of cd.written) {
      expect(typeof w.path).toBe('string');
      expect('backup' in w).toBe(true);
    }
    // A second run backs up the file the first run wrote.
    const again = asObj((await api('POST', '/integrations/claude-desktop', {})).json);
    expect(typeof again.written[0].backup).toBe('string');

    const gm = asObj((await api('POST', '/integrations/gemini-cli', {})).json);
    expect(gm.ok).toBe(true);
    expect(typeof gm.written[0].path).toBe('string');
    expect('backup' in gm.written[0]).toBe(true);
  });

  it('POST claude-code returns ok/code/stderr, or 409 with error when claude is missing', async () => {
    const run = asObj((await wizardApi(true)('POST', '/integrations/claude-code', {})).json);
    expect(run).toMatchObject({ ok: false, code: 1, stderr: 'err' });
    const missing = await wizardApi(false)('POST', '/integrations/claude-code', {});
    expect(missing.status).toBe(409);
    expect(typeof asObj(missing.json).error).toBe('string');
  });

  it('autostart GET and POST return supported and enabled', async () => {
    const api = wizardApi();
    expect((await api('GET', '/autostart')).json).toEqual({ supported: true, enabled: false });
    expect((await api('POST', '/autostart', { enabled: true })).json).toEqual({ supported: true, enabled: true });
  });
});
