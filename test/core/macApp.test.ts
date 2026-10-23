import { describe, expect, it } from 'vitest';
import { finderLaunchBundle, reopenInTerminal, reopenSteps } from '../../src/core/macApp.js';

const EXEC = '/Applications/multiple-gmail.app/Contents/MacOS/multiple-gmail';

describe('finderLaunchBundle', () => {
  it('returns the bundle for a Finder start of the .app on macOS', () => {
    expect(finderLaunchBundle('darwin', EXEC, [], false)).toBe('/Applications/multiple-gmail.app');
    expect(finderLaunchBundle('darwin', '/Users/a b/Apps/m.app/Contents/MacOS/m', [], false)).toBe('/Users/a b/Apps/m.app');
  });
  it('is null in Terminal, with arguments, outside a bundle, on other systems and under App Translocation', () => {
    expect(finderLaunchBundle('darwin', EXEC, [], true)).toBeNull();
    expect(finderLaunchBundle('darwin', EXEC, ['--stdio'], false)).toBeNull();
    expect(finderLaunchBundle('darwin', EXEC, ['--minimized'], false)).toBeNull();
    expect(finderLaunchBundle('darwin', '/Users/a/Applications/multiple-gmail', [], false)).toBeNull();
    expect(finderLaunchBundle('darwin', '/x/m.app/Contents/Resources/m', [], false)).toBeNull();
    expect(finderLaunchBundle('linux', EXEC, [], false)).toBeNull();
    expect(finderLaunchBundle('win32', EXEC, [], false)).toBeNull();
    expect(
      finderLaunchBundle('darwin', '/private/var/folders/x/AppTranslocation/1234/d/m.app/Contents/MacOS/m', [], false),
    ).toBeNull();
  });
});

describe('reopenSteps', () => {
  it('clears the download mark of the bundle, then runs the executable in Terminal, by absolute paths', () => {
    expect(reopenSteps('/Applications/multiple-gmail.app', EXEC, () => true)).toEqual([
      { file: '/usr/bin/xattr', args: ['-dr', 'com.apple.quarantine', '/Applications/multiple-gmail.app'] },
      { file: '/usr/bin/open', args: ['-a', 'Terminal', EXEC] },
    ]);
  });
  it('skips xattr when it is missing and gives up without open', () => {
    expect(reopenSteps('/A.app', EXEC, (p) => p === '/usr/bin/open')).toEqual([
      { file: '/usr/bin/open', args: ['-a', 'Terminal', EXEC] },
    ]);
    expect(reopenSteps('/A.app', EXEC, () => false)).toBeNull();
  });
  it('reopenInTerminal does nothing outside a Finder-started .app', async () => {
    expect(await reopenInTerminal(['--version'])).toBe(false);
  });
});
