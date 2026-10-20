import { execFile } from 'node:child_process';
import { extname } from 'node:path';
import { system32Dir, systemBinary } from '../core/sysbin.js';
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

// How to run `claude`: an .exe directly (args array, no shell); a .cmd through cmd.exe /d /s /c with every
// argument double-quoted. Characters that could break out of the quoting are rejected outright.
export function claudeCodeSpawn(claudePath: string, spec: LaunchSpec, cmdExe: string): SpawnPlan {
  const args = claudeCodeArgs(spec);
  const ext = extname(claudePath).toLowerCase();
  if (ext === '.exe') return { file: claudePath, args, verbatim: false };
  if (ext !== '.cmd') throw new Error('Unsupported claude launcher.');
  for (const v of [claudePath, ...args]) {
    if (/["%\r\n\0]/.test(v)) throw new Error('Refusing to run: a path contains an unsafe character (" or %).');
  }
  const line = [claudePath, ...args].map((v) => `"${v}"`).join(' ');
  return { file: cmdExe, args: ['/d', '/s', '/c', `"${line}"`], verbatim: true };
}

export type RunResult = { code: number; stdout: string; stderr: string };

function run(file: string, args: string[], verbatim: boolean): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout: 60_000, windowsHide: true, windowsVerbatimArguments: verbatim, cwd: system32Dir(), maxBuffer: 1024 * 1024 },
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

// First .exe or .cmd that `where claude` reports (extensionless npm shims are shell scripts we cannot run).
export function findClaude(): Promise<string | null> {
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
