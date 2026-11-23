import { mkdir, mkdtemp, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_ATTACHMENT_BYTES, loadAttachments } from '../../src/gmail/attachments.js';

let root: string;
let home: string;
let data: string;
const opts = () => ({ home, dataDir: data });

async function file(rel: string, content: string | number = 'x'): Promise<string> {
  const p = join(root, rel);
  await mkdir(join(p, '..'), { recursive: true });
  if (typeof content === 'number') {
    await writeFile(p, '');
    await truncate(p, content);
  } else await writeFile(p, content);
  return p;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mg-att-'));
  home = join(root, 'home');
  data = join(root, 'data');
  await mkdir(home, { recursive: true });
  await mkdir(data, { recursive: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('loadAttachments', () => {
  it('returns [] for undefined or empty', async () => {
    expect(await loadAttachments(undefined, opts())).toEqual([]);
    expect(await loadAttachments([], opts())).toEqual([]);
  });

  it('loads a file, defaulting the filename to its basename', async () => {
    const p = await file('home/Desktop/Fiyat listesi şubat.xlsx', 'abc');
    const [a] = await loadAttachments([{ path: p }], opts());
    expect(a.filename).toBe('Fiyat listesi şubat.xlsx');
    expect(a.content.toString()).toBe('abc');
  });

  it('uses the filename override', async () => {
    const p = await file('home/a.png');
    const [a] = await loadAttachments([{ path: p, filename: 'logo.png' }], opts());
    expect(a.filename).toBe('logo.png');
  });

  it('rejects a relative path', async () => {
    await expect(loadAttachments([{ path: 'a.png' }], opts())).rejects.toThrow(/absolute/);
  });

  it('rejects a missing file', async () => {
    await expect(loadAttachments([{ path: join(home, 'nope.pdf') }], opts())).rejects.toThrow(/not found/i);
  });

  it('rejects a directory', async () => {
    await expect(loadAttachments([{ path: home }], opts())).rejects.toThrow(/not a file/i);
  });

  it('rejects files in .ssh and the app data folder', async () => {
    const k = await file('home/.ssh/id_ed25519', 'secret');
    const t = await file('data/tokens/a.enc', 'secret');
    await expect(loadAttachments([{ path: k }], opts())).rejects.toThrow(/not allowed/);
    await expect(loadAttachments([{ path: t }], opts())).rejects.toThrow(/not allowed/);
  });

  it('rejects credential files and browser profiles', async () => {
    for (const rel of [
      'home/.git-credentials',
      'home/.netrc',
      'home/AppData/Local/Google/Chrome/User Data/Default/Login Data',
      'home/AppData/Roaming/Mozilla/Firefox/Profiles/x/logins.json',
      'home/Library/Keychains/login.keychain-db',
      'home/.config/google-chrome/Default/Cookies',
    ]) {
      const p = await file(rel, 'secret');
      await expect(loadAttachments([{ path: p }], opts()), rel).rejects.toThrow(/not allowed/);
    }
  });

  it('rejects a ..-named entry inside a denied folder', async () => {
    const p = await file('home/.ssh/..backup/id_rsa', 'secret');
    await expect(loadAttachments([{ path: p }], opts())).rejects.toThrow(/not allowed/);
  });

  it('rejects files under %APPDATA% and %LOCALAPPDATA% equivalents', async () => {
    const roaming = join(root, 'roaming');
    const local = join(root, 'local');
    const o = { ...opts(), appData: roaming, localAppData: local };
    for (const p of [
      await file('roaming/gcloud/credentials.db', 's'),
      await file('roaming/GitHub CLI/hosts.yml', 's'),
      await file('roaming/Thunderbird/Profiles/x/logins.json', 's'),
      await file('roaming/Opera Software/Opera Stable/Login Data', 's'),
      await file('local/Vivaldi/User Data/Default/Login Data', 's'),
      await file('local/Google/Chrome/User Data/Default/Cookies', 's'),
      await file('home/.thunderbird/x/logins.json', 's'),
    ]) {
      await expect(loadAttachments([{ path: p }], o), p).rejects.toThrow(/not allowed/);
    }
  });

  it('rejects UNC and device paths on Windows without touching the network', async () => {
    const o = { ...opts(), platform: 'win32' as const };
    for (const p of ['\\\\attacker.example\\share\\x.png', '//attacker.example/share/x.png', '\\\\.\\C:\\x.png']) {
      await expect(loadAttachments([{ path: p }], o), p).rejects.toThrow(/network|drive letter/i);
    }
  });

  it('does not treat a lookalike folder as .ssh', async () => {
    const p = await file('home/.sshkeys/x.txt');
    expect(await loadAttachments([{ path: p }], opts())).toHaveLength(1);
  });

  it('rejects a link that points into .ssh', async () => {
    const k = await file('home/.ssh/id_ed25519', 'secret');
    const link = join(home, 'Desktop', 'harmless.txt');
    await mkdir(join(home, 'Desktop'), { recursive: true });
    try {
      await symlink(k, link, 'file');
    } catch {
      return; // symlinks need extra rights on some Windows setups
    }
    await expect(loadAttachments([{ path: link }], opts())).rejects.toThrow(/not allowed/);
  });

  it('rejects more than 25 MB in total', async () => {
    const a = await file('home/a.bin', MAX_ATTACHMENT_BYTES - 10);
    const b = await file('home/b.bin', 20);
    expect(MAX_ATTACHMENT_BYTES).toBe(25 * 1024 * 1024);
    await expect(loadAttachments([{ path: a }, { path: b }], opts())).rejects.toThrow(/25 MB/);
  });
});
