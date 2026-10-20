import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { getAccountStatus } from '../../gmail/errors.js';
import { run, type Deps } from './util.js';

export function registerAccountTools(server: McpServer, deps: Deps): void {
  server.registerTool(
    'list_accounts',
    {
      title: 'List accounts',
      description:
        'Multi-account Gmail. List the connected Gmail accounts. Every other tool takes an account param: pass an ' +
        'account name or email from this list (or "all" where a tool allows it). Returns name, email, status ' +
        '(ok, needs_reauth or error) and addedAt.',
      inputSchema: z.object({}),
      outputSchema: z.object({
        accounts: z.array(
          z.object({ name: z.string(), email: z.string(), status: z.string(), addedAt: z.string() }),
        ),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () =>
      run(async () => {
        const cfg = await deps.loadConfig();
        return {
          accounts: Object.entries(cfg.accounts).map(([id, a]) => ({
            name: a.name,
            email: a.email,
            status: getAccountStatus(id),
            addedAt: a.addedAt,
          })),
        };
      }),
  );
}
