import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { extname, posix } from 'node:path';
import { isExecutableFile, system32Dir, systemBinary, type IsExecutable } from '../core/sysbin.js';
import type { LaunchSpec } from './launch.js';

export function claudeCodeArgs(spec: LaunchSpec): string[] {
  return ['mcp', 'add', '--scope', 'user', 'multiple-gmail', '--', spec.command, ...spec.args];
}

const needsQuote = (s: string) => /[\s"]/.test(s);

// Display string for copy/paste: the executable is always quoted, other arguments only when needed.
export function claudeCodeCommand(spec: LaunchSpec): string {
  const rest = spec.args.map((a) => (needsQuote(a) ? `"${a}"` : a));
  return `claude mcp add --scope user multiple-gmail -- "${spec.command}" ${rest.join(' ')}`.trimEnd();
}

export type SpawnPlan = { file: string; args: string[]; verbatim: boolean };

// How to run `claude`: on macOS and Linux the file itself (no shell; a script runs through its shebang). On Windows an
// .exe directly (args array, no shell); a .cmd through cmd.exe /d /s /c with every argument double-quoted. Characters
// that could break out of the quoting are rejected outright.
export function claudeCodeSpawn(
  claudePath: string,
  spec: LaunchSpec,
  cmdExe: string,
  platform: NodeJS.Platform = process.platform,
): SpawnPlan {
  const args = claudeCodeArgs(spec);
  if (platform !== 'win32') {
    if (!posix.isAbsolute(claudePath)) throw new Error('Unsupported claude launcher.');
    return { file: claudePath, args, verbatim: false };
  }
  const ext = extname(claudePath).toLowerCase();
  if (ext === '.exe') return { file: claudePath, args, verbatim: false };
  if (ext !== '.cmd') throw new Error('Unsupported claude launcher.');
  for (const v of [claudePath, ...args]) {
    if (/["%!\r\n\0]/.test(v)) throw new Error('Refusing to run: a path contains an unsafe character (" % or !).');
  }
  const line = [claudePath, ...args].map((v) => `"${v}"`).join(' ');
  return { file: cmdExe, args: ['/d', '/v:off', '/s', '/c', `"${line}"`], verbatim: true };
}

export type RunResult = { code: number; stdout: string; stderr: string };

function run(file: string, args: string[], verbatim: boolean): Promise<RunResult> {
  const cwd = process.platform === 'win32' ? system32Dir() : homedir();
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      // Note: the timeout kills only the process started here (cmd.exe for .cmd launchers), not its children.
      { timeout: 60_000, windowsHide: true, windowsVerbatimArguments: verbatim, cwd, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        const raw = err ? (err as { code?: unknown }).code : 0;
        const code = typeof raw === 'number' ? raw : err ? 1 : 0;
        resolve({ code, stdout: String(stdout), stderr: err && !stderr ? err.message : String(stderr) });
      },
    );
  });
}

export function runClaudeAdd(claudePath: string, spec: LaunchSpec): Promise<RunResult> {
  const plan = claudeCodeSpawn(claudePath, spec, systemBinary('cmd'));
  return run(plan.file, plan.args, plan.verbatim);
}

// Usual install locations, checked after PATH: an app started from Finder, launchd or a desktop autostart often has a
// minimal PATH without them. Native installer, Homebrew on Apple Silicon, Homebrew on Intel and npm -g defaults.
export function claudeFallbackCandidates(home: string): string[] {
  return [posix.join(home, '.local', 'bin', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude'];
}

// macOS and Linux: the first absolute PATH entry holding an executable file named `claude`, then the fixed
// candidates above. Relative entries (".", "") are skipped so the current directory can never supply the binary.
// No shell is involved.
export function findClaudeOnPath(
  pathEnv: string | undefined,
  isExec: IsExecutable = isExecutableFile,
  home: string = homedir(),
): string | null {
  for (const dir of (pathEnv ?? '').split(':')) {
    if (!dir || !posix.isAbsolute(dir)) continue;
    const candidate = posix.join(dir, 'claude');
    if (isExec(candidate)) return candidate;
  }
  // The ~/.local/bin candidate is used only with an absolute home.
  const fallbacks = claudeFallbackCandidates(home).slice(posix.isAbsolute(home) ? 0 : 1);
  return fallbacks.find((p) => isExec(p)) ?? null;
}

// Windows: first .exe or .cmd that `where claude` reports (extensionless npm shims are shell scripts we cannot run).
export function findClaude(): Promise<string | null> {
  if (process.platform !== 'win32') return Promise.resolve(findClaudeOnPath(process.env.PATH));
  return new Promise((resolve) => {
    execFile(systemBinary('where'), ['claude'], { timeout: 10_000, windowsHide: true, cwd: system32Dir() }, (err, stdout) => {
      if (err) return resolve(null);
      const hit = String(stdout)
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => /\.(exe|cmd)$/i.test(l));
      resolve(hit ?? null);
    });
  });
}
