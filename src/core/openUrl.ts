import { execFile } from 'node:child_process';
import { isExecutableFile, posixBinary, system32Dir, systemBinary, type IsExecutable } from './sysbin.js';

const OPEN_TIMEOUT_MS = 10_000;

export type Opener = { file: string; args: string[]; cwd?: string };

// How to open a URL in the default browser on each platform. The one place to change per platform.
// Every opener is spawned by absolute path, never looked up on PATH. null when the URL is refused or no opener exists.
export function openerFor(platform: NodeJS.Platform, url: string, isExec: IsExecutable = isExecutableFile): Opener | null {
  if (!/^https?:\/\//i.test(url)) return null;
  if (platform === 'win32') {
    // Not explorer.exe: on current Windows 11 builds it ignores the URL and opens the Documents folder.
    // FileProtocolHandler hands the URL to the default browser. Absolute path, cwd in System32.
    return { file: systemBinary('rundll32'), args: ['url.dll,FileProtocolHandler', url], cwd: system32Dir() };
  }
  const file = posixBinary(platform === 'darwin' ? 'open' : 'xdg-open', isExec);
  return file ? { file, args: [url], cwd: '/' } : null;
}

// Best effort browser launch. Resolves true once the opener process has started, false when it could not be started
// (or the URL is refused); never rejects. The exit code is not checked (openers report it inconsistently).
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
