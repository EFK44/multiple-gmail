import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { hasMcpServer, IntegrationError, mergeMcpServer } from './jsonMerge.js';
import type { LaunchSpec } from './launch.js';

const FILE = 'claude_desktop_config.json';

function subdirs(dir: string, re: RegExp): string[] {
  try {
    return readdirSync(dir)
      .filter((n) => re.test(n))
      .sort()
      .filter((n) => {
        try {
          return statSync(join(dir, n)).isDirectory();
        } catch {
          return false;
        }
      });
  } catch {
    return [];
  }
}

// Claude Desktop 3.x from the Microsoft Store (MSIX, package family Claude_<publisherId>) reads
// %LOCALAPPDATA%\Claude-Data\claude_<publisherId>\claude_desktop_config.json. That file also holds the app's own
// preferences, so it is only ever merged into. Its folder existing means that install is present.
export function claudeDesktopStoreTargets(): string[] {
  const local = process.env.LOCALAPPDATA;
  if (!local) return [];
  const base = join(local, 'Claude-Data');
  return subdirs(base, /^claude_/i).map((n) => join(base, n, FILE));
}

// The classic installer reads %APPDATA%\Claude\claude_desktop_config.json.
function classicTarget(): string | null {
  const appData = process.env.APPDATA;
  return appData ? join(appData, 'Claude', FILE) : null;
}

// Older Store builds: %LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude (used only if the file exists).
function legacyPackageFiles(): string[] {
  const local = process.env.LOCALAPPDATA;
  if (!local) return [];
  const packages = join(local, 'Packages');
  return subdirs(packages, /^Claude_/).map((n) => join(packages, n, 'LocalCache', 'Roaming', 'Claude', FILE));
}

export function claudeDesktopConfigCandidates(): string[] {
  const classic = classicTarget();
  return [...claudeDesktopStoreTargets(), ...(classic ? [classic] : []), ...legacyPackageFiles()];
}

// Every Store v3 config folder (file or not), plus the classic and old Store files that exist. With none of those,
// the classic path (created on write).
export function claudeDesktopTargets(): string[] {
  const store = claudeDesktopStoreTargets();
  const classic = classicTarget();
  const others = [...(classic ? [classic] : []), ...legacyPackageFiles()].filter((f) => existsSync(f));
  const out = [...store, ...others];
  if (out.length > 0) return out;
  return classic ? [classic] : [];
}

// Configured only when every target has the entry: a stale copy in one place must not hide a missing one.
export async function isClaudeDesktopConfigured(): Promise<boolean> {
  const targets = claudeDesktopTargets();
  if (targets.length === 0) return false;
  for (const f of targets) if (!(await hasMcpServer(f))) return false;
  return true;
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
