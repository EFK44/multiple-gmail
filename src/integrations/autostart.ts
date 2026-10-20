import { execFile } from 'node:child_process';
import { mkdir, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { writeFileAtomic } from '../core/fsx.js';
import { system32Dir, systemBinary } from '../core/sysbin.js';
import { IntegrationError } from './jsonMerge.js';
import { stdioLaunchSpec, type LaunchSpec } from './launch.js';

export type RunPowerShell = (
  file: string,
  args: string[],
  opts: { env: Record<string, string>; cwd: string },
) => Promise<void>;

export type AutostartDeps = { launch?: LaunchSpec; run?: RunPowerShell; platform?: NodeJS.Platform };

export const LAUNCH_AGENT_LABEL = 'io.github.efk44.multiple-gmail';

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

// macOS: a per-user LaunchAgent, loaded by launchd at the next login.
export function launchAgentPath(): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${LAUNCH_AGENT_LABEL}.plist`);
}

// Linux (XDG Autostart): $XDG_CONFIG_HOME/autostart, default ~/.config/autostart.
export function xdgAutostartPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && isAbsolute(xdg) ? xdg : join(homedir(), '.config');
  return join(base, 'autostart', 'multiple-gmail.desktop');
}

export function autostartFile(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return startupShortcutPath();
  if (platform === 'darwin') return launchAgentPath();
  return xdgAutostartPath();
}

// Control characters cannot be represented safely in either file format; real paths never contain them.
function assertPrintable(values: string[]): void {
  if (values.some((v) => /[\u0000-\u001f\u007f]/.test(v))) {
    throw new IntegrationError('Refusing to set up autostart: a path contains a control character.');
  }
}

const xmlEscape = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

export function launchAgentPlist(programArguments: string[]): string {
  assertPrintable(programArguments);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${LAUNCH_AGENT_LABEL}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...programArguments.map((a) => `    <string>${xmlEscape(a)}</string>`),
    '  </array>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>ProcessType</key>',
    '  <string>Background</string>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

// Desktop Entry spec, Exec key: every argument is double-quoted; inside quotes ", `, $ and \ get a backslash; a literal
// % is written %%. The whole value is then escaped as a string value, which doubles every backslash again.
export function desktopExecArg(arg: string): string {
  const quoted = `"${arg.replace(/["`$\\]/g, (c) => `\\${c}`).replace(/%/g, '%%')}"`;
  return quoted.replace(/\\/g, '\\\\');
}

export function desktopEntry(programArguments: string[]): string {
  assertPrintable(programArguments);
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=multiple-gmail',
    'Comment=Multi-account Gmail MCP server',
    `Exec=${programArguments.map(desktopExecArg).join(' ')}`,
    'Terminal=false',
    'NoDisplay=true',
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n');
}

export async function getAutostart(platform: NodeJS.Platform = process.platform): Promise<boolean> {
  try {
    return (await stat(autostartFile(platform))).isFile();
  } catch {
    return false;
  }
}

export async function setAutostart(enabled: boolean, deps: AutostartDeps = {}): Promise<void> {
  const platform = deps.platform ?? process.platform;
  const file = autostartFile(platform);
  if (!enabled) {
    await rm(file, { force: true });
    return;
  }
  const launch = deps.launch ?? stdioLaunchSpec();
  // Same launcher as stdio, but the server mode flag instead of --stdio.
  const rest = launch.args.filter((a) => a !== '--stdio');
  if (platform !== 'win32') {
    // Written only; launchd and the desktop session pick it up at the next login. Loading it now (launchctl bootstrap)
    // would start a second copy right away, and unloading on disable (bootout) would stop the running one.
    const argv = [launch.command, ...rest, '--minimized'];
    await mkdir(dirname(file), { recursive: true });
    await writeFileAtomic(file, platform === 'darwin' ? launchAgentPlist(argv) : desktopEntry(argv));
    return;
  }
  const args = [...rest.map(quote), '--minimized'].join(' ');
  await mkdir(dirname(file), { recursive: true });
  await (deps.run ?? defaultRun)(
    systemBinary('powershell'),
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', SCRIPT],
    {
      env: { MG_LNK: file, MG_TARGET: launch.command, MG_ARGS: args, MG_WD: dirname(launch.command) },
      cwd: system32Dir(),
    },
  );
}
