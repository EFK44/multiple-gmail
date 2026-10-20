import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { hasMcpServer, IntegrationError, mergeMcpServer } from './jsonMerge.js';
import type { LaunchSpec } from './launch.js';

const FILE = 'claude_desktop_config.json';

export function claudeDesktopConfigCandidates(): string[] {
  const out: string[] = [];
  const appData = process.env.APPDATA;
  if (appData) out.push(join(appData, 'Claude', FILE));
  const local = process.env.LOCALAPPDATA;
  if (local) {
    const packages = join(local, 'Packages');
    try {
      for (const name of readdirSync(packages).sort()) {
        if (/^Claude_/.test(name)) out.push(join(packages, name, 'LocalCache', 'Roaming', 'Claude', FILE));
      }
    } catch {
      // no Packages folder
    }
  }
  return out;
}

// Existing config files, else the first candidate.
export function claudeDesktopTargets(): string[] {
  const all = claudeDesktopConfigCandidates();
  const existing = all.filter((f) => existsSync(f));
  return existing.length > 0 ? existing : all.slice(0, 1);
}

export async function isClaudeDesktopConfigured(): Promise<boolean> {
  for (const f of claudeDesktopTargets()) if (await hasMcpServer(f)) return true;
  return false;
}

export async function addToClaudeDesktop(spec: LaunchSpec) {
  const targets = claudeDesktopTargets();
  if (targets.length === 0) throw new IntegrationError('Could not find the Claude Desktop config location.');
  const written = [];
  for (const path of targets) {
    written.push({ path, ...(await mergeMcpServer(path, 'mcpServers', 'multiple-gmail', spec)) });
  }
  return written;
}
