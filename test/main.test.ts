import { expect, it, vi } from 'vitest';

const runCli = vi.fn(async () => 0);
vi.mock('../src/modes/cli.js', () => ({ runCli }));
vi.mock('../src/modes/stdio.js', () => ({ runStdio: vi.fn() }));

it('importing main does not run it', async () => {
  const mod = await import('../src/main.js');
  await new Promise((r) => setTimeout(r, 20));
  expect(runCli).not.toHaveBeenCalled();
  await mod.main(['--version']);
  expect(runCli).toHaveBeenCalledWith(['--version']);
});
