import { accessSync, constants as fsConstants, statSync } from 'node:fs';
import { win32 } from 'node:path';

// Absolute paths to Windows system binaries. Never spawn these by bare name: CreateProcess searches the
// running executable's directory first, so a planted binary next to the exe would be run instead.
// Built with path.win32 so the result is the same Windows path on every host (identical to path on Windows).
const RELATIVE: Record<string, string[]> = {
  powershell: ['WindowsPowerShell', 'v1.0', 'powershell.exe'],
  icacls: ['icacls.exe'],
  explorer: ['..', 'explorer.exe'],
  where: ['where.exe'],
  cmd: ['cmd.exe'],
};

export function systemRoot(): string {
  const root = process.env.SystemRoot;
  return root && win32.isAbsolute(root) ? root : 'C:\\Windows';
}

export function system32Dir(): string {
  return win32.join(systemRoot(), 'System32');
}

export function systemBinary(name: string): string {
  const rel = RELATIVE[name];
  if (!rel) throw new Error(`Unknown system binary "${name}".`);
  return win32.join(system32Dir(), ...rel);
}

// macOS and Linux system binaries, by absolute path only (same reason as above: never a PATH lookup that a
// user-writable directory could win). The first existing executable candidate is used.
const POSIX_CANDIDATES: Record<string, string[]> = {
  security: ['/usr/bin/security'],
  open: ['/usr/bin/open'],
  'xdg-open': ['/usr/bin/xdg-open', '/bin/xdg-open'],
  'secret-tool': ['/usr/bin/secret-tool', '/bin/secret-tool'],
};

export type IsExecutable = (path: string) => boolean;

export const isExecutableFile: IsExecutable = (path) => {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
};

export function posixBinaryCandidates(name: string): string[] {
  const list = POSIX_CANDIDATES[name];
  if (!list) throw new Error(`Unknown system binary "${name}".`);
  return [...list];
}

// null when none of the candidates exists.
export function posixBinary(name: string, isExec: IsExecutable = isExecutableFile): string | null {
  return posixBinaryCandidates(name).find((p) => isExec(p)) ?? null;
}
