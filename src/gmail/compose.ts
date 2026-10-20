import MailComposer from 'nodemailer/lib/mail-composer';
import type { GmailApi } from './client.js';
import { parseAddressList } from './shape.js';

export type RawOptions = {
  from: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  body?: string;
  htmlBody?: string;
  inReplyTo?: string;
  references?: string;
};

// Base64url MIME for Gmail's `raw` field. nodemailer encodes non-ASCII headers and neutralizes header injection.
export async function buildRaw(o: RawOptions): Promise<string> {
  const composer = new MailComposer({
    from: o.from,
    to: o.to?.length ? o.to : undefined,
    cc: o.cc?.length ? o.cc : undefined,
    bcc: o.bcc?.length ? o.bcc : undefined,
    subject: o.subject ?? '',
    text: o.body ?? (o.htmlBody ? undefined : ''),
    html: o.htmlBody,
    inReplyTo: o.inReplyTo,
    references: o.references,
  });
  const node = composer.compile();
  // Gmail reads recipients from the headers and strips Bcc itself, so the header must be kept.
  node.keepBcc = true;
  const buf = await node.build();
  return buf.toString('base64url');
}

export type ReplyHeaders = {
  threadId: string;
  inReplyTo: string;
  references: string;
  subject: string;
  from: string;
  replyTo: string;
  to: string[];
  cc: string[];
};

function addrOf(entry: string): string {
  const m = /<([^>]+)>/.exec(entry);
  return (m ? m[1] : entry).trim().toLowerCase();
}

// Headers needed to answer `messageId` in its thread. `selfEmail` makes a reply to your own message go to its recipients.
export async function replyHeaders(api: GmailApi, messageId: string, selfEmail?: string): Promise<ReplyHeaders> {
  const res = await api.users.messages.get({
    userId: 'me',
    id: messageId,
    format: 'metadata',
    metadataHeaders: ['Message-ID', 'References', 'In-Reply-To', 'Subject', 'From', 'Reply-To', 'To', 'Cc'],
  });
  const m = res.data;
  const h = (name: string): string => {
    const l = name.toLowerCase();
    return m.payload?.headers?.find((x) => x.name?.toLowerCase() === l)?.value ?? '';
  };
  const msgId = h('Message-ID').trim();
  const refs = h('References').trim();
  const subject0 = h('Subject').trim();
  const from = h('From');
  const replyTo = h('Reply-To') || from;
  let to = parseAddressList(replyTo);
  if (selfEmail && to.length && to.every((x) => addrOf(x) === selfEmail.trim().toLowerCase())) {
    const orig = parseAddressList(h('To'));
    if (orig.length) to = orig;
  }
  return {
    threadId: m.threadId ?? '',
    inReplyTo: msgId,
    references: [refs, msgId].filter(Boolean).join(' '),
    subject: /^re:/i.test(subject0) ? subject0 : `Re: ${subject0}`,
    from,
    replyTo,
    to,
    cc: parseAddressList(h('Cc')),
  };
}
