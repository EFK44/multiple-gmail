import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  KEYCHAIN_ACCOUNT,
  KEYCHAIN_SERVICE,
  loadPosixMasterKey,
  realKeyRunner,
  resetPosixWarningForTests,
  toKeyRunResult,
  type KeyRunner,
  type PosixKeyDeps,
} from '../../src/core/masterKey.js';

type Call = { file: string; args: string[]; input?: string };

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mg-mk-'));
  resetPosixWarningForTests();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function deps(over: Partial<PosixKeyDeps>): PosixKeyDeps {
  return {
    platform: 'linux',
    env: {},
    dir,
    run: async () => {
      throw new Error('unexpected spawn');
    },
    isExec: () => false,
    warn: () => {},
    ensureDir: async () => {},
    ...over,
  };
}

// Fake /usr/bin/security with an in-memory keychain. `-i` reads commands from stdin.
function fakeSecurity(store: Map<string, string>, calls: Call[], opts: { interactiveWorks?: boolean } = {}): KeyRunner {
  const key = (a: string[]) => `${a[a.indexOf('-a') + 1]}|${a[a.indexOf('-s') + 1]}`;
  const exec = (args: string[]) => {
    if (args[0] === 'find-generic-password') {
      const v = store.get(key(args));
      return v === undefined
        ? { code: 44, stdout: '', stderr: 'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.' }
        : { code: 0, stdout: `${v}\n`, stderr: '' };
    }
    if (args[0] === 'add-generic-password') {
      if (args.includes('-U')) throw new Error('must never update an existing item');
      if (store.has(key(args))) return { code: 45, stdout: '', stderr: 'already exists' };
      store.set(key(args), args[args.indexOf('-w') + 1]);
      return { code: 0, stdout: '', stderr: '' };
    }
    return { code: 1, stdout: '', stderr: 'bad command' };
  };
  return async (file, args, input) => {
    calls.push({ file, args, input });
    expect(file).toBe('/usr/bin/security');
    if (args[0] === '-i') {
      if (opts.interactiveWorks !== false) for (const line of (input ?? '').split('\n').filter(Boolean)) exec(line.split(' '));
      return { code: 0, stdout: '', stderr: '' };
    }
    return exec(args);
  };
}

describe('master key on POSIX', () => {
  it('MULTIPLE_GMAIL_MASTER_KEY wins and never spawns anything', async () => {
    const k = randomBytes(32);
    for (const platform of ['darwin', 'linux'] as const) {
      const got = await loadPosixMasterKey(deps({ platform, env: { MULTIPLE_GMAIL_MASTER_KEY: k.toString('base64') } }));
      expect(got.equals(k)).toBe(true);
    }
    await expect(loadPosixMasterKey(deps({ env: { MULTIPLE_GMAIL_MASTER_KEY: 'nope' } }))).rejects.toThrow(/MULTIPLE_GMAIL_MASTER_KEY/);
  });

  describe('macOS Keychain', () => {
    const isExec = (p: string) => p === '/usr/bin/security';

    it('creates once without putting the key in argv, then reads it back', async () => {
      const store = new Map<string, string>();
      const calls: Call[] = [];
      const run = fakeSecurity(store, calls);
      const a = await loadPosixMasterKey(deps({ platform: 'darwin', run, isExec }));
      expect(a.length).toBe(32);
      const b64 = a.toString('base64');
      expect(store.get(`${KEYCHAIN_ACCOUNT}|${KEYCHAIN_SERVICE}`)).toBe(b64);
      for (const c of calls) expect(c.args.join(' ')).not.toContain(b64);
      expect(calls.some((c) => c.args[0] === '-i' && c.input?.includes(b64))).toBe(true);
      calls.length = 0;
      const b = await loadPosixMasterKey(deps({ platform: 'darwin', run, isExec }));
      expect(b.equals(a)).toBe(true);
      expect(calls.map((c) => c.args[0])).toEqual(['find-generic-password']);
      expect(calls[0].args).toEqual(['find-generic-password', '-a', 'multiple-gmail', '-s', 'multiple-gmail-master-key', '-w']);
    });

    it('falls back to a short-lived argv add when the interactive add did not store anything', async () => {
      const store = new Map<string, string>();
      const calls: Call[] = [];
      const key = await loadPosixMasterKey(deps({ platform: 'darwin', run: fakeSecurity(store, calls, { interactiveWorks: false }), isExec }));
      expect(store.get(`${KEYCHAIN_ACCOUNT}|${KEYCHAIN_SERVICE}`)).toBe(key.toString('base64'));
      expect(calls.some((c) => c.args[0] === 'add-generic-password' && !c.args.includes('-U'))).toBe(true);
    });

    it('uses the key another process stored first (create-only, never overwrite)', async () => {
      const store = new Map<string, string>();
      const theirs = randomBytes(32).toString('base64');
      let finds = 0;
      const inner = fakeSecurity(store, []);
      const run: KeyRunner = async (file, args, input) => {
        if (args[0] === 'find-generic-password' && finds++ === 0) {
          const r = await inner(file, args, input);
          store.set(`${KEYCHAIN_ACCOUNT}|${KEYCHAIN_SERVICE}`, theirs); // the other process wins the race
          return r;
        }
        return inner(file, args, input);
      };
      const got = await loadPosixMasterKey(deps({ platform: 'darwin', run, isExec }));
      expect(got.toString('base64')).toBe(theirs);
    });

    it('does not regenerate when the Keychain refuses access or holds garbage', async () => {
      const denied: KeyRunner = async () => ({ code: 128, stdout: '', stderr: 'User canceled the operation.' });
      await expect(loadPosixMasterKey(deps({ platform: 'darwin', run: denied, isExec }))).rejects.toThrow(/Keychain/);
      const garbage: KeyRunner = async (_f, args) => {
        if (args[0] !== 'find-generic-password') throw new Error('must not write');
        return { code: 0, stdout: 'not-a-key\n', stderr: '' };
      };
      await expect(loadPosixMasterKey(deps({ platform: 'darwin', run: garbage, isExec }))).rejects.toThrow(/corrupt/);
    });

    it('passes an explicit keychain file as the last argument when given', async () => {
      const calls: Call[] = [];
      await loadPosixMasterKey(deps({ platform: 'darwin', run: fakeSecurity(new Map(), calls), isExec, keychain: '/tmp/k.keychain-db' }));
      for (const c of calls.filter((c) => c.args[0] === 'find-generic-password')) expect(c.args.at(-1)).toBe('/tmp/k.keychain-db');
      expect(calls.find((c) => c.args[0] === '-i')!.input).toMatch(/ \/tmp\/k\.keychain-db\n$/);
    });

    it('fails clearly when /usr/bin/security is missing', async () => {
      await expect(loadPosixMasterKey(deps({ platform: 'darwin', isExec: () => false }))).rejects.toThrow(/MULTIPLE_GMAIL_MASTER_KEY/);
    });
  });

  describe('Linux secret-tool', () => {
    const isExec = (p: string) => p === '/usr/bin/secret-tool';

    function fakeSecretTool(state: { value?: string }, calls: Call[]): KeyRunner {
      return async (file, args, input) => {
        calls.push({ file, args, input });
        expect(file).toBe('/usr/bin/secret-tool');
        if (args[0] === 'lookup') {
          expect(args).toEqual(['lookup', 'service', 'multiple-gmail', 'key', 'master']);
          return state.value === undefined ? { code: 1, stdout: '', stderr: '' } : { code: 0, stdout: state.value, stderr: '' };
        }
        if (args[0] === 'store') {
          expect(args).toEqual(['store', '--label=multiple-gmail', 'service', 'multiple-gmail', 'key', 'master']);
          state.value = input;
          return { code: 0, stdout: '', stderr: '' };
        }
        return { code: 2, stdout: '', stderr: 'usage' };
      };
    }

    it('stores a new key via stdin and reads the same key later', async () => {
      const state: { value?: string } = {};
      const calls: Call[] = [];
      const run = fakeSecretTool(state, calls);
      const a = await loadPosixMasterKey(deps({ run, isExec }));
      expect(state.value).toBe(a.toString('base64'));
      for (const c of calls) expect(c.args.join(' ')).not.toContain(state.value);
      const b = await loadPosixMasterKey(deps({ run, isExec }));
      expect(b.equals(a)).toBe(true);
      expect(existsSync(join(dir, 'master.key'))).toBe(false);
    });

    it('refuses to fork a new key when the keyring cannot be reached', async () => {
      const run: KeyRunner = async () => ({ code: 1, stdout: '', stderr: 'Cannot autolaunch D-Bus without X11 $DISPLAY' });
      await expect(loadPosixMasterKey(deps({ run, isExec }))).rejects.toThrow(/keyring.*MULTIPLE_GMAIL_MASTER_KEY/s);
      expect(existsSync(join(dir, 'master.key'))).toBe(false);
    });

    it('treats a timed-out or unstartable secret-tool as an unavailable keyring', async () => {
      for (const failure of ['timeout', 'spawn'] as const) {
        const run: KeyRunner = async () => ({ code: -1, stdout: '', stderr: '', failure, detail: 'x' });
        await expect(loadPosixMasterKey(deps({ run, isExec }))).rejects.toThrow(/keyring/);
      }
    });

    it('creates a key when lookup reports not found as the real runner does (exit 1, empty stderr)', async () => {
      const state: { value?: string } = {};
      const run: KeyRunner = async (_f, args, input) => {
        if (args[0] === 'lookup') {
          return state.value === undefined
            ? toKeyRunResult({ code: 1, killed: false, signal: null, message: 'Command failed: secret-tool lookup' }, '', '')
            : toKeyRunResult(null, state.value, '');
        }
        state.value = input;
        return toKeyRunResult(null, '', '');
      };
      const key = await loadPosixMasterKey(deps({ run, isExec }));
      expect(state.value).toBe(key.toString('base64'));
    });
  });

  describe('toKeyRunResult (execFile callback shapes)', () => {
    it('keeps a normal non-zero exit with raw, empty stderr', () => {
      expect(toKeyRunResult({ code: 1, killed: false, signal: null, message: 'Command failed: x' }, '', '')).toEqual({
        code: 1,
        stdout: '',
        stderr: '',
      });
      expect(toKeyRunResult(null, 'out\n', '')).toEqual({ code: 0, stdout: 'out\n', stderr: '' });
    });
    it('marks a timeout or signal kill', () => {
      const r = toKeyRunResult({ code: null, killed: true, signal: 'SIGTERM', message: 'Command failed' }, '', '');
      expect(r.failure).toBe('timeout');
      expect(toKeyRunResult({ code: null, killed: false, signal: 'SIGKILL' }, '', '').failure).toBe('timeout');
    });
    it('marks a spawn error or output overflow', () => {
      const r = toKeyRunResult({ code: 'ENOENT', message: 'spawn /usr/bin/secret-tool ENOENT' }, '', '');
      expect(r).toMatchObject({ failure: 'spawn', detail: 'spawn /usr/bin/secret-tool ENOENT' });
      expect(toKeyRunResult({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', message: 'maxBuffer' }, '', '').failure).toBe('spawn');
    });
  });

  describe.skipIf(process.platform === 'win32')('realKeyRunner on POSIX', () => {
    beforeEach(() => {
      process.env.MULTIPLE_GMAIL_REAL_KEYSTORE_TEST = '1';
    });
    afterEach(() => {
      delete process.env.MULTIPLE_GMAIL_REAL_KEYSTORE_TEST;
    });
    it('reports exit 1 with empty stderr and no failure', async () => {
      expect(await realKeyRunner('/bin/sh', ['-c', 'exit 1'])).toEqual({ code: 1, stdout: '', stderr: '' });
    });
    it('passes stdin and reports a spawn failure for a missing binary', async () => {
      expect((await realKeyRunner('/bin/sh', ['-c', 'cat'], 'abc')).stdout).toBe('abc');
      expect((await realKeyRunner('/nonexistent/mg-tool', [])).failure).toBe('spawn');
    });
  });

  describe('Linux file fallback', () => {
    it('creates a 0600 master.key once, warns once, and reads it back', async () => {
      const warnings: string[] = [];
      const warn = (s: string) => warnings.push(s);
      const a = await loadPosixMasterKey(deps({ warn }));
      const file = join(dir, 'master.key');
      expect((await readFile(file, 'utf8')).trim()).toBe(a.toString('base64'));
      if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600);
      const b = await loadPosixMasterKey(deps({ warn }));
      expect(b.equals(a)).toBe(true);
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toMatch(/file permissions/);
    });

    it('an existing master.key wins over secret-tool', async () => {
      const k = randomBytes(32);
      await writeFile(join(dir, 'master.key'), `${k.toString('base64')}\n`);
      const got = await loadPosixMasterKey(deps({ isExec: () => true }));
      expect(got.equals(k)).toBe(true);
    });

    it('refuses a corrupt master.key instead of regenerating', async () => {
      await writeFile(join(dir, 'master.key'), 'garbage');
      await expect(loadPosixMasterKey(deps({}))).rejects.toThrow(/master\.key.*corrupt/);
      expect(await readFile(join(dir, 'master.key'), 'utf8')).toBe('garbage');
    });

    it('two concurrent first loads agree on one key', async () => {
      const [a, b] = await Promise.all([loadPosixMasterKey(deps({})), loadPosixMasterKey(deps({}))]);
      expect(a.equals(b)).toBe(true);
    });
  });
});

// Real Keychain round trip, CI only: a throwaway keychain file so the runner's login keychain is never touched.
describe.runIf(process.platform === 'darwin' && process.env.CI === 'true')('macOS Keychain integration', () => {
  it('round-trips through a temporary keychain', async (ctx) => {
    const run = promisify(execFile);
    const keychain = join(dir, 'mg-test.keychain-db');
    try {
      await run('/usr/bin/security', ['create-keychain', '-p', 'mg-test', keychain]);
      await run('/usr/bin/security', ['unlock-keychain', '-p', 'mg-test', keychain]);
    } catch (e) {
      ctx.skip(`cannot create a temporary keychain on this runner: ${(e as Error).message}`);
    }
    process.env.MULTIPLE_GMAIL_REAL_KEYSTORE_TEST = '1';
    try {
      const d = { dir, keychain, run: realKeyRunner, platform: 'darwin' as const, env: {} };
      const a = await loadPosixMasterKey(d);
      const b = await loadPosixMasterKey(d);
      expect(a.length).toBe(32);
      expect(b.equals(a)).toBe(true);
    } finally {
      delete process.env.MULTIPLE_GMAIL_REAL_KEYSTORE_TEST;
      await run('/usr/bin/security', ['delete-keychain', keychain]).catch(() => {});
    }
  }, 60_000);
});

// Real Secret Service round trip, CI only: the workflow runs this inside dbus-run-session with a freshly unlocked
// throwaway gnome-keyring (MG_SECRET_TOOL_IT=1), so no real user keyring is involved.
describe.runIf(process.platform === 'linux' && process.env.MG_SECRET_TOOL_IT === '1')('Linux secret-tool integration', () => {
  const clear = () =>
    promisify(execFile)('/usr/bin/secret-tool', ['clear', 'service', 'multiple-gmail', 'key', 'master']).catch(() => {});
  it('creates the key on first use (lookup not found) and reads the same key back', async () => {
    process.env.MULTIPLE_GMAIL_REAL_KEYSTORE_TEST = '1';
    await clear();
    try {
      const d = { dir, run: realKeyRunner, platform: 'linux' as const, env: {} };
      const a = await loadPosixMasterKey(d);
      const b = await loadPosixMasterKey(d);
      expect(a.length).toBe(32);
      expect(b.equals(a)).toBe(true);
      expect(existsSync(join(dir, 'master.key'))).toBe(false);
    } finally {
      delete process.env.MULTIPLE_GMAIL_REAL_KEYSTORE_TEST;
      await clear();
    }
  }, 60_000);
});
