import { isSea } from 'node:sea';
import { bundleFile, srcPath } from '../core/runtime.js';

export type LaunchSpec = { command: string; args: string[] };

// null when not running as the packaged exe.
export function exePath(): string | null {
  return isSea() ? process.execPath : null;
}

// How an AI client starts the stdio server. The packaged exe is its own launcher; `node build/main.cjs` relaunches
// the bundle; in development it is node running the tsx CLI on src/main.ts. Every integration uses this one function.
export function stdioLaunchSpec(): LaunchSpec {
  const exe = exePath();
  if (exe) return { command: exe, args: ['--stdio'] };
  const bundle = bundleFile();
  if (bundle) return { command: process.execPath, args: [bundle, '--stdio'] };
  return {
    command: process.execPath,
    args: [srcPath('../node_modules/tsx/dist/cli.mjs'), srcPath('main.ts'), '--stdio'],
  };
}
