import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { removeAccount, renameAccount } from '../core/accounts.js';
import { accountNames, findAccount, getAccount, loadConfig, NameError, sameName, validateName } from '../core/config.js';
import { AccountError, AuthFlowError, startLoopbackAuth } from '../core/googleAuth.js';
import { loadClient } from '../core/secrets.js';
import { openUrl } from '../core/openUrl.js';
import { clearGmailCache } from '../gmail/client.js';
import { VERSION } from '../version.js';
import { hashPassword, MIN_PASSWORD_LENGTH } from '../remote/adminAuth.js';
import { runLocalMode } from './localHttp.js';
import { runRemoteMode } from './remote.js';

export type CliIo = {
  log: (s: string) => void;
  error: (s: string) => void;
  isTty: boolean;
  confirm: (prompt: string) => Promise<string>;
  openUrl: (url: string) => Promise<boolean | void>;
  // Starts the local setup server (no args, --minimized, --print-url); injectable for tests.
  startLocal?: (opts: { openBrowser: boolean; printUrl: boolean }) => Promise<number>;
  // Environment for serve --remote (defaults to process.env).
  env?: Record<string, string | undefined>;
  // Reads a secret (hash-password): hidden input on a terminal, otherwise one line from stdin.
  readSecret?: (prompt: string) => Promise<string>;
};

export const EXIT_OK = 0;
export const EXIT_USER_ERROR = 1;

const USAGE = `Usage: multiple-gmail [command]

  (no command)                        open the local setup app in the browser
  --minimized                         start the local server without opening the browser
  --print-url                         print a fresh single-use setup link instead of opening the browser
  --stdio                             run as an MCP server over stdio
  accounts list                       list connected accounts
  accounts add --name X [--email Y]   connect a Gmail account (any name, quote spaces)
  accounts reconnect X                re-authorize an account (name, email or id)
  accounts rename X NEW               rename an account
  accounts remove X [--yes]           disconnect an account
  gen-key                             print a new MULTIPLE_GMAIL_MASTER_KEY
  hash-password                       print an ADMIN_PASSWORD_HASH for serve --remote
  serve --remote                      server mode for web AI apps (see DEPLOY.md)
  --version, --help`;

export function defaultIo(): CliIo {
  return {
    log: (s) => console.log(s),
    error: (s) => console.error(s),
    isTty: !!process.stdin.isTTY,
    confirm: async (prompt) => {
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      try {
        return await rl.question(prompt);
      } finally {
        rl.close();
      }
    },
    openUrl,
  };
}

// Hidden input on a TTY (no echo), else the first line of stdin (piped).
export function readSecretFromStdin(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      stdin.on('data', (c: Buffer) => chunks.push(c));
      stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8').split(/\r?\n/)[0] ?? ''));
      stdin.on('error', reject);
    });
  }
  return new Promise((resolve, reject) => {
    process.stderr.write(prompt);
    let value = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const done = (err?: Error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
      stdin.off('end', onEnd);
      process.stderr.write('\n');
      if (err) reject(err);
      else resolve(value);
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        // Enter, or Ctrl+D (end of input).
        if (ch === '\r' || ch === '\n' || ch === '\u0004') return done();
        if (ch === '\u0003') return done(new Error('Cancelled.'));
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else if (ch >= ' ') value += ch;
      }
    };
    const onEnd = () => done();
    stdin.on('data', onData);
    stdin.on('end', onEnd);
  });
}

async function hashPasswordCommand(io: CliIo): Promise<number> {
  const read = io.readSecret ?? readSecretFromStdin;
  const password = await read('Admin password: ');
  if (password.length < MIN_PASSWORD_LENGTH) {
    io.error(`The password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
    return EXIT_USER_ERROR;
  }
  if (io.isTty) {
    const again = await read('Repeat the password: ');
    if (again !== password) {
      io.error('The passwords do not match.');
      return EXIT_USER_ERROR;
    }
  }
  io.log(await hashPassword(password));
  return EXIT_OK;
}

function parseFlags(args: string[]): { flags: Map<string, string | true>; positional: string[] } {
  const flags = new Map<string, string | true>();
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('--') && a !== '--yes') {
        flags.set(a, next);
        i++;
      } else flags.set(a, true);
    } else positional.push(a);
  }
  return { flags, positional };
}

const ADMIN_STEPS = (clientId: string) =>
  [
    'Your Google Workspace admin has blocked this app. Ask the admin to trust it:',
    '  Admin console > Security > Access and data control > API controls > Manage third-party app access',
    '  > Configure new app > search by client ID > Trusted',
    `  Client ID: ${clientId}`,
  ].join('\n');

// Resolves a name, email or id to the account id, or prints the available names.
async function resolveOrError(ref: string, io: CliIo): Promise<string | null> {
  const cfg = await loadConfig();
  const id = findAccount(cfg, ref);
  if (id) return id;
  const names = accountNames(cfg);
  io.error(`Unknown account "${ref}".${names.length ? ` Available accounts: ${names.join(', ')}.` : ''}`);
  return null;
}

// `target`: the new name (add) or the account id (reconnect); `label` is shown in messages.
async function connect(target: string, label: string, email: string | undefined, reconnect: boolean, io: CliIo): Promise<number> {
  let started;
  try {
    started = await startLoopbackAuth(target, { reconnect, loginHint: email, ...(reconnect ? { id: target } : {}) });
  } catch (e) {
    const msg = (e as Error).message;
    const code = e instanceof AccountError ? e.code : undefined;
    if (code === 'no_client') {
      io.error('No OAuth client is configured yet. Finish the setup in the multiple-gmail app (the wizard) first.');
    } else if (code === 'name_exists') {
      io.error(`${msg} To re-authorize it use: accounts reconnect "${label}"`);
    } else io.error(msg);
    return EXIT_USER_ERROR;
  }
  io.log('Open this URL to sign in with Google:');
  io.log(started.url);
  await io.openUrl(started.url).catch(() => {});
  try {
    const acct = await started.done;
    if (reconnect) clearGmailCache(acct.id);
    io.log(`${reconnect ? 'Reconnected' : 'Connected'} ${acct.name} (${acct.email})`);
    return EXIT_OK;
  } catch (e) {
    if (e instanceof AuthFlowError && e.code === 'admin_blocked') {
      const client = await loadClient().catch(() => null);
      io.error(ADMIN_STEPS(client?.clientId ?? '(unknown)'));
    } else io.error(`Could not connect ${label}: ${(e as Error).message}`);
    return EXIT_USER_ERROR;
  }
}

async function accounts(args: string[], io: CliIo): Promise<number> {
  const [sub, ...rest] = args;
  const { flags, positional } = parseFlags(rest);
  if (sub === 'list') {
    const cfg = await loadConfig();
    const entries = Object.entries(cfg.accounts);
    if (!entries.length) {
      io.log('No accounts connected');
      return EXIT_OK;
    }
    for (const [id, a] of entries) {
      io.log(`${a.name}${cfg.defaultAccount === id ? ' (default)' : ''}  ${a.email}`);
    }
    return EXIT_OK;
  }
  if (sub === 'add') {
    // --alias is the older spelling.
    const nameFlag = flags.get('--name') ?? flags.get('--alias');
    if (typeof nameFlag !== 'string') {
      io.error('Usage: accounts add --name X [--email Y]');
      return EXIT_USER_ERROR;
    }
    const cfg = await loadConfig();
    let name: string;
    try {
      name = validateName(nameFlag, cfg);
    } catch (e) {
      if (!(e instanceof NameError)) throw e;
      const taken = e.code === 'taken' ? Object.values(cfg.accounts).find((a) => sameName(a.name, nameFlag)) : undefined;
      io.error(taken ? `${e.message} To re-authorize it use: accounts reconnect "${taken.name}"` : e.message);
      return EXIT_USER_ERROR;
    }
    const email = flags.get('--email');
    return connect(name, name, typeof email === 'string' ? email : undefined, false, io);
  }
  if (sub === 'reconnect') {
    if (!positional[0]) {
      io.error('Usage: accounts reconnect X');
      return EXIT_USER_ERROR;
    }
    const id = await resolveOrError(positional[0], io);
    if (!id) return EXIT_USER_ERROR;
    const acct = getAccount(await loadConfig(), id);
    return connect(id, acct?.name ?? id, undefined, true, io);
  }
  if (sub === 'rename') {
    if (!positional[0] || !positional[1]) {
      io.error('Usage: accounts rename X NEW (quote names with spaces)');
      return EXIT_USER_ERROR;
    }
    const id = await resolveOrError(positional[0], io);
    if (!id) return EXIT_USER_ERROR;
    const before = getAccount(await loadConfig(), id)?.name ?? id;
    try {
      const after = await renameAccount(id, positional.slice(1).join(' '));
      io.log(`Renamed "${before}" to "${after.name}".`);
      return EXIT_OK;
    } catch (e) {
      io.error((e as Error).message);
      return EXIT_USER_ERROR;
    }
  }
  if (sub === 'remove') {
    if (!positional[0]) {
      io.error('Usage: accounts remove X [--yes]');
      return EXIT_USER_ERROR;
    }
    const alias = await resolveOrError(positional[0], io);
    if (!alias) return EXIT_USER_ERROR;
    const name = getAccount(await loadConfig(), alias)?.name ?? alias;
    if (flags.get('--yes') !== true && !io.isTty) {
      io.error('Use --yes to confirm removal in non-interactive mode.');
      return EXIT_USER_ERROR;
    }
    if (flags.get('--yes') !== true) {
      const answer = await io.confirm(`Type the account name (${name}) to confirm: `);
      if (!sameName(answer, name)) {
        io.error('Cancelled: the name did not match.');
        return EXIT_USER_ERROR;
      }
    }
    try {
      const { revoked } = await removeAccount(alias);
      clearGmailCache(alias);
      io.log(`Removed ${name}.`);
      io.log(
        revoked
          ? 'Google access was revoked.'
          : 'Google revoke did not succeed; revoke it manually at myaccount.google.com/permissions.',
      );
      return EXIT_OK;
    } catch (e) {
      const msg = (e as Error).message;
      io.error(e instanceof AccountError && e.code === 'unknown_account' ? `Unknown account "${name}".` : msg);
      return EXIT_USER_ERROR;
    }
  }
  io.error(USAGE);
  return EXIT_USER_ERROR;
}

export async function runCli(argv: string[], io: CliIo = defaultIo()): Promise<number> {
  const [cmd, ...rest] = argv;
  try {
    const local = new Set(['--minimized', '--print-url']);
    if (argv.length <= 2 && argv.every((a) => local.has(a)) && new Set(argv).size === argv.length) {
      const printUrl = argv.includes('--print-url');
      return await (io.startLocal ?? runLocalMode)({ openBrowser: argv.length === 0, printUrl });
    }
    if (cmd === '--version' || cmd === '-v') {
      io.log(VERSION);
      return EXIT_OK;
    }
    if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
      io.log(USAGE);
      return EXIT_OK;
    }
    if (cmd === 'gen-key') {
      io.log(randomBytes(32).toString('base64'));
      return EXIT_OK;
    }
    if (cmd === 'accounts') return await accounts(rest, io);
    if (cmd === 'hash-password') return await hashPasswordCommand(io);
    if (cmd === 'serve' && rest.includes('--remote')) return await runRemoteMode(io.env ?? process.env, io);
    io.error(USAGE);
    return EXIT_USER_ERROR;
  } catch (e) {
    io.error((e as Error).message);
    return EXIT_USER_ERROR;
  }
}
