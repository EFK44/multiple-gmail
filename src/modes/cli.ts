import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { removeAccount } from '../core/accounts.js';
import { loadConfig, validateAlias } from '../core/config.js';
import { AccountError, AuthFlowError, startLoopbackAuth } from '../core/googleAuth.js';
import { loadClient } from '../core/secrets.js';
import { openUrl } from '../core/openUrl.js';
import { clearGmailCache } from '../gmail/client.js';
import { VERSION } from '../version.js';
import { runLocalMode } from './localHttp.js';

export type CliIo = {
  log: (s: string) => void;
  error: (s: string) => void;
  isTty: boolean;
  confirm: (prompt: string) => Promise<string>;
  openUrl: (url: string) => Promise<void>;
  // Starts the local setup server (no args, --minimized); injectable for tests.
  startLocal?: (opts: { openBrowser: boolean }) => Promise<number>;
};

export const EXIT_OK = 0;
export const EXIT_USER_ERROR = 1;
export const EXIT_NOT_AVAILABLE = 2;

const USAGE = `Usage: multiple-gmail [command]

  (no command)                        open the local setup app in the browser
  --minimized                         start the local server without opening the browser
  --stdio                             run as an MCP server over stdio
  accounts list                       list connected accounts
  accounts add --alias X [--email Y]  connect a Gmail account
  accounts reconnect X                re-authorize an existing account
  accounts remove X [--yes]           disconnect an account
  gen-key                             print a new MULTIPLE_GMAIL_MASTER_KEY
  serve --remote                      remote mode (not available yet)
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

// Placeholder for modes that later tasks implement; only the handler needs replacing then.
export function notAvailableYet(what: string, io: CliIo): number {
  io.error(`Not available yet: ${what}.`);
  return EXIT_NOT_AVAILABLE;
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

function aliasOrError(raw: string, io: CliIo): string | null {
  try {
    return validateAlias(raw);
  } catch (e) {
    io.error((e as Error).message);
    return null;
  }
}

async function connect(alias: string, email: string | undefined, reconnect: boolean, io: CliIo): Promise<number> {
  let started;
  try {
    started = await startLoopbackAuth(alias, { reconnect, loginHint: email });
  } catch (e) {
    const msg = (e as Error).message;
    const code = e instanceof AccountError ? e.code : undefined;
    if (code === 'no_client') {
      io.error('No OAuth client is configured yet. Finish the setup in the multiple-gmail app (the wizard) first.');
    } else if (code === 'alias_exists') {
      io.error(`Account "${alias}" already exists. Use: accounts reconnect ${alias}`);
    } else io.error(msg);
    return EXIT_USER_ERROR;
  }
  io.log('Open this URL to sign in with Google:');
  io.log(started.url);
  await io.openUrl(started.url).catch(() => {});
  try {
    const acct = await started.done;
    if (reconnect) clearGmailCache(acct.alias);
    io.log(`${reconnect ? 'Reconnected' : 'Connected'} ${acct.alias} (${acct.email})`);
    return EXIT_OK;
  } catch (e) {
    if (e instanceof AuthFlowError && e.code === 'admin_blocked') {
      const client = await loadClient().catch(() => null);
      io.error(ADMIN_STEPS(client?.clientId ?? '(unknown)'));
    } else io.error(`Could not connect ${alias}: ${(e as Error).message}`);
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
    for (const [alias, a] of entries) {
      io.log(`${alias}${cfg.defaultAccount === alias ? ' (default)' : ''}  ${a.email}`);
    }
    return EXIT_OK;
  }
  if (sub === 'add') {
    const aliasFlag = flags.get('--alias');
    if (typeof aliasFlag !== 'string') {
      io.error('Usage: accounts add --alias X [--email Y]');
      return EXIT_USER_ERROR;
    }
    const alias = aliasOrError(aliasFlag, io);
    if (!alias) return EXIT_USER_ERROR;
    if ((await loadConfig()).accounts[alias]) {
      io.error(`Account "${alias}" already exists. Use: accounts reconnect ${alias}`);
      return EXIT_USER_ERROR;
    }
    const email = flags.get('--email');
    return connect(alias, typeof email === 'string' ? email : undefined, false, io);
  }
  if (sub === 'reconnect') {
    if (!positional[0]) {
      io.error('Usage: accounts reconnect X');
      return EXIT_USER_ERROR;
    }
    const alias = aliasOrError(positional[0], io);
    if (!alias) return EXIT_USER_ERROR;
    if (!(await loadConfig()).accounts[alias]) {
      io.error(`Unknown account "${alias}".`);
      return EXIT_USER_ERROR;
    }
    return connect(alias, undefined, true, io);
  }
  if (sub === 'remove') {
    if (!positional[0]) {
      io.error('Usage: accounts remove X [--yes]');
      return EXIT_USER_ERROR;
    }
    const alias = aliasOrError(positional[0], io);
    if (!alias) return EXIT_USER_ERROR;
    if (!(await loadConfig()).accounts[alias]) {
      io.error(`Unknown account "${alias}".`);
      return EXIT_USER_ERROR;
    }
    if (flags.get('--yes') !== true && !io.isTty) {
      io.error('Use --yes to confirm removal in non-interactive mode.');
      return EXIT_USER_ERROR;
    }
    if (flags.get('--yes') !== true) {
      const answer = (await io.confirm('Type the alias to confirm: ')).trim().toLowerCase();
      if (answer !== alias) {
        io.error('Cancelled: the alias did not match.');
        return EXIT_USER_ERROR;
      }
    }
    try {
      const { revoked } = await removeAccount(alias);
      clearGmailCache(alias);
      io.log(`Removed ${alias}.`);
      io.log(
        revoked
          ? 'Google access was revoked.'
          : 'Google revoke did not succeed; revoke it manually at myaccount.google.com/permissions.',
      );
      return EXIT_OK;
    } catch (e) {
      const msg = (e as Error).message;
      io.error(e instanceof AccountError && e.code === 'unknown_alias' ? `Unknown account "${alias}".` : msg);
      return EXIT_USER_ERROR;
    }
  }
  io.error(USAGE);
  return EXIT_USER_ERROR;
}

export async function runCli(argv: string[], io: CliIo = defaultIo()): Promise<number> {
  const [cmd, ...rest] = argv;
  try {
    if (cmd === undefined || cmd === '--minimized') {
      return await (io.startLocal ?? runLocalMode)({ openBrowser: cmd === undefined });
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
    if (cmd === 'serve' && rest.includes('--remote')) return notAvailableYet('remote mode', io);
    io.error(USAGE);
    return EXIT_USER_ERROR;
  } catch (e) {
    io.error((e as Error).message);
    return EXIT_USER_ERROR;
  }
}
