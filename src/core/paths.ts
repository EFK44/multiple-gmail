import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

const APP = 'multiple-gmail';

// Per-OS default data folder: Windows %LOCALAPPDATA%\multiple-gmail, macOS ~/Library/Application Support/multiple-gmail,
// Linux and others $XDG_DATA_HOME/multiple-gmail or ~/.local/share/multiple-gmail.
export function defaultDataDir(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
  home: string,
): string {
  if (platform === 'win32') return join(env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), APP);
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', APP);
  // The XDG spec says relative values are invalid and must be ignored.
  const xdg = env.XDG_DATA_HOME;
  if (xdg && isAbsolute(xdg)) return join(xdg, APP);
  return join(home, '.local', 'share', APP);
}

export function dataDir(): string {
  const override = process.env.MULTIPLE_GMAIL_HOME;
  if (override) return override;
  if (process.env.VITEST && (process.env.VITEST_WORKER_ID || process.env.VITEST_POOL_ID)) throw new Error('Tests must set MULTIPLE_GMAIL_HOME');
  return defaultDataDir(process.platform, process.env, homedir());
}

export function tokenPath(id: string): string {
  return join(dataDir(), 'tokens', `${id}.enc`);
}

export function configPath(): string {
  return join(dataDir(), 'config.json');
}
