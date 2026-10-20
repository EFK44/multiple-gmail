import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../src/core/config.js';
import type { GmailApi } from '../../src/gmail/client.js';
import { buildMcpServer } from '../../src/mcp/buildServer.js';
import { resolveAccounts } from '../../src/mcp/accountArg.js';
import { parseAddressList } from '../../src/gmail/shape.js';

const TOOL_NAMES = [
  'create_draft',
  'get_message',
  'get_thread',
  'label_thread',
  'list_accounts',
  'list_drafts',
  'list_labels',
  'reply',
  'search_threads',
  'send_message',
  'unlabel_thread',
];

const APPROVAL =
  'Use ONLY after the user has explicitly approved sending this exact message in the conversation. ' +
  'Prefer create_draft first, then send_message with draftId.';

const cfg: AppConfig = {
  port: 47110,
  language: 'en',
  defaultAccount: 'alpha',
  accounts: {
    alpha: { email: 'alpha@example.com', addedAt: '2026-10-01T00:00:00.000Z' },
    beta: { email: 'beta@example.com', addedAt: '2026-10-02T00:00:00.000Z' },
  },
};

function hdrs(h: Record<string, string>) {
  return Object.entries(h).map(([name, value]) => ({ name, value }));
}

type Fake = ReturnType<typeof fakeApi>;
function fakeApi(alias: string) {
  return {
    users: {
      getProfile: vi.fn(),
      threads: {
        list: vi.fn(async () => ({ data: { threads: [{ id: `${alias}-t1`, snippet: 'hi' }], nextPageToken: 'np' } })),
        get: vi.fn(async (p: { id: string }) => ({
          data: {
            id: p.id,
            messages: [
              { id: `${p.id}-m1`, threadId: p.id, labelIds: ['INBOX'], payload: { headers: hdrs({ Subject: 'S' }) } },
              { id: `${p.id}-d1`, threadId: p.id, labelIds: ['DRAFT'] },
            ],
          },
        })),
        modify: vi.fn(async (p: { id: string }) => ({ data: { id: p.id } })),
      },
      messages: {
        get: vi.fn(async (p: { id: string }) => ({
          data: {
            id: p.id,
            threadId: 'T9',
            labelIds: ['INBOX'],
            payload: {
              mimeType: 'text/plain',
              headers: hdrs({
                'Message-ID': '<orig@example.com>',
                Subject: 'Hello',
                From: 'Sam <sam@example.org>',
                To: `${alias}@example.com, Kim <kim@example.org>`,
                Cc: 'SAM@example.org, lee@example.org',
              }),
              body: { data: Buffer.from('body text').toString('base64url') },
            },
          },
        })),
        send: vi.fn(async (_p: unknown) => ({ data: { id: 'sent1', threadId: 'T9', labelIds: ['SENT'] } })),
      },
      drafts: {
        list: vi.fn(async () => ({ data: { drafts: [{ id: 'd1', message: { id: 'dm1', threadId: 'DT' } }] } })),
        get: vi.fn(async () => ({ data: { id: 'd1', message: { id: 'dm1', threadId: 'DT', labelIds: ['DRAFT'] } } })),
        create: vi.fn(async (_p: unknown) => ({ data: { id: 'd2', message: { id: 'dm2', threadId: 'DT2' } } })),
        send: vi.fn(async () => ({ data: { id: 'sent2', threadId: 'DT', labelIds: ['SENT'] } })),
      },
      labels: {
        list: vi.fn(async () => ({
          data: { labels: [{ id: 'INBOX', name: 'INBOX', type: 'system', messagesTotal: 3 }] },
        })),
      },
    },
  };
}

let root: string;
let apis: Record<string, Fake>;
let client: Client;

async function connect() {
  const server = buildMcpServer({
    loadConfig: async () => cfg,
    getGmail: (async (alias: string) => {
      const api = apis[alias];
      if (!api) throw new Error('no fake for ' + alias);
      return { api: api as unknown as GmailApi, email: `${alias}@example.com` };
    }) as never,
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(ct);
}

async function call(name: string, args: Record<string, unknown>) {
  const r = await client.callTool({ name, arguments: args });
  const text = (r.content as { type: string; text: string }[])[0]?.text ?? '';
  return { r, text, data: r.structuredContent as Record<string, any> | undefined };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mg-mcp-'));
  process.env.MULTIPLE_GMAIL_HOME = join(root, 'home');
  apis = { alpha: fakeApi('alpha'), beta: fakeApi('beta') };
  await connect();
});
afterEach(async () => {
  await client.close();
  delete process.env.MULTIPLE_GMAIL_HOME;
  await rm(root, { recursive: true, force: true });
});

describe('tool list', () => {
  it('exposes exactly the 11 tools, none destructive of mail', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(TOOL_NAMES);
    for (const n of names) expect(n).not.toMatch(/trash|delete|spam/);
    for (const t of tools) {
      expect(t.description?.startsWith('Multi-account Gmail.')).toBe(true);
      if (t.name !== 'list_accounts') {
        expect(JSON.stringify(t.inputSchema)).toContain('Alias or email from list_accounts');
      }
    }
    const send = tools.find((t) => t.name === 'send_message')!;
    expect(send.description).toContain(APPROVAL);
    expect(send.annotations?.destructiveHint).toBe(true);
    expect(send.annotations?.openWorldHint).toBe(true);
    expect(tools.find((t) => t.name === 'reply')!.description).toContain(APPROVAL);
    expect(tools.find((t) => t.name === 'search_threads')!.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === 'label_thread')!.annotations?.idempotentHint).toBe(true);
    const draft = tools.find((t) => t.name === 'create_draft')!;
    expect(draft.annotations?.readOnlyHint).toBe(false);
    expect(draft.annotations?.destructiveHint).toBe(false);
  });
});

describe('resolveAccounts', () => {
  const load = async () => cfg;
  it('maps alias or email case-insensitively', async () => {
    expect(await resolveAccounts('ALPHA', false, load)).toEqual(['alpha']);
    expect(await resolveAccounts('Beta@Example.com', false, load)).toEqual(['beta']);
    expect(await resolveAccounts('all', true, load)).toEqual(['alpha', 'beta']);
  });
  it('rejects all where not allowed and unknown accounts', async () => {
    await expect(resolveAccounts('all', false, load)).rejects.toThrow(
      "This tool needs one account; 'all' is only for search_threads, list_labels, list_drafts.",
    );
    await expect(resolveAccounts('nope', false, load)).rejects.toThrow(/alpha, beta/);
  });
});

describe('internal errors', () => {
  it('config failures do not leak local paths', async () => {
    await client.close();
    const server = buildMcpServer({
      loadConfig: async () => {
        throw new Error('Config file C:\\Users\\someone\\config.json is not valid JSON');
      },
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(ct);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      for (const [name, args] of [
        ['list_accounts', {}],
        ['get_thread', { account: 'alpha', threadId: 't' }],
      ] as const) {
        const { r, text } = await call(name, args);
        expect(r.isError).toBe(true);
        expect(text).toMatch(/^Internal error in multiple-gmail/);
        expect(text).not.toContain('someone');
      }
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('local failures while opening an account do not leak, in single and all mode', async () => {
    apis.beta.users.labels.list.mockRejectedValue(new Error('EPERM: open C:\\Users\\someone\\token.bin'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const one = await call('list_labels', { account: 'beta' });
      expect(one.r.isError).toBe(true);
      expect(one.text).toMatch(/^Internal error in multiple-gmail/);
      const all = await call('list_labels', { account: 'all' });
      expect(all.data!.results.map((x: { account: string }) => x.account)).toEqual(['alpha']);
      expect(all.data!.errors[0].message).toMatch(/^Internal error in multiple-gmail/);
      expect(all.text).not.toContain('someone');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('list_accounts', () => {
  it('returns alias, email, status, addedAt', async () => {
    const { data, r } = await call('list_accounts', {});
    expect(r.isError).toBeFalsy();
    expect(data!.accounts).toEqual([
      { alias: 'alpha', email: 'alpha@example.com', status: 'ok', addedAt: '2026-10-01T00:00:00.000Z' },
      { alias: 'beta', email: 'beta@example.com', status: 'ok', addedAt: '2026-10-02T00:00:00.000Z' },
    ]);
  });
});

describe('search_threads', () => {
  it('single account returns threads with MINIMAL messages and viewUrl', async () => {
    const { data, text } = await call('search_threads', { account: 'alpha', query: 'is:unread' });
    expect(JSON.parse(text)).toEqual(data);
    expect(data!.account).toBe('alpha');
    expect(data!.nextPageToken).toBe('np');
    expect(data!.threads[0].id).toBe('alpha-t1');
    expect(data!.threads[0].viewUrl).toBe('https://mail.google.com/mail/?authuser=alpha%40example.com#all/alpha-t1');
    expect(data!.threads[0].messages[0]).toEqual({
      id: 'alpha-t1-m1',
      threadId: 'alpha-t1',
      viewUrl: 'https://mail.google.com/mail/?authuser=alpha%40example.com#all/alpha-t1',
      labelIds: ['INBOX'],
    });
    expect(apis.alpha.users.threads.list).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'me', q: 'is:unread', maxResults: 20, includeSpamTrash: false }),
    );
  });

  it('all: one failing account does not stop the others', async () => {
    apis.beta.users.threads.list.mockRejectedValue(
      Object.assign(new Error('Too many'), { response: { status: 429 }, config: { headers: { Authorization: 'Bearer SECRET' } } }),
    );
    const { data, r, text } = await call('search_threads', { account: 'all' });
    expect(r.isError).toBeFalsy();
    expect(data!.results.map((x: { account: string }) => x.account)).toEqual(['alpha']);
    expect(data!.results[0].threads).toHaveLength(1);
    expect(data!.errors[0].account).toBe('beta');
    expect(data!.errors[0].message).toMatch(/rate limit/);
    expect(text).not.toContain('SECRET');
  });

  it('skips a thread deleted between list and get', async () => {
    apis.alpha.users.threads.list.mockResolvedValue({
      data: { threads: [{ id: 'gone', snippet: '' }, { id: 'alpha-t1', snippet: 'hi' }], nextPageToken: 'np' },
    });
    const get = apis.alpha.users.threads.get.getMockImplementation()!;
    apis.alpha.users.threads.get.mockImplementation(async (p: { id: string }) => {
      if (p.id === 'gone') {
        throw Object.assign(new Error('Requested entity was not found.'), {
          response: { status: 404 },
          config: { headers: { Authorization: 'Bearer SECRET' } },
        });
      }
      return get(p);
    });
    const { r, data, text } = await call('search_threads', { account: 'alpha' });
    expect(r.isError).toBeFalsy();
    expect(data!.threads.map((t: { id: string }) => t.id)).toEqual(['alpha-t1']);
    expect(text).not.toContain('SECRET');
  });

  it('a non-404 thread failure still fails that account with a friendly message', async () => {
    apis.beta.users.threads.get.mockRejectedValue(Object.assign(new Error('x'), { response: { status: 429 } }));
    const { data } = await call('search_threads', { account: 'all' });
    expect(data!.results.map((x: { account: string }) => x.account)).toEqual(['alpha']);
    expect(data!.errors).toEqual([{ account: 'beta', message: 'Gmail rate limit for beta, retry in a minute.' }]);
  });

  it('all rejects a pageToken', async () => {
    const { r, text } = await call('search_threads', { account: 'all', pageToken: 'x' });
    expect(r.isError).toBe(true);
    expect(text).toMatch(/page further with a single account/);
  });

  it('rejects pageSize above 50', async () => {
    const { r } = await call('search_threads', { account: 'alpha', pageSize: 51 });
    expect(r.isError).toBe(true);
  });
});

describe('get_thread / get_message', () => {
  it('get_thread rejects all', async () => {
    const { r, text } = await call('get_thread', { account: 'all', threadId: 't' });
    expect(r.isError).toBe(true);
    expect(text).toContain("'all' is only for");
  });

  it('unknown account error lists aliases', async () => {
    const { r, text } = await call('get_thread', { account: 'gamma', threadId: 't' });
    expect(r.isError).toBe(true);
    expect(text).toContain('alpha, beta');
  });

  it('get_thread defaults to PLAIN_TEXT and drops drafts', async () => {
    const { data } = await call('get_thread', { account: 'beta', threadId: 'T1' });
    expect(apis.beta.users.threads.get).toHaveBeenCalledWith(expect.objectContaining({ id: 'T1', format: 'full' }));
    expect(data!.account).toBe('beta');
    expect(data!.messages.map((m: { id: string }) => m.id)).toEqual(['T1-m1']);
    expect(data!.messages[0].subject).toBe('S');
  });

  it('get_message returns shaped body', async () => {
    const { data } = await call('get_message', { account: 'alpha@example.com', messageId: 'M1' });
    expect(data!.account).toBe('alpha');
    expect(data!.plaintextBody).toBe('body text');
    expect(data!.viewUrl).toContain('#all/T9');
  });

  it('gmail errors become isError with a friendly message', async () => {
    apis.alpha.users.messages.get.mockRejectedValue(Object.assign(new Error('x'), { response: { status: 429 } }));
    const { r, text } = await call('get_message', { account: 'alpha', messageId: 'M1' });
    expect(r.isError).toBe(true);
    expect(text).toBe('Gmail rate limit for alpha, retry in a minute.');
  });
});

describe('list_drafts / list_labels', () => {
  it('list_drafts all returns per account drafts', async () => {
    const { data } = await call('list_drafts', { account: 'all' });
    expect(data!.results).toHaveLength(2);
    expect(data!.results[0].drafts[0].id).toBe('d1');
    expect(data!.results[0].drafts[0].message.id).toBe('dm1');
  });

  it('list_labels returns id, name, type', async () => {
    const { data } = await call('list_labels', { account: 'beta' });
    expect(data!.labels).toEqual([{ id: 'INBOX', name: 'INBOX', type: 'system' }]);
  });
});

// Lowercased addresses of one header in a MIME message (folded continuation lines joined).
function addrs(mime: string, name: string): string[] {
  const head = mime.split(/\r?\n\r?\n/)[0].replace(/\r?\n[ \t]+/g, ' ');
  const line = new RegExp('^' + name + ': (.*)$', 'mi').exec(head);
  if (!line) return [];
  return parseAddressList(line[1]).map((x) => (/<([^>]+)>/.exec(x)?.[1] ?? x).trim().toLowerCase());
}

function rawOf(fn: { mock: { calls: unknown[][] } }): string {
  const arg = fn.mock.calls[0][0] as { requestBody: { raw?: string; message?: { raw: string } } };
  const raw = arg.requestBody.raw ?? arg.requestBody.message!.raw;
  return Buffer.from(raw, 'base64url').toString('utf8');
}

describe('compose tools', () => {
  it('create_draft as a reply threads it', async () => {
    const { data } = await call('create_draft', { account: 'alpha', replyToMessageId: 'M1', body: 'thanks' });
    expect(data).toMatchObject({ account: 'alpha', id: 'd2', threadId: 'DT2' });
    const arg = apis.alpha.users.drafts.create.mock.calls[0][0] as { requestBody: { message: { threadId: string } } };
    expect(arg.requestBody.message.threadId).toBe('T9');
    const mime = rawOf(apis.alpha.users.drafts.create);
    expect(mime).toContain('In-Reply-To: <orig@example.com>');
    expect(mime).toContain('Subject: Re: Hello');
  });

  it('send_message needs draftId or to', async () => {
    const { r } = await call('send_message', { account: 'alpha', subject: 'x', body: 'y' });
    expect(r.isError).toBe(true);
    expect(apis.alpha.users.messages.send).not.toHaveBeenCalled();
  });

  it('send_message with draftId sends the draft', async () => {
    const { data } = await call('send_message', { account: 'alpha', draftId: 'd1' });
    expect(apis.alpha.users.drafts.send).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'me', requestBody: { id: 'd1' } }),
    );
    expect(data!.id).toBe('sent2');
  });

  it('send_message new message', async () => {
    const { data } = await call('send_message', { account: 'beta', to: ['x@example.org'], subject: 'Hi', body: 'b' });
    expect(data).toMatchObject({ account: 'beta', id: 'sent1', threadId: 'T9' });
    const mime = rawOf(apis.beta.users.messages.send);
    expect(mime).toContain('To: x@example.org');
    expect(mime).toContain('From: beta@example.com');
  });

  it('reply all collects From, To, Cc minus self, deduplicated', async () => {
    await call('reply', { account: 'alpha', messageId: 'M1', body: 'ok', replyAll: true });
    const mime = rawOf(apis.alpha.users.messages.send);
    expect(addrs(mime, 'To')).toEqual(['sam@example.org']);
    expect(addrs(mime, 'Cc')).toEqual(['kim@example.org', 'lee@example.org']);
    expect(addrs(mime, 'To')).not.toContain('alpha@example.com');
    expect(addrs(mime, 'Cc')).not.toContain('alpha@example.com');
    const arg = apis.alpha.users.messages.send.mock.calls[0][0] as { requestBody: { threadId: string } };
    expect(arg.requestBody.threadId).toBe('T9');
  });

  it('reply with explicit to and cc overrides computed recipients', async () => {
    await call('reply', {
      account: 'alpha',
      messageId: 'M1',
      body: 'ok',
      replyAll: true,
      to: ['x@example.org'],
      cc: ['y@example.org'],
    });
    const mime = rawOf(apis.alpha.users.messages.send);
    expect(addrs(mime, 'To')).toEqual(['x@example.org']);
    expect(addrs(mime, 'Cc')).toEqual(['y@example.org']);
  });

  it('reply without body and htmlBody is an error', async () => {
    const { r, text } = await call('reply', { account: 'alpha', messageId: 'M1' });
    expect(r.isError).toBe(true);
    expect(text).toMatch(/needs body/);
    expect(apis.alpha.users.messages.send).not.toHaveBeenCalled();
  });

  it('send_message with draftId plus other fields is rejected', async () => {
    const { r, text } = await call('send_message', { account: 'alpha', draftId: 'd1', subject: 'x' });
    expect(r.isError).toBe(true);
    expect(text).toMatch(/draftId sends the draft as is/);
    expect(apis.alpha.users.drafts.send).not.toHaveBeenCalled();
  });

  it('plain reply goes only to the sender', async () => {
    await call('reply', { account: 'alpha', messageId: 'M1', body: 'ok' });
    const mime = rawOf(apis.alpha.users.messages.send);
    expect(/^To: .*sam@example.org/m.test(mime)).toBe(true);
    expect(/^Cc:/m.test(mime)).toBe(false);
  });
});

describe('labels', () => {
  it('label_thread calls threads.modify with addLabelIds', async () => {
    const { r } = await call('label_thread', { account: 'alpha', threadId: 'T1', labelIds: ['STARRED'] });
    expect(r.isError).toBeFalsy();
    expect(apis.alpha.users.threads.modify).toHaveBeenCalledWith({
      userId: 'me',
      id: 'T1',
      requestBody: { addLabelIds: ['STARRED'] },
    });
  });

  it('unlabel_thread uses removeLabelIds and requires at least one id', async () => {
    await call('unlabel_thread', { account: 'alpha', threadId: 'T1', labelIds: ['UNREAD'] });
    expect(apis.alpha.users.threads.modify).toHaveBeenCalledWith({
      userId: 'me',
      id: 'T1',
      requestBody: { removeLabelIds: ['UNREAD'] },
    });
    const { r } = await call('unlabel_thread', { account: 'alpha', threadId: 'T1', labelIds: [] });
    expect(r.isError).toBe(true);
  });
});
