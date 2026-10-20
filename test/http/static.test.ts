import { describe, expect, it } from 'vitest';
import { readStatic } from '../../src/http/static.js';

describe('readStatic', () => {
  it('serves index.html for /', async () => {
    const r = await readStatic('/');
    expect(r?.type).toMatch(/^text\/html/);
    expect(r?.body.toString('utf8')).toContain('multiple-gmail');
    expect((await readStatic('/index.html'))?.type).toMatch(/^text\/html/);
  });

  it('refuses traversal, dotfiles, and missing files', async () => {
    for (const p of [
      '/../package.json',
      '/..%2fpackage.json',
      '/%2e%2e/package.json',
      '/..\\package.json',
      '/%5c..%5cpackage.json',
      '/.hidden',
      '/nope.html',
      '/index.html%00.js',
      '/%zz',
      'C:/Windows/win.ini',
    ]) {
      expect(await readStatic(p), p).toBeNull();
    }
  });
});
