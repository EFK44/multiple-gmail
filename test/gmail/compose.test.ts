import type { gmail_v1 } from '@googleapis/gmail';
import { describe, expect, it } from 'vitest';
import { buildRaw, replyHeaders } from '../../src/gmail/compose.js';
import type { GmailApi } from '../../src/gmail/client.js';

function decodeRaw(raw: string): string {
  return Buffer.from(raw, 'base64url').toString('utf8');
}
function decodedSubject(mime: string): string {
  const line = /^Subject: (.*)$/m.exec(mime)![1];
  const m = /^=\?UTF-8\?([QB])\?(.*)\?=$/i.exec(line);
  if (!m) return line;
  if (m[1].toUpperCase() === 'B') return Buffer.from(m[2], 'base64').toString('utf8');
  const bytes = m[2].replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
  return Buffer.from(bytes, 'latin1').toString('utf8');
}

describe('buildRaw', () => {
  it('round-trips a Turkish subject and body as base64url', async () => {
    const raw = await buildRaw({
      from: 'you@example.com',
      to: ['a@example.com'],
      cc: ['b@example.com'],
      bcc: ['c@example.com'],
      subject: 'Çalışma planı',
      body: 'Merhaba şimdi',
    });
    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/);
    const mime = decodeRaw(raw);
    expect(decodedSubject(mime)).toBe('Çalışma planı');
    expect(mime).toMatch(/^To: a@example\.com/m);
    expect(mime).toMatch(/^Cc: b@example\.com/m);
    expect(mime).toMatch(/^Bcc: c@example\.com/m);
    expect(mime).toContain('Content-Type: text/plain');
  });

  it('adds threading headers and an html alternative', async () => {
    const mime = decodeRaw(
      await buildRaw({
        from: 'you@example.com',
        to: ['a@example.com'],
        subject: 'Re: x',
        body: 'hi',
        htmlBody: '<b>hi</b>',
        inReplyTo: '<id1@example.com>',
        references: '<id0@example.com> <id1@example.com>',
      }),
    );
    expect(mime).toMatch(/^In-Reply-To: <id1@example\.com>/m);
    expect(mime).toMatch(/^References: <id0@example\.com> <id1@example\.com>/m);
    expect(mime).toContain('multipart/alternative');
    expect(mime).toContain('text/html');
  });

  it('cannot be header-injected through the subject', async () => {
    const mime = decodeRaw(
      await buildRaw({ from: 'you@example.com', to: ['a@example.com'], subject: 'x\r\nBcc: evil@example.com', body: 'b' }),
    );
    expect(mime).not.toMatch(/^Bcc: evil@example\.com/m);
  });
});

function fakeApi(headers: Record<string, string>, threadId = 't1'): GmailApi {
  const message: gmail_v1.Schema$Message = {
    id: 'm1',
    threadId,
    payload: { headers: Object.entries(headers).map(([name, value]) => ({ name, value })) },
  };
  return { users: { messages: { get: async () => ({ data: message }) } } } as unknown as GmailApi;
}

describe('replyHeaders', () => {
  it('adds Re: once and builds references', async () => {
    const h = await replyHeaders(
      fakeApi({
        'Message-ID': '<id1@example.com>',
        References: '<id0@example.com>',
        Subject: 'Re: Hello',
        From: 'Jane <jane@example.com>',
        To: 'you@example.com',
        Cc: 'c@example.com',
      }),
      'm1',
    );
    expect(h.subject).toBe('Re: Hello');
    expect(h.inReplyTo).toBe('<id1@example.com>');
    expect(h.references).toBe('<id0@example.com> <id1@example.com>');
    expect(h.threadId).toBe('t1');
    expect(h.to).toEqual(['Jane <jane@example.com>']);
    expect(h.cc).toEqual(['c@example.com']);
    const plain = await replyHeaders(fakeApi({ 'Message-ID': '<i@x>', Subject: 'Hello', From: 'j@example.com' }), 'm1');
    expect(plain.subject).toBe('Re: Hello');
    expect(plain.references).toBe('<i@x>');
    const upper = await replyHeaders(fakeApi({ 'Message-ID': '<i@x>', Subject: 'RE: Hello', From: 'j@example.com' }), 'm1');
    expect(upper.subject).toBe('RE: Hello');
  });

  it('prefers Reply-To', async () => {
    const h = await replyHeaders(fakeApi({ 'Message-ID': '<i@x>', From: 'j@example.com', 'Reply-To': 'r@example.com' }), 'm1');
    expect(h.to).toEqual(['r@example.com']);
    expect(h.replyTo).toBe('r@example.com');
    expect(h.subject).toBe('Re: ');
  });

  it('replying to your own message targets the original recipients', async () => {
    const h = await replyHeaders(
      fakeApi({ 'Message-ID': '<i@x>', From: 'You <you@example.com>', To: 'a@example.com', Subject: 'S' }),
      'm1',
      'you@example.com',
    );
    expect(h.to).toEqual(['a@example.com']);
  });
});
