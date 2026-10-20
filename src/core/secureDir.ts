import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { system32Dir, systemBinary } from './sysbin.js';

const execFileAsync = promisify(execFile);

// In-flight calls per resolved path, so a concurrent caller waits for the ACL step to finish.
const inFlight = new Map<string, Promise<void>>();

function windowsAccount(): string {
  const user = userInfo().username;
  const domain = process.env.USERDOMAIN;
  return domain ? `${domain}\\${user}` : user;
}

// Creates dir (recursive). On Windows, when the directory is newly created, strips inherited
// ACLs and grants full control to the current user only. Elsewhere the directory is created 0700.
export function ensureSecureDir(dir: string): Promise<void> {
  const target = resolve(dir);
  const pending = inFlight.get(target);
  if (pending) return pending;
  const p = createSecureDir(target).finally(() => inFlight.delete(target));
  inFlight.set(target, p);
  return p;
}

async function createSecureDir(target: string): Promise<void> {
  const created = await mkdir(target, { recursive: true, mode: 0o700 });
  if (created === undefined || process.platform !== 'win32') return;
  const args = [target, '/inheritance:r', '/grant:r', `${windowsAccount()}:(OI)(CI)F`];
  try {
    await execFileAsync(systemBinary('icacls'), args, { windowsHide: true, cwd: system32Dir() });
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; message: string };
    const detail = (e.stderr || e.stdout || e.message).toString().trim();
    throw new Error(`Failed to restrict permissions on ${target} with icacls: ${detail}`);
  }
}
