import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

// Runs before every test file. Points every location the app could resolve at a throwaway per-worker sandbox so no test,
// and no async work outliving a test, can reach the real user profile.
const sandbox = mkdtempSync(join(tmpdir(), 'mg-sandbox-'));
const profile = join(sandbox, 'profile');

process.env.MULTIPLE_GMAIL_HOME = join(sandbox, 'home');
process.env.MULTIPLE_GMAIL_TEST_HOME = process.env.MULTIPLE_GMAIL_HOME;
process.env.LOCALAPPDATA = join(sandbox, 'local');
process.env.APPDATA = join(sandbox, 'roaming');
process.env.USERPROFILE = profile;
process.env.HOME = profile;

afterAll(() => {
  try {
    rmSync(sandbox, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

/** Puts MULTIPLE_GMAIL_HOME back to the per-worker sandbox home. Use in afterEach instead of restoring `undefined`. */
export function restoreTestHome(): void {
  process.env.MULTIPLE_GMAIL_HOME = process.env.MULTIPLE_GMAIL_TEST_HOME ?? '';
}
