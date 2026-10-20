import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { combinedStatus, IntegrationError, mergeMcpServer, type IntegrationStatus } from './jsonMerge.js';
import { stdioLaunchSpec, type LaunchSpec } from './launch.js';

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

const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

// Windows: every Store v3 config folder (file or not), plus the classic and old Store files that exist. With none of
// those, the classic path (created on write).
// macOS: ~/Library/Application Support/Claude/claude_desktop_config.json (created on write).
// Linux: ~/.config/Claude/claude_desktop_config.json, only when ~/.config/Claude exists (no official Linux build, so a
// missing folder means unsupported, reported as no targets).
export function claudeDesktopTargets(platform: NodeJS.Platform = process.platform): string[] {
  if (platform === 'darwin') return [join(homedir(), 'Library', 'Application Support', 'Claude', FILE)];
  if (platform !== 'win32') {
    const dir = join(homedir(), '.config', 'Claude');
    return platform === 'linux' && isDir(dir) ? [join(dir, FILE)] : [];
  }
  const store = claudeDesktopStoreTargets();
  const classic = classicTarget();
  const others = [...(classic ? [classic] : []), ...legacyPackageFiles()].filter((f) => existsSync(f));
  const out = [...store, ...others];
  if (out.length > 0) return out;
  return classic ? [classic] : [];
}

// Configured only when every target has an entry that runs `command` (this copy): a stale copy in one place must not
// hide a missing one, and an entry for an old path is reported as outdated so the UI offers Update.
export function claudeDesktopStatus(
  platform: NodeJS.Platform = process.platform,
  command: string = stdioLaunchSpec().command,
): Promise<IntegrationStatus> {
  return combinedStatus(claudeDesktopTargets(platform), command);
}

export async function isClaudeDesktopConfigured(
  platform: NodeJS.Platform = process.platform,
  command: string = stdioLaunchSpec().command,
): Promise<boolean> {
  return (await claudeDesktopStatus(platform, command)).configured;
}

export async function addToClaudeDesktop(spec: LaunchSpec, platform: NodeJS.Platform = process.platform) {
  const targets = claudeDesktopTargets(platform);
  if (targets.length === 0) throw new IntegrationError('Could not find the Claude Desktop config location.');
  const written = [];
  for (const path of targets) {
    written.push({ path, ...(await mergeMcpServer(path, 'mcpServers', 'multiple-gmail', spec)) });
  }
  return written;
}
