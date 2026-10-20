import { loadConfig } from '../core/config.js';
import type { ApiResponse } from '../http/api.js';
import { getAutostart, setAutostart } from './autostart.js';
import { addToClaudeDesktop, claudeDesktopTargets, isClaudeDesktopConfigured } from './claudeDesktop.js';
import { claudeCodeCommand, findClaude, runClaudeAdd, type RunResult } from './claudeCode.js';
import { addToGeminiCli, geminiSettingsPath, isGeminiConfigured } from './geminiCli.js';
import { IntegrationError } from './jsonMerge.js';
import { stdioLaunchSpec, type LaunchSpec } from './launch.js';
import { httpSnippets } from './snippets.js';

export const KEY_PLACEHOLDER = '<YOUR_API_KEY>';
const OUTPUT_LIMIT = 2048;
export const CLAUDE_DESKTOP_NOTICE = 'Fully quit Claude Desktop (system tray > Quit) and reopen it.';
const NOTICES: Partial<Record<NodeJS.Platform, string>> = {
  win32: CLAUDE_DESKTOP_NOTICE,
  darwin: 'Fully quit Claude Desktop (Claude menu > Quit Claude, or Cmd+Q) and reopen it.',
  linux: 'Fully quit Claude Desktop and reopen it.',
};
const SUPPORTED: NodeJS.Platform[] = ['win32', 'darwin', 'linux'];

export type IntegrationsDeps = {
  launch: () => LaunchSpec;
  port: () => Promise<number>;
  findClaude: () => Promise<string | null>;
  runClaude: (claudePath: string, spec: LaunchSpec) => Promise<RunResult>;
  platform: NodeJS.Platform;
  getAutostart: () => Promise<boolean>;
  setAutostart: (enabled: boolean) => Promise<void>;
};

const ok = (json: unknown): ApiResponse => ({ status: 200, json });
const fail = (status: number, error: string): ApiResponse => ({ status, json: { error } });
const trim = (s: string) => s.trim().slice(0, OUTPUT_LIMIT);

// Handles /integrations/* and /autostart (path is relative to /api). Returns null for other paths.
// Responses never contain the API key: snippets carry a placeholder the UI fills in after the user clicks copy.
export function createIntegrationsApi(partial: Partial<IntegrationsDeps> = {}) {
  const deps: IntegrationsDeps = {
    launch: partial.launch ?? stdioLaunchSpec,
    port: partial.port ?? (async () => (await loadConfig()).port),
    findClaude: partial.findClaude ?? findClaude,
    runClaude: partial.runClaude ?? runClaudeAdd,
    platform: partial.platform ?? process.platform,
    getAutostart: partial.getAutostart ?? getAutostart,
    setAutostart: partial.setAutostart ?? ((e) => setAutostart(e)),
  };
  const supported = SUPPORTED.includes(deps.platform);
  const platform = deps.platform;
  const claudeDesktopAvailable = (targets: string[]) => platform === 'win32' || (supported && targets.length > 0);

  async function guarded(fn: () => Promise<ApiResponse>): Promise<ApiResponse> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof IntegrationError) return fail(409, e.message);
      return fail(500, 'Could not complete the request.');
    }
  }

  return async function handle(method: string, path: string, body: string): Promise<ApiResponse | null> {
    if (path === '/integrations' && method === 'GET') {
      return guarded(async () => {
        const spec = deps.launch();
        const claude = supported ? await deps.findClaude() : null;
        const port = await deps.port();
        const targets = supported ? claudeDesktopTargets(platform) : [];
        return ok({
          // Windows always reports supported (as before; configPath may be null). Linux has targets only when
          // ~/.config/Claude exists.
          claudeDesktop:
            claudeDesktopAvailable(targets)
              ? { supported: true, configPath: targets[0] ?? null, configPaths: targets, configured: await isClaudeDesktopConfigured(platform) }
              : { supported: false },
          geminiCli: { configPath: geminiSettingsPath(), configured: await isGeminiConfigured() },
          claudeCode: { available: claude !== null, command: claudeCodeCommand(spec) },
          http: {
            url: `http://127.0.0.1:${port}/mcp`,
            snippets: httpSnippets(port, KEY_PLACEHOLDER),
            apiKeyPlaceholder: KEY_PLACEHOLDER,
          },
        });
      });
    }

    if (path === '/integrations/claude-desktop' && method === 'POST') {
      if (!supported || !claudeDesktopAvailable(claudeDesktopTargets(platform))) return ok({ supported: false });
      return guarded(async () =>
        ok({ ok: true, written: await addToClaudeDesktop(deps.launch(), platform), notice: NOTICES[platform] ?? CLAUDE_DESKTOP_NOTICE }),
      );
    }

    if (path === '/integrations/gemini-cli' && method === 'POST') {
      return guarded(async () => ok({ ok: true, written: [await addToGeminiCli(deps.launch())] }));
    }

    if (path === '/integrations/claude-code' && method === 'POST') {
      if (!supported) return ok({ supported: false });
      return guarded(async () => {
        const claude = await deps.findClaude();
        if (!claude) return fail(409, 'The claude command was not found on this computer.');
        let r: RunResult;
        try {
          r = await deps.runClaude(claude, deps.launch());
        } catch (e) {
          return fail(409, (e as Error).message);
        }
        return ok({ ok: r.code === 0, code: r.code, stdout: trim(r.stdout), stderr: trim(r.stderr) });
      });
    }

    if (path === '/autostart' && method === 'GET') {
      if (!supported) return ok({ supported: false });
      return guarded(async () => ok({ supported: true, enabled: await deps.getAutostart() }));
    }

    if (path === '/autostart' && method === 'POST') {
      if (!supported) return ok({ supported: false });
      let enabled: unknown;
      try {
        enabled = (body ? JSON.parse(body) : {})?.enabled;
      } catch {
        return fail(400, 'Expected a JSON object.');
      }
      if (typeof enabled !== 'boolean') return fail(400, 'enabled must be true or false.');
      return guarded(async () => {
        await deps.setAutostart(enabled as boolean);
        return ok({ supported: true, enabled: await deps.getAutostart() });
      });
    }

    return null;
  };
}
