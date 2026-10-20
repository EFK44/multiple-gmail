import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApi } from '../../src/http/api.js';
import { tempHome } from './helpers.js';

let cleanup: () => Promise<void>;
beforeEach(async () => {
  cleanup = (await tempHome('mg-pending-')).cleanup;
});
afterEach(async () => {
  await cleanup();
});

describe('pending new accounts', () => {
  it('DELETE drops the pending add for that id', async () => {
    const handle = createApi({
      startLoopbackAuth: async (_t, o = {}) => ({
        url: `https://accounts.example.com/${o.id}`,
        id: o.id ?? 'x',
        done: new Promise<never>(() => {}),
      }),
      removeAccount: async () => ({ revoked: false }),
    });
    const call = (method: string, path: string, body = '') => handle({ method, path, body, sameOrigin: true });
    const added = (await call('POST', '/accounts', JSON.stringify({ name: 'Work' }))).json as { id: string };
    expect(handle.pendingAddIds()).toEqual([added.id]);
    expect((await call('DELETE', `/accounts/${added.id}`)).status).toBe(200);
    expect(handle.pendingAddIds()).toEqual([]);
  });
});
