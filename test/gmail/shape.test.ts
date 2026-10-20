import type { gmail_v1 } from '@googleapis/gmail';
import { describe, expect, it } from 'vitest';
import { htmlToText, parseAddressList, shapeMessage, viewUrl } from '../../src/gmail/shape.js';

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');

function msg(payload: gmail_v1.Schema$MessagePart, extra: Partial<gmail_v1.Schema$Message> = {}): gmail_v1.Schema$Message {
  return { id: 'm1', threadId: 't1', labelIds: ['INBOX'], snippet: 'snip', payload, ...extra };
}
const headers = [
  { name: 'From', value: '"Doe, Jane" <jane@example.com>' },
  { name: 'To', value: 'a@example.com, "Smith, Bob" <bob@example.com>' },
  { name: 'Cc', value: 'c@example.com' },
  { name: 'Subject', value: 'Hello' },
  { name: 'Date', value: 'Tue, 20 Oct 2026 10:00:00 +0000' },
];

describe('viewUrl', () => {
  it('encodes + and @ in the email', () => {
    expect(viewUrl('a+b@example.com', 't9')).toBe('https://mail.google.com/mail/?authuser=a%2Bb%40example.com#all/t9');
  });
});

describe('parseAddressList', () => {
  it('respects quoted display names and angle brackets', () => {
    expect(parseAddressList('a@example.com, "Smith, Bob" <bob@example.com>,  c@example.com ')).toEqual([
      'a@example.com',
      '"Smith, Bob" <bob@example.com>',
      'c@example.com',
    ]);
    expect(parseAddressList(undefined)).toEqual([]);
    expect(parseAddressList('')).toEqual([]);
  });
});

describe('htmlToText', () => {
  it('strips script/style, converts breaks and decodes entities', () => {
    const t = htmlToText(
      '<style>p{}</style><script>alert(1)</script><p>Hi&nbsp;there &amp; &lt;you&gt; &#233; &#x41;</p><ul><li>one</li><li>two</li></ul>a<br>b',
    );
    expect(t).not.toContain('alert');
    expect(t).not.toContain('p{}');
    expect(t).toContain('Hi there & <you> é A');
    expect(t).toMatch(/- one\n- two/);
    expect(t).toMatch(/a\nb$/);
  });
});

describe('shapeMessage', () => {
  it('yields plaintextBody from an HTML-only multipart message', () => {
    const m = msg({
      mimeType: 'multipart/alternative',
      headers,
      parts: [{ mimeType: 'text/html', body: { data: b64('<p>Hello <b>world</b></p>') } }],
    });
    const s = shapeMessage(m, 'you@example.com', 'PLAIN_TEXT');
    expect(s.plaintextBody).toBe('Hello world');
    expect(s.htmlBody).toBeUndefined();
    expect(s.sender).toBe('"Doe, Jane" <jane@example.com>');
    expect(s.toRecipients).toEqual(['a@example.com', '"Smith, Bob" <bob@example.com>']);
    expect(s.ccRecipients).toEqual(['c@example.com']);
    expect(s.bccRecipients).toEqual([]);
    expect(s.viewUrl).toBe('https://mail.google.com/mail/?authuser=you%40example.com#all/t1');
  });

  it('prefers text/plain and includes html only for FULL_CONTENT', () => {
    const m = msg({
      mimeType: 'multipart/alternative',
      headers,
      parts: [
        { mimeType: 'text/plain', body: { data: b64('plain Çalışma') } },
        { mimeType: 'text/html', body: { data: b64('<b>html</b>') } },
      ],
    });
    expect(shapeMessage(m, 'e@example.com', 'PLAIN_TEXT').plaintextBody).toBe('plain Çalışma');
    const full = shapeMessage(m, 'e@example.com', 'FULL_CONTENT');
    expect(full.htmlBody).toBe('<b>html</b>');
    expect(full.plaintextBody).toBe('plain Çalışma');
  });

  it('truncates 30000-char bodies to 20000 with truncated: true', () => {
    const m = msg({ mimeType: 'text/plain', headers, body: { data: b64('x'.repeat(30000)) } });
    const s = shapeMessage(m, 'e@example.com', 'PLAIN_TEXT');
    expect(s.plaintextBody).toHaveLength(20000);
    expect(s.truncated).toBe(true);
    const small = shapeMessage(msg({ mimeType: 'text/plain', headers, body: { data: b64('ok') } }), 'e@example.com', 'PLAIN_TEXT');
    expect(small.truncated).toBeUndefined();
  });

  it('lists attachments with filename, mimeType and size', () => {
    const m = msg({
      mimeType: 'multipart/mixed',
      headers,
      parts: [
        { mimeType: 'text/plain', body: { data: b64('body') } },
        { mimeType: 'application/pdf', filename: 'a.pdf', body: { attachmentId: 'x', size: 123 } },
      ],
    });
    const s = shapeMessage(m, 'e@example.com', 'PLAIN_TEXT');
    expect(s.plaintextBody).toBe('body');
    expect(s.attachments).toEqual([{ filename: 'a.pdf', mimeType: 'application/pdf', size: 123 }]);
  });

  it('MINIMAL and METADATA_ONLY omit bodies', () => {
    const m = msg({ mimeType: 'text/plain', headers, body: { data: b64('body') } });
    const min = shapeMessage(m, 'e@example.com', 'MINIMAL');
    expect(min).toMatchObject({ id: 'm1', threadId: 't1', labelIds: ['INBOX'] });
    expect(min.subject).toBeUndefined();
    expect(min.plaintextBody).toBeUndefined();
    const meta = shapeMessage(m, 'e@example.com', 'METADATA_ONLY');
    expect(meta.subject).toBe('Hello');
    expect(meta.date).toBe('Tue, 20 Oct 2026 10:00:00 +0000');
    expect(meta.snippet).toBe('snip');
    expect(meta.plaintextBody).toBeUndefined();
  });

  it('decodes non-utf8 charsets from Content-Type', () => {
    const latin = Buffer.from([0x63, 0x61, 0x66, 0xe9]).toString('base64url');
    const m = msg({
      mimeType: 'text/plain',
      headers: [...headers, { name: 'Content-Type', value: 'text/plain; charset=ISO-8859-1' }],
      body: { data: latin },
    });
    expect(shapeMessage(m, 'e@example.com', 'PLAIN_TEXT').plaintextBody).toBe('café');
  });
});
