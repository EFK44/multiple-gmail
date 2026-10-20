import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { viewUrl } from '../../gmail/shape.js';
import { accountParam } from '../accountArg.js';
import { fanOut, oneAccount, READ_ONLY, run, type Deps } from './util.js';

const LABEL_IDS_HELP =
  'Label IDs, not names: system IDs such as INBOX, STARRED, UNREAD, IMPORTANT, or user label IDs from list_labels.';

const MODIFY_ANNOTATIONS = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true };

export function registerLabelTools(server: McpServer, deps: Deps): void {
  server.registerTool(
    'list_labels',
    {
      title: 'List labels',
      description:
        'Multi-account Gmail. List the labels of one account, or of every connected account with account "all". ' +
        'Returns id, name and type (system or user). Use the ids with label_thread and unlabel_thread.',
      inputSchema: z.object({
        account: accountParam.describe('Account name or email from list_accounts. Use "all" only where noted. "all" is allowed here.'),
      }),
      annotations: READ_ONLY,
    },
    async (args) =>
      run(() =>
        fanOut(deps, args.account, undefined, async ({ api }) => {
          const res = await api.users.labels.list({ userId: 'me' });
          return {
            labels: (res.data.labels ?? []).map((l) => ({ id: l.id ?? '', name: l.name ?? '', type: l.type ?? '' })),
          };
        }),
      ),
  );

  const modify = (name: 'label_thread' | 'unlabel_thread', add: boolean) =>
    server.registerTool(
      name,
      {
        title: add ? 'Label thread' : 'Unlabel thread',
        description: add
          ? 'Multi-account Gmail. Add labels to every message of a thread in one account (account "all" is not ' +
            `allowed). ${LABEL_IDS_HELP} For example STARRED stars it, UNREAD marks it unread.`
          : 'Multi-account Gmail. Remove labels from every message of a thread in one account (account "all" is not ' +
            `allowed). ${LABEL_IDS_HELP} For example removing INBOX archives it, removing UNREAD marks it read.`,
        inputSchema: z.object({
          account: accountParam,
          threadId: z.string().min(1).describe('Thread id, from search_threads.'),
          labelIds: z.array(z.string().min(1)).min(1).describe(LABEL_IDS_HELP),
        }),
        annotations: MODIFY_ANNOTATIONS,
      },
      async (args) =>
        run(() =>
          oneAccount(deps, args.account, async ({ name, api, email }) => {
            await api.users.threads.modify({
              userId: 'me',
              id: args.threadId,
              requestBody: add ? { addLabelIds: args.labelIds } : { removeLabelIds: args.labelIds },
            });
            return {
              account: name,
              threadId: args.threadId,
              viewUrl: viewUrl(email, args.threadId),
              [add ? 'addedLabelIds' : 'removedLabelIds']: args.labelIds,
            };
          }),
        ),
    );

  modify('label_thread', true);
  modify('unlabel_thread', false);
}
