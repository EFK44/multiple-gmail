import { randomBytes } from 'node:crypto';
import { link, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

export interface WriteAtomicOptions {
  // When true, fail with EEXIST instead of replacing an existing file.
  exclusive?: boolean;
}

export type RenameRetryDeps = {
  rename?: (from: string, to: string) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  platform?: NodeJS.Platform;
};

const RETRYABLE = new Set(['EPERM', 'EACCES', 'EBUSY']);
const MAX_RETRIES = 10;

// On Windows, rename fails with EPERM/EACCES/EBUSY while another process (the other mode, an antivirus scanner)
// has the target open. Retry with backoff: 10 ms doubling, capped at 200 ms, at most 10 retries.
export async function renameWithRetry(from: string, to: string, deps: RenameRetryDeps = {}): Promise<void> {
  const doRename = deps.rename ?? rename;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const retry = (deps.platform ?? process.platform) === 'win32';
  let delay = 10;
  for (let attempt = 0; ; attempt++) {
    try {
      await doRename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (!retry || attempt >= MAX_RETRIES || !code || !RETRYABLE.has(code)) throw err;
      await sleep(delay);
      delay = Math.min(delay * 2, 200);
    }
  }
}

export async function writeFileAtomic(
  file: string,
  data: string | Buffer,
  opts: WriteAtomicOptions = {},
): Promise<void> {
  const tmp = join(dirname(file), `.${basename(file)}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    await writeFile(tmp, data, { mode: 0o600, flag: 'wx' });
    if (opts.exclusive) {
      // link() fails with EEXIST if the target exists, so the file appears complete or not at all.
      await link(tmp, file);
      await rm(tmp, { force: true });
    } else {
      await renameWithRetry(tmp, file);
    }
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}
