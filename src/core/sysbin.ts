import { isAbsolute, join } from 'node:path';

// Absolute paths to Windows system binaries. Never spawn these by bare name: CreateProcess searches the
// running executable's directory first, so a planted binary next to the exe would be run instead.
const RELATIVE: Record<string, string[]> = {
  powershell: ['WindowsPowerShell', 'v1.0', 'powershell.exe'],
  icacls: ['icacls.exe'],
  explorer: ['..', 'explorer.exe'],
  where: ['where.exe'],
};

export function systemRoot(): string {
  const root = process.env.SystemRoot;
  return root && isAbsolute(root) ? root : 'C:\\Windows';
}

export function system32Dir(): string {
  return join(systemRoot(), 'System32');
}

export function systemBinary(name: string): string {
  const rel = RELATIVE[name];
  if (!rel) throw new Error(`Unknown system binary "${name}".`);
  return join(system32Dir(), ...rel);
}
