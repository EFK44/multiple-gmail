import { realpathSync } from 'node:fs';
import { isSea } from 'node:sea';
import { pathToFileURL } from 'node:url';
import { reopenInTerminal } from './core/macApp.js';
import { runCli } from './modes/cli.js';
import { runStdio } from './modes/stdio.js';

export async function main(argv: string[]): Promise<void> {
  if (argv[0] === '--stdio') {
    runStdio();
    return;
  }
  if (await reopenInTerminal(argv)) return;
  process.exitCode = await runCli(argv);
}

// Run only when this module is the program entry: the packaged exe (SEA) always is; otherwise compare this
// module's URL with the script path in argv[1] (tsx src/main.ts, node build/main.cjs, where the bundle maps import.meta.url to its own file). Importing it (tests) does not run it.
function isEntryPoint(): boolean {
  if (isSea()) return true;
  const script = process.argv[1];
  if (!script) return false;
  try {
    return pathToFileURL(realpathSync(script)).href === pathToFileURL(realpathSync(new URL(import.meta.url))).href;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  });
}
