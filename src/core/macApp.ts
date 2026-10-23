import { execFile } from 'node:child_process';
import { posixBinary, type IsExecutable, isExecutableFile } from './sysbin.js';

const STEP_TIMEOUT_MS = 10_000;

// The .app bundle that contains `execPath` when multiple-gmail.app was opened from Finder: macOS, no arguments
// and no terminal. null otherwise (Terminal, Claude's --stdio, Start at login's --minimized, a plain binary), and
// also under App Translocation (a quarantined app started from Downloads runs from a random read-only copy), where
// the program runs as is in the background.
export function finderLaunchBundle(platform: NodeJS.Platform, execPath: string, argv: string[], isTty: boolean): string | null {
  if (platform !== 'darwin' || argv.length > 0 || isTty) return null;
  const m = /^(\/.+\.app)\/Contents\/MacOS\/[^/]+$/.exec(execPath);
  if (!m || execPath.includes('/AppTranslocation/')) return null;
  return m[1];
}

export type Step = { file: string; args: string[] };

// Gatekeeper already let the bundle start (the user approved it), so its download mark is removed first:
// otherwise Terminal, which starts the inner executable directly, can be blocked again.
// Then Terminal opens a window that runs the same executable, like the console window on Windows.
export function reopenSteps(bundle: string, execPath: string, isExec: IsExecutable = isExecutableFile): Step[] | null {
  const xattr = posixBinary('xattr', isExec);
  const open = posixBinary('open', isExec);
  if (!open) return null;
  return [
    ...(xattr ? [{ file: xattr, args: ['-dr', 'com.apple.quarantine', bundle] }] : []),
    { file: open, args: ['-a', 'Terminal', execPath] },
  ];
}

function runStep(step: Step): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      execFile(step.file, step.args, { cwd: '/', timeout: STEP_TIMEOUT_MS }, (e) => resolve(!e));
    } catch {
      resolve(false);
    }
  });
}

// True when the program was handed to Terminal and this process should exit; false to run normally.
export async function reopenInTerminal(argv: string[]): Promise<boolean> {
  const bundle = finderLaunchBundle(process.platform, process.execPath, argv, !!process.stdin.isTTY);
  if (!bundle) return false;
  const steps = reopenSteps(bundle, process.execPath);
  if (!steps) return false;
  const last = steps.pop()!;
  for (const step of steps) await runStep(step);
  return runStep(last);
}
