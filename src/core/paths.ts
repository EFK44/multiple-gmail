import { homedir } from 'node:os';
import { join } from 'node:path';

export function dataDir(): string {
  const override = process.env.MULTIPLE_GMAIL_HOME;
  if (override) return override;
  if (process.env.VITEST && (process.env.VITEST_WORKER_ID || process.env.VITEST_POOL_ID)) throw new Error('Tests must set MULTIPLE_GMAIL_HOME');
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
    return join(base, 'multiple-gmail');
  }
  return join(homedir(), '.multiple-gmail');
}

export function tokenPath(alias: string): string {
  return join(dataDir(), 'tokens', `${alias}.enc`);
}

export function configPath(): string {
  return join(dataDir(), 'config.json');
}
