import { isSea } from 'node:sea';
import { fileURLToPath } from 'node:url';

export type LaunchSpec = { command: string; args: string[] };

// null when not running as the packaged exe.
export function exePath(): string | null {
  return isSea() ? process.execPath : null;
}

// How an AI client starts the stdio server. The packaged exe is its own launcher; in development it is node
// running the tsx CLI on src/main.ts. Every integration uses this one function.
export function stdioLaunchSpec(): LaunchSpec {
  const exe = exePath();
  if (exe) return { command: exe, args: ['--stdio'] };
  return {
    command: process.execPath,
    args: [
      fileURLToPath(new URL('../../node_modules/tsx/dist/cli.mjs', import.meta.url)),
      fileURLToPath(new URL('../main.ts', import.meta.url)),
      '--stdio',
    ],
  };
}
