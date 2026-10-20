import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renameWithRetry, writeFileAtomic } from '../../src/core/fsx.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mg-fsx-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const err = (code: string) => Object.assign(new Error(code), { code });

describe('renameWithRetry', () => {
  it('retries EPERM twice then succeeds, with doubling backoff', async () => {
    const rename = vi
      .fn<(a: string, b: string) => Promise<void>>()
      .mockRejectedValueOnce(err('EPERM'))
      .mockRejectedValueOnce(err('EPERM'))
      .mockResolvedValueOnce(undefined);
    const sleeps: number[] = [];
    await renameWithRetry('a', 'b', { rename, sleep: async (ms) => void sleeps.push(ms), platform: 'win32' });
    expect(rename).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([10, 20]);
  });

  it('gives up after 10 retries with a capped backoff', async () => {
    const rename = vi.fn(async () => {
      throw err('EBUSY');
    });
    const sleeps: number[] = [];
    await expect(
      renameWithRetry('a', 'b', { rename, sleep: async (ms) => void sleeps.push(ms), platform: 'win32' }),
    ).rejects.toMatchObject({ code: 'EBUSY' });
    expect(rename).toHaveBeenCalledTimes(11);
    expect(sleeps).toEqual([10, 20, 40, 80, 160, 200, 200, 200, 200, 200]);
  });

  it('does not retry other errors or on non-Windows', async () => {
    const enoent = vi.fn(async () => {
      throw err('ENOENT');
    });
    await expect(renameWithRetry('a', 'b', { rename: enoent, sleep: async () => {}, platform: 'win32' })).rejects.toThrow();
    expect(enoent).toHaveBeenCalledTimes(1);
    const eperm = vi.fn(async () => {
      throw err('EPERM');
    });
    await expect(renameWithRetry('a', 'b', { rename: eperm, sleep: async () => {}, platform: 'linux' })).rejects.toThrow();
    expect(eperm).toHaveBeenCalledTimes(1);
  });
});

describe('writeFileAtomic', () => {
  it('writes and replaces a file', async () => {
    const f = join(dir, 'x.json');
    await writeFileAtomic(f, 'one');
    await writeFileAtomic(f, 'two');
    expect(await readFile(f, 'utf8')).toBe('two');
  });
});
