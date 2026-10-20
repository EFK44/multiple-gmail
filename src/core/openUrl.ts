import { execFile } from 'node:child_process';
import { system32Dir, systemBinary } from './sysbin.js';

const OPEN_TIMEOUT_MS = 10_000;

// Best effort, fire-and-forget browser launch: resolves at once and never rejects (the URL is always printed too).
// The 10 s execFile timeout kills a hung opener so it cannot keep the process alive.
export async function openUrl(url: string): Promise<void> {
  if (!/^https?:\/\//i.test(url)) return;
  const ignore = () => {};
  try {
    if (process.platform === 'win32') {
      // explorer.exe exits with code 1 even on success: the result is ignored.
      execFile(systemBinary('explorer'), [url], { cwd: system32Dir(), timeout: OPEN_TIMEOUT_MS }, ignore);
    } else {
      execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { timeout: OPEN_TIMEOUT_MS }, ignore);
    }
  } catch {
    // Spawning failed synchronously: nothing to do.
  }
}
