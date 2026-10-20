import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { friendly } from '../../gmail/errors.js';
import { shapeMessage, viewUrl, type MessageFormat } from '../../gmail/shape.js';
import { accountParam } from '../accountArg.js';
import { apiFormat, fanOut, mapLimit, notDraft, oneAccount, READ_ONLY, run, type Deps } from './util.js';

// Per-account parallelism for follow-up gets (thread or draft details).
const DETAIL_CONCURRENCY = 10;

const pageSize = z.number().int().min(1).max(50).default(20).describe('Results per page, 1-50 (default 20).');
const pageToken = z.string().optional().describe('nextPageToken from a previous call (single account only).');
const messageFormat = z
  .enum(['MINIMAL', 'METADATA_ONLY', 'PLAIN_TEXT', 'FULL_CONTENT'])
  .default('PLAIN_TEXT')
  .describe(
    'MINIMAL: ids and labels. METADATA_ONLY: adds sender, recipients, subject, snippet, date. ' +
      'PLAIN_TEXT (recommended, default): adds the plain text body and attachment info. ' +
      'FULL_CONTENT: also the raw HTML body. Long bodies are truncated.',
  );

export function registerReadTools(server: McpServer, deps: Deps): void {
  server.registerTool(
    'search_threads',
    {
      title: 'Search threads',
      description:
        'Multi-account Gmail. Search email threads in one account, or in every connected account with account "all" ' +
        '(accounts run in parallel; each result carries its account alias; a failing account is listed in errors ' +
        'without stopping the others). The query uses Gmail search syntax, for example from:alice@example.com, ' +
        'to:, subject:report, after:2026/01/31, before:, newer_than:7d, older_than:, label:work, is:unread, ' +
        'is:starred, has:attachment, filename:pdf, in:inbox, in:sent, category:primary, and OR / - / quotes. ' +
        'Convert natural language requests into Gmail syntax; prefer short keyword queries over long sentences. ' +
        'An empty query lists recent threads. No matches is a normal empty result, not an error. ' +
        'Returns threads with id, viewUrl, snippet and messages in MINIMAL view (ids and labels); call get_thread ' +
        'for bodies. Drafts are not returned (use list_drafts).',
      inputSchema: z.object({
        account: accountParam.describe('Alias or email from list_accounts. Use "all" only where noted. "all" is allowed here.'),
        query: z.string().optional().describe('Gmail search query, for example "from:bob is:unread newer_than:3d".'),
        pageSize,
        pageToken,
        includeTrash: z.boolean().default(false).describe('Also search Trash and Spam (default false).'),
      }),
      annotations: READ_ONLY,
    },
    async (args) =>
      run(() =>
        fanOut(deps, args.account, args.pageToken, async ({ api, email }) => {
          const res = await api.users.threads.list({
            userId: 'me',
            q: args.query || undefined,
            maxResults: args.pageSize,
            pageToken: args.pageToken,
            includeSpamTrash: args.includeTrash,
          });
          const found = res.data.threads ?? [];
          const threads = await mapLimit(found, DETAIL_CONCURRENCY, async (t) => {
            const id = t.id ?? '';
            const full = await api.users.threads.get({ userId: 'me', id, format: 'minimal' });
            return {
              id,
              viewUrl: viewUrl(email, id),
              snippet: t.snippet ?? '',
              messages: (full.data.messages ?? []).filter(notDraft).map((m) => shapeMessage(m, email, 'MINIMAL')),
            };
          });
          return {
            threads: threads.filter((t) => t.messages.length > 0),
            ...(res.data.nextPageToken ? { nextPageToken: res.data.nextPageToken } : {}),
          };
        }),
      ),
  );

  server.registerTool(
    'get_thread',
    {
      title: 'Get thread',
      description:
        'Multi-account Gmail. Get every message of one thread in one account (account "all" is not allowed). ' +
        'messageFormat controls detail; PLAIN_TEXT (default) is recommended. Drafts are not returned (use list_drafts).',
      inputSchema: z.object({
        account: accountParam,
        threadId: z.string().min(1).describe('Thread id, from search_threads.'),
        messageFormat,
      }),
      annotations: READ_ONLY,
    },
    async (args) =>
      run(() =>
        oneAccount(deps, args.account, async ({ alias, api, email }) => {
          const format = args.messageFormat as MessageFormat;
          const res = await api.users.threads.get({ userId: 'me', id: args.threadId, format: apiFormat(format) });
          const id = res.data.id ?? args.threadId;
          return {
            account: alias,
            id,
            viewUrl: viewUrl(email, id),
            messages: (res.data.messages ?? []).filter(notDraft).map((m) => shapeMessage(m, email, format)),
          };
        }),
      ),
  );

  server.registerTool(
    'get_message',
    {
      title: 'Get message',
      description:
        'Multi-account Gmail. Get one message in one account (account "all" is not allowed). messageFormat ' +
        'controls detail; PLAIN_TEXT (default) is recommended. Drafts are not returned (use list_drafts).',
      inputSchema: z.object({
        account: accountParam,
        messageId: z.string().min(1).describe('Message id, from search_threads or get_thread.'),
        messageFormat,
      }),
      annotations: READ_ONLY,
    },
    async (args) =>
      run(() =>
        oneAccount(deps, args.account, async ({ alias, api, email }) => {
          const format = args.messageFormat as MessageFormat;
          const res = await api.users.messages.get({ userId: 'me', id: args.messageId, format: apiFormat(format) });
          if (!notDraft(res.data)) {
            throw friendly(`Message ${args.messageId} is a draft; use list_drafts to see drafts.`);
          }
          return { account: alias, ...shapeMessage(res.data, email, format) };
        }),
      ),
  );

  server.registerTool(
    'list_drafts',
    {
      title: 'List drafts',
      description:
        'Multi-account Gmail. List drafts in one account, or in every connected account with account "all". ' +
        'Optional query uses Gmail search syntax. Returns each draft id with its message in METADATA_ONLY view ' +
        '(sender, recipients, subject, snippet). Send a draft with send_message and its draftId.',
      inputSchema: z.object({
        account: accountParam.describe('Alias or email from list_accounts. Use "all" only where noted. "all" is allowed here.'),
        query: z.string().optional().describe('Gmail search query to filter drafts.'),
        pageSize,
        pageToken,
      }),
      annotations: READ_ONLY,
    },
    async (args) =>
      run(() =>
        fanOut(deps, args.account, args.pageToken, async ({ api, email }) => {
          const res = await api.users.drafts.list({
            userId: 'me',
            q: args.query || undefined,
            maxResults: args.pageSize,
            pageToken: args.pageToken,
          });
          const drafts = await mapLimit(res.data.drafts ?? [], DETAIL_CONCURRENCY, async (d) => {
            const full = await api.users.drafts.get({ userId: 'me', id: d.id ?? '', format: 'metadata' });
            const message = full.data.message ?? d.message ?? {};
            return { id: d.id ?? '', message: shapeMessage(message, email, 'METADATA_ONLY') };
          });
          return { drafts, ...(res.data.nextPageToken ? { nextPageToken: res.data.nextPageToken } : {}) };
        }),
      ),
  );
}
