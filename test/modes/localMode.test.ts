import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { saveConfig } from '../../src/core/config.js';
import { openerFor } from '../../src/core/openUrl.js';
import { runLocalMode, startLocalServer, type LocalServer } from '../../src/modes/localHttp.js';
import { raw, tempHome } from '../http/helpers.js';

let home: Awaited<ReturnType<typeof tempHome>>;
let server: LocalServer | undefined;

beforeEach(async () => {
  home = await tempHome('mg-localmode-');
});
afterEach(async () => {
  await server?.close();
  server = undefined;
  await home.cleanup();
});

const OPENING = 'Opening multiple-gmail in your browser...';
const HANDOFF =
  'multiple-gmail is already running; opened a new tab in your browser. If you do not see it, check your other browser windows.';

describe('first instance console output', () => {
  it('opens the browser without printing the single-use URL', async () => {
    const lines: string[] = [];
    const openUrl = vi.fn(async () => {});
    server = await startLocalServer({ port: 0, openBrowser: true }, { log: (s) => lines.push(s), openUrl });
    expect(openUrl).toHaveBeenCalledWith(server.url);
    expect(lines).toContain(OPENING);
    expect(lines.join('\n')).not.toContain('?t=');
  });

  it('says so when the browser could not be opened', async () => {
    const lines: string[] = [];
    server = await startLocalServer({ port: 0, openBrowser: true }, { log: (s) => lines.push(s), openUrl: async () => false });
    await new Promise((r) => setTimeout(r, 20));
    expect(lines).toContain('Could not open your browser; run multiple-gmail --print-url to get a setup link.');
  });

  it('--print-url prints a URL and does not open the browser', async () => {
    const lines: string[] = [];
    const openUrl = vi.fn(async () => {});
    server = await startLocalServer({ port: 0, openBrowser: false, printUrl: true }, { log: (s) => lines.push(s), openUrl });
    expect(openUrl).not.toHaveBeenCalled();
    expect(lines.join('\n')).toContain(server.url);
  });

  it('minimized prints neither the URL nor the opening line', async () => {
    const lines: string[] = [];
    server = await startLocalServer({ port: 0, openBrowser: false }, { log: (s) => lines.push(s) });
    expect(lines.join('\n')).not.toContain('?t=');
    expect(lines).not.toContain(OPENING);
  });
});

describe('second instance hand-off', () => {
  async function busyPort(): Promise<number> {
    server = await startLocalServer({ port: 0, openBrowser: false }, { log: () => {} });
    const port = Number(new URL(server.url).port);
    await saveConfig({ port, language: 'en', defaultAccount: null, accounts: {} });
    return port;
  }

  it('opens a fresh tab and says so, without printing the URL', async () => {
    const port = await busyPort();
    const lines: string[] = [];
    const openUrl = vi.fn(async (_url: string) => {});
    expect(await runLocalMode({ openBrowser: true }, { log: (s) => lines.push(s), openUrl })).toBe(0);
    expect(openUrl).toHaveBeenCalledTimes(1);
    const url = openUrl.mock.calls[0][0];
    expect(url.startsWith(`http://127.0.0.1:${port}/?t=`)).toBe(true);
    expect(url).not.toBe(server!.url);
    expect(lines).toEqual([HANDOFF]);
  });

  it('--print-url prints a fresh URL and does not open the browser', async () => {
    const port = await busyPort();
    const lines: string[] = [];
    const openUrl = vi.fn(async () => {});
    expect(await runLocalMode({ openBrowser: false, printUrl: true }, { log: (s) => lines.push(s), openUrl })).toBe(0);
    expect(openUrl).not.toHaveBeenCalled();
    const printed = lines.find((l) => l.includes(`http://127.0.0.1:${port}/?t=`));
    expect(printed).toBeDefined();
    // The printed link works once.
    const u = new URL(printed!.slice(printed!.indexOf('http')));
    expect((await raw(port, { path: u.pathname + u.search })).status).toBe(302);
  });

  it('does not claim a tab was opened when the browser could not be opened', async () => {
    await busyPort();
    const lines: string[] = [];
    expect(await runLocalMode({ openBrowser: true }, { log: (s) => lines.push(s), openUrl: async () => false })).toBe(0);
    expect(lines).toEqual([
      'multiple-gmail is already running.',
      'Could not open your browser; run multiple-gmail --print-url to get a setup link.',
    ]);
    const rejecting: string[] = [];
    await runLocalMode({ openBrowser: true }, { log: (s) => rejecting.push(s), openUrl: async () => { throw new Error('x'); } });
    expect(rejecting.join('\n')).toContain('Could not open your browser');
    expect(rejecting.join('\n')).not.toContain('opened a new tab');
  });

  it('minimized only reports that it is already running', async () => {
    await busyPort();
    const lines: string[] = [];
    const openUrl = vi.fn(async () => {});
    expect(await runLocalMode({ openBrowser: false }, { log: (s) => lines.push(s), openUrl })).toBe(0);
    expect(openUrl).not.toHaveBeenCalled();
    expect(lines).toEqual(['multiple-gmail is already running.']);
  });
});

describe('expired or used setup link', () => {
  it('tells the user, in English and Turkish, to close the tab and open multiple-gmail again', async () => {
    server = await startLocalServer({ port: 0, openBrowser: false }, { log: () => {} });
    const port = Number(new URL(server.url).port);
    const u = new URL(server.url);
    expect((await raw(port, { path: u.pathname + u.search })).status).toBe(302);
    const again = await raw(port, { path: u.pathname + u.search });
    expect(again.status).toBe(401);
    expect(again.headers['content-type']).toMatch(/^text\/html; charset=utf-8/);
    expect(again.body).toContain('This setup link has expired or was already used.');
    expect(again.body).toContain('Close this tab');
    expect(again.body).toContain('open multiple-gmail again');
    expect(again.body).toContain('Bu sekmeyi kapat');
    expect(again.body).not.toMatch(/<script/i);
  });

  it('the wizard "session ended" message says to close the tab and open multiple-gmail again', async () => {
    const en = JSON.parse(await readFile(new URL('../../src/web/i18n/en.json', import.meta.url), 'utf8'));
    const tr = JSON.parse(await readFile(new URL('../../src/web/i18n/tr.json', import.meta.url), 'utf8'));
    expect(en.errors.session).toContain('Close this tab');
    expect(en.errors.session).toContain('open multiple-gmail again');
    expect(tr.errors.session).toContain('sekmeyi kapat');
    expect(tr.errors.session).toContain("multiple-gmail'i yeniden aç");
  });
});

describe('browser opener', () => {
  it('uses explorer.exe by absolute path on Windows', () => {
    const o = openerFor('win32', 'http://127.0.0.1:47110/?t=x');
    expect(o).not.toBeNull();
    expect(o!.file).toMatch(/^[A-Za-z]:\\.*\\explorer\.exe$/i);
    expect(o!.args).toEqual(['http://127.0.0.1:47110/?t=x']);
  });
  it('uses /usr/bin/open on macOS and the first existing xdg-open on Linux, by absolute path', () => {
    const all = () => true;
    expect(openerFor('darwin', 'http://127.0.0.1:1/', all)).toEqual({ file: '/usr/bin/open', args: ['http://127.0.0.1:1/'], cwd: '/' });
    expect(openerFor('linux', 'http://127.0.0.1:1/', all)).toMatchObject({ file: '/usr/bin/xdg-open' });
    expect(openerFor('linux', 'http://127.0.0.1:1/', (p) => p === '/bin/xdg-open')).toMatchObject({ file: '/bin/xdg-open' });
    expect(openerFor('linux', 'http://127.0.0.1:1/', () => false)).toBeNull();
  });
  it('refuses non-http URLs on every OS', () => {
    for (const p of ['win32', 'darwin', 'linux'] as const) {
      expect(openerFor(p, 'file:///C:/x', () => true)).toBeNull();
      expect(openerFor(p, 'javascript:alert(1)', () => true)).toBeNull();
    }
  });
  it('openUrl resolves false for a refused URL', async () => {
    const { openUrl } = await import('../../src/core/openUrl.js');
    expect(await openUrl('javascript:alert(1)')).toBe(false);
  });
});
