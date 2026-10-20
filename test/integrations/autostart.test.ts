import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getAutostart, setAutostart, startupShortcutPath } from '../../src/integrations/autostart.js';

let dir: string;
let prev: string | undefined;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mg-auto-'));
  prev = process.env.APPDATA;
  process.env.APPDATA = dir;
  await mkdir(join(dir, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup'), { recursive: true });
});
afterEach(async () => {
  if (prev === undefined) delete process.env.APPDATA;
  else process.env.APPDATA = prev;
  await rm(dir, { recursive: true, force: true });
});

const launch = { command: 'C:\\Users\\x\\Masaüstü\\a b\\multiple-gmail.exe', args: ['--stdio'] };

describe('autostart', () => {
  it('shortcut path is in the Startup folder', () => {
    expect(startupShortcutPath()).toBe(
      join(dir, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'multiple-gmail.lnk'),
    );
  });

  it('enabling passes paths via environment, never in the script text', async () => {
    let call: { file: string; args: string[]; env: Record<string, string>; cwd: string } | undefined;
    await setAutostart(true, {
      launch,
      run: async (file, args, opts) => {
        call = { file, args, env: opts.env, cwd: opts.cwd };
      },
    });
    expect(call!.file.toLowerCase()).toContain('powershell');
    const script = call!.args.at(-1)!;
    expect(script).toContain('CreateShortcut');
    expect(script).not.toContain('Masaüstü');
    expect(script).not.toContain(dir);
    expect(call!.env.MG_LNK).toBe(startupShortcutPath());
    expect(call!.env.MG_TARGET).toBe(launch.command);
    expect(call!.env.MG_ARGS).toBe('--minimized');
    expect(call!.cwd.toLowerCase()).toContain('system32');
  });

  it('disabling removes the shortcut; getAutostart reflects presence', async () => {
    await writeFile(startupShortcutPath(), 'x');
    expect(await getAutostart()).toBe(true);
    await setAutostart(false, { launch, run: async () => {} });
    expect(await getAutostart()).toBe(false);
  });

  it('dev launch keeps script arguments, quoted when needed, then --minimized', async () => {
    let env: Record<string, string> = {};
    await setAutostart(true, {
      launch: { command: 'node.exe', args: ['C:\\a b\\cli.mjs', 'C:\\a b\\main.ts', '--stdio'] },
      run: async (_f, _a, o) => {
        env = o.env;
      },
    });
    expect(env.MG_ARGS).toBe('"C:\\a b\\cli.mjs" "C:\\a b\\main.ts" --minimized');
  });
});
