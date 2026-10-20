import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { GmailApi } from '../../gmail/client.js';
import { addrOf, buildRaw, replyHeaders, type ReplyHeaders } from '../../gmail/compose.js';
import { friendly } from '../../gmail/errors.js';
import { parseAddressList, viewUrl } from '../../gmail/shape.js';
import { accountParam } from '../accountArg.js';
import { notDraft, oneAccount, run, type Deps } from './util.js';

const APPROVAL =
  'Use ONLY after the user has explicitly approved sending this exact message in the conversation. ' +
  'Prefer create_draft first, then send_message with draftId.';

const addresses = (what: string) =>
  z.array(z.string().min(1)).optional().describe(`${what} email addresses, for example ["Name <a@example.com>"].`);
const subject = z.string().optional().describe('Subject line. For replies it defaults to "Re: <original subject>".');
const body = z.string().optional().describe('Plain text body. Plain text only: no Markdown, it is not rendered.');
const htmlBody = z.string().optional().describe('Optional HTML body for rich formatting, sent alongside body.');

const SEND_ANNOTATIONS = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

const nonEmpty = (a: string[] | undefined): a is string[] => !!a && a.length > 0;

// Threading headers for a reply: from a message id, or from the newest non-draft message of a thread.
async function threading(
  api: GmailApi,
  email: string,
  replyToMessageId: string | undefined,
  replyThreadId: string | undefined,
): Promise<{ rh?: ReplyHeaders; threadId?: string }> {
  if (replyToMessageId) {
    const rh = await replyHeaders(api, replyToMessageId, email);
    return { rh, threadId: rh.threadId || undefined };
  }
  if (replyThreadId) {
    const t = await api.users.threads.get({ userId: 'me', id: replyThreadId, format: 'minimal' });
    const last = (t.data.messages ?? []).filter(notDraft).at(-1);
    if (!last?.id) return { threadId: replyThreadId };
    const rh = await replyHeaders(api, last.id, email);
    return { rh, threadId: rh.threadId || replyThreadId };
  }
  return {};
}

export function registerComposeTools(server: McpServer, deps: Deps): void {
  server.registerTool(
    'create_draft',
    {
      title: 'Create draft',
      description:
        'Multi-account Gmail. Create a draft in one account (account "all" is not allowed); it is not sent. ' +
        'body is plain text (no Markdown); use htmlBody for rich text. replyToMessageId makes the draft a reply in ' +
        "that message's thread (recipients and subject default from the original). Returns id (the draftId), " +
        'messageId, threadId and viewUrl.',
      inputSchema: z.object({
        account: accountParam,
        to: addresses('Recipient'),
        cc: addresses('Cc'),
        bcc: addresses('Bcc'),
        subject,
        body,
        htmlBody,
        replyToMessageId: z.string().optional().describe('Message id to reply to; threads the draft as a reply.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) =>
      run(() =>
        oneAccount(deps, args.account, async ({ name, api, email }) => {
          const { rh, threadId } = await threading(api, email, args.replyToMessageId, undefined);
          const raw = await buildRaw({
            from: email,
            to: args.to ?? rh?.to,
            cc: args.cc,
            bcc: args.bcc,
            subject: args.subject ?? rh?.subject,
            body: args.body,
            htmlBody: args.htmlBody,
            inReplyTo: rh?.inReplyTo || undefined,
            references: rh?.references || undefined,
          });
          const res = await api.users.drafts.create({
            userId: 'me',
            requestBody: { message: { raw, ...(threadId ? { threadId } : {}) } },
          });
          const tid = res.data.message?.threadId ?? threadId ?? '';
          return {
            account: name,
            id: res.data.id ?? '',
            messageId: res.data.message?.id ?? '',
            threadId: tid,
            viewUrl: viewUrl(email, tid),
          };
        }),
      ),
  );

  server.registerTool(
    'send_message',
    {
      title: 'Send message',
      description:
        `Multi-account Gmail. Send an email from one account (account "all" is not allowed). ${APPROVAL} ` +
        'With draftId, sends that existing draft as is (give no other fields). Otherwise sends a new message from ' +
        'to/cc/bcc/subject/body/htmlBody; body is plain text (no Markdown), htmlBody is optional rich text. ' +
        'replyToMessageId or replyThreadId sends it as a reply in that thread (to answer a message, reply is simpler). ' +
        'Returns id, threadId, labelIds and viewUrl.',
      inputSchema: z.object({
        account: accountParam,
        draftId: z.string().optional().describe('Id of an existing draft (from create_draft or list_drafts) to send as is.'),
        to: addresses('Recipient'),
        cc: addresses('Cc'),
        bcc: addresses('Bcc'),
        subject,
        body,
        htmlBody,
        replyToMessageId: z.string().optional().describe('Message id to reply to; threads the message.'),
        replyThreadId: z.string().optional().describe('Thread id to reply in; threads after its newest message.'),
      }),
      annotations: SEND_ANNOTATIONS,
    },
    async (args) =>
      run(async () => {
        const { account, draftId, ...fields } = args;
        if (draftId) {
          if (Object.values(fields).some((v) => v !== undefined)) {
            throw friendly('draftId sends the draft as is; omit the other fields, or edit by creating a new draft.');
          }
        } else if (!nonEmpty(args.to)) {
          throw friendly(
            'send_message needs draftId, or to with at least one recipient. To answer a message use reply.',
          );
        }
        return oneAccount(deps, account, async ({ name, api, email }) => {
          let data;
          if (draftId) {
            data = (await api.users.drafts.send({ userId: 'me', requestBody: { id: draftId } })).data;
          } else {
            const { rh, threadId } = await threading(api, email, args.replyToMessageId, args.replyThreadId);
            const raw = await buildRaw({
              from: email,
              to: args.to,
              cc: args.cc,
              bcc: args.bcc,
              subject: args.subject ?? rh?.subject,
              body: args.body,
              htmlBody: args.htmlBody,
              inReplyTo: rh?.inReplyTo || undefined,
              references: rh?.references || undefined,
            });
            data = (
              await api.users.messages.send({ userId: 'me', requestBody: { raw, ...(threadId ? { threadId } : {}) } })
            ).data;
          }
          const tid = data.threadId ?? '';
          return { account: name, id: data.id ?? '', threadId: tid, labelIds: data.labelIds ?? [], viewUrl: viewUrl(email, tid) };
        });
      }),
  );

  server.registerTool(
    'reply',
    {
      title: 'Reply',
      description:
        `Multi-account Gmail. Reply to a message from one account, in its thread (account "all" is not allowed). ${APPROVAL} ` +
        'By default replies to the sender (or Reply-To). replyAll also includes the original From, To and Cc, ' +
        "minus this account's own address. Explicit to or cc replace the computed lists. body is plain text " +
        '(no Markdown); htmlBody is optional rich text. Returns id, threadId, labelIds and viewUrl.',
      inputSchema: z.object({
        account: accountParam,
        messageId: z.string().min(1).describe('Id of the message to reply to.'),
        body,
        htmlBody,
        replyAll: z.boolean().default(false).describe('Reply to everyone on the original message (default false).'),
        to: addresses('Override recipient'),
        cc: addresses('Override Cc'),
        bcc: addresses('Bcc'),
      }),
      annotations: SEND_ANNOTATIONS,
    },
    async (args) =>
      run(async () => {
        if (!args.body && !args.htmlBody) throw friendly('reply needs body (or htmlBody).');
        return oneAccount(deps, args.account, async ({ name, api, email }) => {
          const rh = await replyHeaders(api, args.messageId, email);
          const self = email.trim().toLowerCase();
          const computedTo = rh.to.filter((x) => addrOf(x) !== self);
          const to = args.to ?? (computedTo.length ? computedTo : rh.to);
          let cc: string[] = [];
          if (args.cc) cc = args.cc;
          else if (args.replyAll) {
            const seen = new Set([self, ...to.map(addrOf)]);
            for (const x of [...parseAddressList(rh.from), ...rh.originalTo, ...rh.cc]) {
              const a = addrOf(x);
              if (!a || seen.has(a)) continue;
              seen.add(a);
              cc.push(x);
            }
          }
          if (!to.length) throw friendly('No recipient found for this reply; pass to explicitly.');
          const raw = await buildRaw({
            from: email,
            to,
            cc,
            bcc: args.bcc,
            subject: rh.subject,
            body: args.body,
            htmlBody: args.htmlBody,
            inReplyTo: rh.inReplyTo || undefined,
            references: rh.references || undefined,
          });
          const res = await api.users.messages.send({
            userId: 'me',
            requestBody: { raw, ...(rh.threadId ? { threadId: rh.threadId } : {}) },
          });
          const tid = res.data.threadId ?? rh.threadId;
          return {
            account: name,
            id: res.data.id ?? '',
            threadId: tid,
            labelIds: res.data.labelIds ?? [],
            viewUrl: viewUrl(email, tid),
          };
        });
      }),
  );
}
