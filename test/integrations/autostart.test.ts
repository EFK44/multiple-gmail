import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  autostartFile,
  desktopEntry,
  desktopExecArg,
  getAutostart,
  launchAgentPlist,
  setAutostart,
  startupShortcutPath,
} from '../../src/integrations/autostart.js';

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
      platform: 'win32',
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
    expect(await getAutostart('win32')).toBe(true);
    await setAutostart(false, { launch, run: async () => {}, platform: 'win32' });
    expect(await getAutostart('win32')).toBe(false);
  });

  it('dev launch keeps script arguments, quoted when needed, then --minimized', async () => {
    let env: Record<string, string> = {};
    await setAutostart(true, {
      platform: 'win32',
      launch: { command: 'node.exe', args: ['C:\\a b\\cli.mjs', 'C:\\a b\\main.ts', '--stdio'] },
      run: async (_f, _a, o) => {
        env = o.env;
      },
    });
    expect(env.MG_ARGS).toBe('"C:\\a b\\cli.mjs" "C:\\a b\\main.ts" --minimized');
  });
});

describe('autostart on macOS and Linux', () => {
  let home: string;
  const prev: Record<string, string | undefined> = {};
  beforeEach(async () => {
    home = join(dir, 'Masaüstü home');
    await mkdir(home, { recursive: true });
    for (const k of ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME']) prev[k] = process.env[k];
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    delete process.env.XDG_CONFIG_HOME;
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const exe = '/Users/x/Masaüstü/a b & <c>/multiple-gmail';
  const noRun = async () => {
    throw new Error('must not spawn anything');
  };

  it('macOS writes an escaped LaunchAgent plist with RunAtLoad and removes it on disable', async () => {
    const file = join(home, 'Library', 'LaunchAgents', 'io.github.efk44.multiple-gmail.plist');
    expect(autostartFile('darwin')).toBe(file);
    await setAutostart(true, { platform: 'darwin', launch: { command: exe, args: ['--stdio'] }, run: noRun });
    const xml = await readFile(file, 'utf8');
    expect(xml).toContain('<string>io.github.efk44.multiple-gmail</string>');
    expect(xml).toContain(
      '<key>ProgramArguments</key>\n  <array>\n    <string>/Users/x/Masaüstü/a b &amp; &lt;c&gt;/multiple-gmail</string>\n' +
        '    <string>--minimized</string>\n  </array>',
    );
    expect(xml).toContain('<key>RunAtLoad</key>\n  <true/>');
    expect(xml).not.toContain('--stdio');
    expect(await getAutostart('darwin')).toBe(true);
    await setAutostart(false, { platform: 'darwin', run: noRun });
    expect(await getAutostart('darwin')).toBe(false);
  });

  it('plist escapes quotes and apostrophes and refuses control characters', () => {
    expect(launchAgentPlist([`/a"b'c`])).toContain('<string>/a&quot;b&apos;c</string>');
    expect(() => launchAgentPlist(['/a\nb'])).toThrow(/control character/);
  });

  it('Linux writes ~/.config/autostart/multiple-gmail.desktop with a quoted Exec line', async () => {
    const file = join(home, '.config', 'autostart', 'multiple-gmail.desktop');
    expect(autostartFile('linux')).toBe(file);
    await setAutostart(true, { platform: 'linux', launch: { command: '/home/x/Masaüstü/a b/multiple-gmail', args: ['--stdio'] }, run: noRun });
    const text = await readFile(file, 'utf8');
    expect(text.startsWith('[Desktop Entry]\n')).toBe(true);
    expect(text).toContain('Type=Application\n');
    expect(text).toContain('Exec="/home/x/Masaüstü/a b/multiple-gmail" "--minimized"\n');
    expect(await getAutostart('linux')).toBe(true);
    await setAutostart(false, { platform: 'linux', run: noRun });
    expect(await getAutostart('linux')).toBe(false);
  });

  it('Linux honours an absolute XDG_CONFIG_HOME', () => {
    process.env.XDG_CONFIG_HOME = join(home, 'cfg');
    expect(autostartFile('linux')).toBe(join(home, 'cfg', 'autostart', 'multiple-gmail.desktop'));
    process.env.XDG_CONFIG_HOME = 'relative';
    expect(autostartFile('linux')).toBe(join(home, '.config', 'autostart', 'multiple-gmail.desktop'));
  });

  // Reverse of the Desktop Entry rules: string unescape first, then split quoted arguments.
  function parseExec(value: string): string[] {
    const s = value.replace(/\\([\\sntr])/g, (_m, c: string) => ({ '\\': '\\', s: ' ', n: '\n', t: '\t', r: '\r' })[c]!);
    const out: string[] = [];
    const re = /"((?:[^"\\]|\\["`$\\])*)"/g;
    for (const m of s.matchAll(re)) out.push(m[1].replace(/\\(["`$\\])/g, '$1').replace(/%%/g, '%'));
    return out;
  }

  it('Exec quoting round-trips quotes, backslashes, dollar, backtick and percent', () => {
    const nasty = '/home/x/a "b" \\c $HOME `id` 100%/mg';
    expect(desktopExecArg('/a b')).toBe('"/a b"');
    expect(desktopExecArg('a"b')).toBe('"a\\\\"b"');
    expect(desktopExecArg('a\\b')).toBe('"a\\\\\\\\b"');
    expect(desktopExecArg('a%b')).toBe('"a%%b"');
    const line = desktopEntry([nasty, '--minimized']).split('\n').find((l) => l.startsWith('Exec='))!;
    expect(parseExec(line.slice('Exec='.length))).toEqual([nasty, '--minimized']);
    expect(() => desktopEntry(['/a\tb'])).toThrow(/control character/);
  });
});
