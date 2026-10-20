import { describe, expect, it, vi } from 'vitest';

const assets: Record<string, string> = {
  'web/index.html': '<!doctype html><title>multiple-gmail</title>',
  'web/i18n/en.json': '{}',
};
const getAsset = vi.fn((key: string) => {
  const v = assets[key];
  if (v === undefined) throw new Error(`no asset ${key}`);
  return new TextEncoder().encode(v).buffer;
});
vi.mock('node:sea', () => ({ isSea: () => true, getAsset }));

const { readStatic } = await import('../../src/http/static.js');
const { stdioLaunchSpec } = await import('../../src/integrations/launch.js');

describe('readStatic under SEA', () => {
  it('reads embedded assets keyed web/<posix path>', async () => {
    const r = await readStatic('/');
    expect(r?.type).toMatch(/^text\/html/);
    expect(r?.body.toString('utf8')).toContain('multiple-gmail');
    expect((await readStatic('/i18n/en.json'))?.body.toString('utf8')).toBe('{}');
    expect(getAsset).toHaveBeenCalledWith('web/i18n/en.json');
  });

  it('applies the same traversal and missing-file rules', async () => {
    getAsset.mockClear();
    for (const p of ['/../package.json', '/..%2fpackage.json', '/%2e%2e/package.json', '/..\\package.json',
      '/.hidden', '/index.html%00.js', '/%zz', 'C:/Windows/win.ini', '/i18n//en.json']) {
      expect(await readStatic(p), p).toBeNull();
    }
    expect(getAsset).not.toHaveBeenCalled();
    expect(await readStatic('/nope.html')).toBeNull();
  });
});

describe('stdioLaunchSpec under SEA', () => {
  it('is the exe itself with --stdio', () => {
    expect(stdioLaunchSpec()).toEqual({ command: process.execPath, args: ['--stdio'] });
  });
});
