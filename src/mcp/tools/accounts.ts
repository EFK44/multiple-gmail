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
        'alias or email from this list (or "all" where a tool allows it). Returns alias, email, status ' +
        '(ok, needs_reauth or error) and addedAt, plus defaultAccount.',
      inputSchema: z.object({}),
      outputSchema: z.object({
        accounts: z.array(
          z.object({ alias: z.string(), email: z.string(), status: z.string(), addedAt: z.string() }),
        ),
        defaultAccount: z.string().nullable(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () =>
      run(async () => {
        const cfg = await deps.loadConfig();
        return {
          accounts: Object.entries(cfg.accounts).map(([alias, a]) => ({
            alias,
            email: a.email,
            status: getAccountStatus(alias),
            addedAt: a.addedAt,
          })),
          defaultAccount: cfg.defaultAccount,
        };
      }),
  );
}
