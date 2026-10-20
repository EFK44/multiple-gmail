import type { gmail_v1 } from '@googleapis/gmail';

export type MessageFormat = 'MINIMAL' | 'METADATA_ONLY' | 'PLAIN_TEXT' | 'FULL_CONTENT';

export const BODY_CAP = 20000;

export type ShapedMessage = {
  id: string;
  threadId: string;
  viewUrl: string;
  labelIds: string[];
  sender?: string;
  toRecipients?: string[];
  ccRecipients?: string[];
  bccRecipients?: string[];
  subject?: string;
  snippet?: string;
  date?: string;
  plaintextBody?: string;
  htmlBody?: string;
  attachments?: { filename: string; mimeType: string; size: number }[];
  truncated?: true;
};

export function viewUrl(email: string, threadId: string): string {
  return 'https://mail.google.com/mail/?authuser=' + encodeURIComponent(email) + '#all/' + threadId;
}

// Splits a header list on top-level commas only, so "Last, First" <b@x> stays one entry.
export function parseAddressList(value: string | null | undefined): string[] {
  if (!value) return [];
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  let angle = 0;
  let paren = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (quoted) {
      cur += c;
      if (c === '\\' && i + 1 < value.length) cur += value[++i];
      else if (c === '"') quoted = false;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === '<') angle++;
    else if (c === '>') angle = Math.max(0, angle - 1);
    else if (c === '(') paren++;
    else if (c === ')') paren = Math.max(0, paren - 1);
    if (c === ',' && angle === 0 && paren === 0) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  copy: '©',
  reg: '®',
  hellip: '…',
  ndash: '–',
  mdash: '—',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  bull: '•',
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, g: string) => {
    if (g[0] === '#') {
      const cp = g[1].toLowerCase() === 'x' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
      if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff) return m;
      try {
        return String.fromCodePoint(cp);
      } catch {
        return m;
      }
    }
    return ENTITIES[g.toLowerCase()] ?? m;
  });
}

// Small, dependency-free HTML to text. The output is plain text and is never re-interpreted as HTML.
export function htmlToText(html: string): string {
  let t = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|head)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/(p|div|tr|h[1-6]|ul|ol|table|blockquote)\s*>/gi, '\n\n')
    .replace(/<(p|div|tr|h[1-6]|blockquote)\b[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, '');
  t = decodeEntities(t);
  return t
    .replace(/\r/g, '')
    .replace(/[ \t\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function header(p: gmail_v1.Schema$MessagePart | undefined, name: string): string | undefined {
  const lower = name.toLowerCase();
  return p?.headers?.find((h) => h.name?.toLowerCase() === lower)?.value ?? undefined;
}

function charsetOf(p: gmail_v1.Schema$MessagePart): string {
  const m = /charset\s*=\s*"?([\w.:-]+)"?/i.exec(header(p, 'Content-Type') ?? '');
  return m ? m[1] : 'utf-8';
}

function decodeBody(p: gmail_v1.Schema$MessagePart): string {
  const data = p.body?.data;
  if (!data) return '';
  const buf = Buffer.from(data, 'base64url');
  try {
    return new TextDecoder(charsetOf(p)).decode(buf);
  } catch {
    return buf.toString('utf8');
  }
}

function walk(p: gmail_v1.Schema$MessagePart | undefined, visit: (p: gmail_v1.Schema$MessagePart) => void): void {
  if (!p) return;
  visit(p);
  for (const c of p.parts ?? []) walk(c, visit);
}

function collect(payload: gmail_v1.Schema$MessagePart | undefined) {
  const plain: string[] = [];
  const html: string[] = [];
  const attachments: { filename: string; mimeType: string; size: number }[] = [];
  walk(payload, (p) => {
    if (p.filename) {
      attachments.push({
        filename: p.filename,
        mimeType: p.mimeType ?? 'application/octet-stream',
        size: p.body?.size ?? 0,
      });
      return;
    }
    if (p.mimeType === 'text/plain') plain.push(decodeBody(p));
    else if (p.mimeType === 'text/html') html.push(decodeBody(p));
  });
  return { plain: plain.join('\n').trim(), html: html.join('\n').trim(), attachments };
}

function cap(s: string): { text: string; cut: boolean } {
  return s.length > BODY_CAP ? { text: s.slice(0, BODY_CAP), cut: true } : { text: s, cut: false };
}

export function shapeMessage(m: gmail_v1.Schema$Message, email: string, format: MessageFormat): ShapedMessage {
  const threadId = m.threadId ?? '';
  const out: ShapedMessage = {
    id: m.id ?? '',
    threadId,
    viewUrl: viewUrl(email, threadId),
    labelIds: m.labelIds ?? [],
  };
  if (format === 'MINIMAL') return out;

  const p = m.payload ?? undefined;
  out.sender = header(p, 'From') ?? '';
  out.toRecipients = parseAddressList(header(p, 'To'));
  out.ccRecipients = parseAddressList(header(p, 'Cc'));
  out.bccRecipients = parseAddressList(header(p, 'Bcc'));
  out.subject = header(p, 'Subject') ?? '';
  out.snippet = m.snippet ?? '';
  out.date = header(p, 'Date') ?? (m.internalDate ? new Date(Number(m.internalDate)).toISOString() : '');
  if (format === 'METADATA_ONLY') return out;

  const { plain, html, attachments } = collect(p);
  const c = cap(plain || (html ? htmlToText(html) : ''));
  out.plaintextBody = c.text;
  let truncated = c.cut;
  if (format === 'FULL_CONTENT' && html) {
    const h = cap(html);
    out.htmlBody = h.text;
    truncated = truncated || h.cut;
  }
  if (attachments.length) out.attachments = attachments;
  if (truncated) out.truncated = true;
  return out;
}
