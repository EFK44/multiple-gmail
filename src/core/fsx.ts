import { randomBytes } from 'node:crypto';
import { link, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

export interface WriteAtomicOptions {
  // When true, fail with EEXIST instead of replacing an existing file.
  exclusive?: boolean;
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
      await rename(tmp, file);
    }
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}
