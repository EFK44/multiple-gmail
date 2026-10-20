import { describe, expect, it } from 'vitest';
import { claudeCodeArgs, claudeCodeCommand, claudeCodeSpawn } from '../../src/integrations/claudeCode.js';
import { stdioLaunchSpec } from '../../src/integrations/launch.js';
import { httpSnippets } from '../../src/integrations/snippets.js';

const exe = 'C:\\Users\\x\\Masaüstü\\a b\\multiple-gmail.exe';
const spec = { command: exe, args: ['--stdio'] };
const CMD = 'C:\\Windows\\System32\\cmd.exe';

describe('claudeCodeCommand', () => {
  it('quotes an exe path with spaces and non-ASCII characters', () => {
    expect(claudeCodeCommand(spec)).toBe(`claude mcp add --scope user multiple-gmail -- "${exe}" --stdio`);
  });
  it('args array has no shell quoting', () => {
    expect(claudeCodeArgs(spec)).toEqual(['mcp', 'add', '--scope', 'user', 'multiple-gmail', '--', exe, '--stdio']);
  });
});

describe('claudeCodeSpawn', () => {
  it('runs an .exe directly with an args array', () => {
    const r = claudeCodeSpawn('C:\\bin\\claude.exe', spec, CMD);
    expect(r).toEqual({ file: 'C:\\bin\\claude.exe', args: claudeCodeArgs(spec), verbatim: false });
  });
  it('runs a .cmd through cmd.exe /d /s /c with every argument quoted', () => {
    const r = claudeCodeSpawn('C:\\npm\\claude.cmd', spec, CMD);
    expect(r.file).toBe(CMD);
    expect(r.verbatim).toBe(true);
    expect(r.args.slice(0, 4)).toEqual(['/d', '/v:off', '/s', '/c']);
    expect(r.args[4]).toBe(
      `""C:\\npm\\claude.cmd" "mcp" "add" "--scope" "user" "multiple-gmail" "--" "${exe}" "--stdio""`,
    );
  });
  it('rejects quotes and percent signs', () => {
    expect(() => claudeCodeSpawn('C:\\n"pm\\claude.cmd', spec, CMD)).toThrow();
    expect(() => claudeCodeSpawn('C:\\npm\\claude.cmd', { command: 'C:\\%PATH%\\x.exe', args: ['--stdio'] }, CMD)).toThrow();
    expect(() => claudeCodeSpawn('C:\\npm\\claude.cmd', { command: 'C:\\a"b.exe', args: ['--stdio'] }, CMD)).toThrow();
  });
  it('rejects exclamation marks', () => {
    expect(() => claudeCodeSpawn('C:\\npm\\claude.cmd', { command: 'C:\\a!b.exe', args: ['--stdio'] }, CMD)).toThrow();
  });
  it('rejects an unknown extension', () => {
    expect(() => claudeCodeSpawn('C:\\npm\\claude.ps1', spec, CMD)).toThrow();
  });
});

describe('httpSnippets', () => {
  const s = httpSnippets(47110, '<YOUR_API_KEY>');
  it('cursor uses url and headers.Authorization', () => {
    expect(JSON.parse(s.cursor)).toEqual({
      mcpServers: {
        'multiple-gmail': {
          url: 'http://127.0.0.1:47110/mcp',
          headers: { Authorization: 'Bearer <YOUR_API_KEY>' },
        },
      },
    });
  });
  it('vscode uses servers with type http', () => {
    expect(JSON.parse(s.vscode)).toEqual({
      servers: {
        'multiple-gmail': {
          type: 'http',
          url: 'http://127.0.0.1:47110/mcp',
          headers: { Authorization: 'Bearer <YOUR_API_KEY>' },
        },
      },
    });
  });
  it('generic lists url and header', () => {
    expect(s.generic).toContain('http://127.0.0.1:47110/mcp');
    expect(s.generic).toContain('Authorization: Bearer <YOUR_API_KEY>');
  });
});

describe('stdioLaunchSpec', () => {
  it('in dev uses node plus tsx cli and src/main.ts, ending in --stdio', () => {
    const s = stdioLaunchSpec();
    expect(s.command).toBe(process.execPath);
    expect(s.args.at(-1)).toBe('--stdio');
    expect(s.args[0]).toMatch(/cli\.mjs$/);
    expect(s.args[1]).toMatch(/main\.ts$/);
  });
});
