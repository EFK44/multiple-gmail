import { runCli } from './modes/cli.js';
import { runStdio } from './modes/stdio.js';

export async function main(argv: string[]): Promise<void> {
  if (argv[0] === '--stdio') {
    runStdio();
    return;
  }
  process.exitCode = await runCli(argv);
}

main(process.argv.slice(2)).catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
