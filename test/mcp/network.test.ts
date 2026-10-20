import { describe, expect, it } from 'vitest';
import { run, withAccount, type Deps } from '../../src/mcp/tools/util.js';

const deps = (err: unknown): Deps =>
  ({ getGmail: async () => ({ api: {}, email: 'you@example.com' }), loadConfig: async () => ({}) }) as unknown as Deps;

describe('network failures', () => {
  for (const code of ['ENOTFOUND', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNREFUSED']) {
    it(`maps ${code} to a friendly message`, async () => {
      const res = await run(() =>
        withAccount(deps(null), { id: 'alpha', name: 'Alpha Mail' }, async () => {
          throw Object.assign(new Error('getaddrinfo failed for secret-host'), { code });
        }),
      );
      expect(res.isError).toBe(true);
      expect(res.content[0]).toMatchObject({
        text: 'Could not reach Gmail for Alpha Mail. Check the internet connection and try again.',
      });
    });
  }
});
