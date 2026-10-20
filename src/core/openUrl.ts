import { execFile } from 'node:child_process';
import { system32Dir, systemBinary } from './sysbin.js';

const OPEN_TIMEOUT_MS = 10_000;

export type Opener = { file: string; args: string[]; cwd?: string };

// How to open a URL in the default browser on each platform. The one place to change per platform.
export function openerFor(platform: NodeJS.Platform, url: string): Opener | null {
  if (!/^https?:\/\//i.test(url)) return null;
  switch (platform) {
    case 'win32':
      // Absolute path, cwd in System32: never resolve explorer.exe from the exe's own folder.
      return { file: systemBinary('explorer'), args: [url], cwd: system32Dir() };
    case 'darwin':
      return { file: 'open', args: [url] };
    default:
      return { file: 'xdg-open', args: [url] };
  }
}

// Best effort browser launch. Resolves true once the opener process has started, false when it could not be started
// (or the URL is refused); never rejects. The exit code is not checked: explorer.exe exits with 1 even on success.
// The 10 s execFile timeout kills a hung opener so it cannot keep the process alive.
export async function openUrl(url: string): Promise<boolean> {
  const o = openerFor(process.platform, url);
  if (!o) return false;
  return new Promise((resolve) => {
    try {
      const child = execFile(o.file, o.args, { ...(o.cwd ? { cwd: o.cwd } : {}), timeout: OPEN_TIMEOUT_MS }, () => {});
      child.once('spawn', () => resolve(true));
      child.once('error', () => resolve(false));
    } catch {
      resolve(false);
    }
  });
}
