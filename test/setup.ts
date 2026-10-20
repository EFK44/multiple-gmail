import { randomBytes } from 'node:crypto';
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
// On macOS and Linux the master key would otherwise come from the real Keychain or Secret Service. Tests that exercise
// that path inject a fake runner (test/core/masterKeyPosix.test.ts).
if (process.platform !== 'win32' && !process.env.MULTIPLE_GMAIL_MASTER_KEY) {
  process.env.MULTIPLE_GMAIL_MASTER_KEY = randomBytes(32).toString('base64');
}

afterAll(() => {
  try {
    rmSync(sandbox, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

/** Puts MULTIPLE_GMAIL_HOME back to the per-worker sandbox home. Use in afterEach instead of restoring `undefined`. */
export function restoreTestHome(): void {
  const home = process.env.MULTIPLE_GMAIL_TEST_HOME;
  if (home) process.env.MULTIPLE_GMAIL_HOME = home;
  else delete process.env.MULTIPLE_GMAIL_HOME;
}
