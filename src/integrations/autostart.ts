import { execFile } from 'node:child_process';
import { mkdir, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { system32Dir, systemBinary } from '../core/sysbin.js';
import { stdioLaunchSpec, type LaunchSpec } from './launch.js';

export type RunPowerShell = (
  file: string,
  args: string[],
  opts: { env: Record<string, string>; cwd: string },
) => Promise<void>;

export type AutostartDeps = { launch?: LaunchSpec; run?: RunPowerShell };

// Constant script: every variable part (paths, arguments) arrives through the environment, never by text
// interpolation, so a path can never become code.
const SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$ws = New-Object -ComObject WScript.Shell',
  '$s = $ws.CreateShortcut($env:MG_LNK)',
  '$s.TargetPath = $env:MG_TARGET',
  '$s.Arguments = $env:MG_ARGS',
  '$s.WorkingDirectory = $env:MG_WD',
  '$s.WindowStyle = 7',
  '$s.Save()',
].join('; ');

export function startupShortcutPath(): string {
  const appData = process.env.APPDATA;
  if (!appData) throw new Error('APPDATA is not set.');
  return join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'multiple-gmail.lnk');
}

const quote = (a: string) => (/\s/.test(a) ? `"${a}"` : a);

const defaultRun: RunPowerShell = (file, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { env: { ...process.env, ...opts.env }, cwd: opts.cwd, windowsHide: true, timeout: 30_000 },
      (err) => (err ? reject(new Error('Could not create the startup shortcut.')) : resolve()),
    );
  });

export async function getAutostart(): Promise<boolean> {
  try {
    return (await stat(startupShortcutPath())).isFile();
  } catch {
    return false;
  }
}

export async function setAutostart(enabled: boolean, deps: AutostartDeps = {}): Promise<void> {
  const lnk = startupShortcutPath();
  if (!enabled) {
    await rm(lnk, { force: true });
    return;
  }
  const launch = deps.launch ?? stdioLaunchSpec();
  // Same launcher as stdio, but the server mode flag instead of --stdio.
  const args = [...launch.args.filter((a) => a !== '--stdio').map(quote), '--minimized'].join(' ');
  await mkdir(dirname(lnk), { recursive: true });
  await (deps.run ?? defaultRun)(
    systemBinary('powershell'),
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', SCRIPT],
    {
      env: { MG_LNK: lnk, MG_TARGET: launch.command, MG_ARGS: args, MG_WD: dirname(launch.command) },
      cwd: system32Dir(),
    },
  );
}
