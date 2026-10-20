import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFileAtomic } from '../../src/core/fsx.js';
import { defaultDataDir } from '../../src/core/paths.js';
import { ensureSecureDir } from '../../src/core/secureDir.js';
import { posixBinary, systemBinary } from '../../src/core/sysbin.js';

describe('defaultDataDir per OS', () => {
  const home = join('h', 'you');
  it('Windows uses %LOCALAPPDATA%\\multiple-gmail (fallback AppData\\Local)', () => {
    expect(defaultDataDir('win32', { LOCALAPPDATA: join('L', 'x') }, home)).toBe(join('L', 'x', 'multiple-gmail'));
    expect(defaultDataDir('win32', {}, home)).toBe(join(home, 'AppData', 'Local', 'multiple-gmail'));
  });
  it('macOS uses ~/Library/Application Support/multiple-gmail', () => {
    expect(defaultDataDir('darwin', { XDG_DATA_HOME: '/x' }, home)).toBe(join(home, 'Library', 'Application Support', 'multiple-gmail'));
  });
  it('Linux uses an absolute $XDG_DATA_HOME, else ~/.local/share', () => {
    expect(defaultDataDir('linux', { XDG_DATA_HOME: '/data/x' }, home)).toBe(join('/data/x', 'multiple-gmail'));
    expect(defaultDataDir('linux', { XDG_DATA_HOME: 'relative/x' }, home)).toBe(join(home, '.local', 'share', 'multiple-gmail'));
    expect(defaultDataDir('linux', {}, home)).toBe(join(home, '.local', 'share', 'multiple-gmail'));
  });
});

describe('system binaries', () => {
  it('Windows paths are Windows paths on every host', () => {
    expect(systemBinary('explorer')).toMatch(/^[A-Za-z]:\\.*\\explorer\.exe$/i);
    expect(systemBinary('powershell')).toMatch(/\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/i);
  });
  it('POSIX binaries resolve to the first existing absolute candidate only', () => {
    expect(posixBinary('security', () => true)).toBe('/usr/bin/security');
    expect(posixBinary('open', () => true)).toBe('/usr/bin/open');
    expect(posixBinary('xdg-open', (p) => p === '/bin/xdg-open')).toBe('/bin/xdg-open');
    expect(posixBinary('xdg-open', () => true)).toBe('/usr/bin/xdg-open');
    expect(posixBinary('secret-tool', () => false)).toBeNull();
    expect(() => posixBinary('sh', () => true)).toThrow();
  });
});

describe.skipIf(process.platform === 'win32')('POSIX permissions', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'mg-perm-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('ensureSecureDir creates 0700 directories even with a permissive umask', async () => {
    const prev = process.umask(0o000);
    try {
      const dir = join(root, 'a');
      await ensureSecureDir(dir);
      expect((await stat(dir)).mode & 0o777).toBe(0o700);
    } finally {
      process.umask(prev);
    }
  });

  it('writeFileAtomic writes 0600 files', async () => {
    const file = join(root, 'f.enc');
    await writeFileAtomic(file, 'x');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    await writeFileAtomic(join(root, 'g.enc'), 'y', { exclusive: true });
    expect((await stat(join(root, 'g.enc'))).mode & 0o777).toBe(0o600);
  });
});
