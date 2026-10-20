import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import * as z from 'zod/v4';
import { writeFileAtomic } from './fsx.js';
import { configPath, dataDir } from './paths.js';
import { ensureSecureDir } from './secureDir.js';

// Accounts are keyed by an internal stable id (token file name, caches, API paths); `name` is the free-form display
// name. Configs written before names existed have no `name`: the key (the old alias) becomes the name.
const AccountEntrySchema = z.object({ name: z.string().optional(), email: z.string(), addedAt: z.string() });

const AppConfigSchema = z.object({
  port: z.number().int().min(1).max(65535),
  language: z.enum(['en', 'tr']),
  // Kept so older config files still parse; nothing sets or reads it.
  defaultAccount: z.string().nullable(),
  accounts: z.record(z.string(), AccountEntrySchema),
});

export type AccountEntry = { name: string; email: string; addedAt: string };
export type AppConfig = Omit<z.infer<typeof AppConfigSchema>, 'accounts'> & { accounts: Record<string, AccountEntry> };
// What saveConfig accepts: `name` may be left out (it defaults to the id).
export type AppConfigInput = z.input<typeof AppConfigSchema>;

function defaults(): AppConfig {
  return { port: 47110, language: 'en', defaultAccount: null, accounts: {} };
}

function withNames(c: z.infer<typeof AppConfigSchema>): { config: AppConfig; migrated: boolean } {
  let migrated = false;
  const accounts: Record<string, AccountEntry> = {};
  for (const [id, a] of Object.entries(c.accounts)) {
    if (a.name === undefined) migrated = true;
    accounts[id] = { name: a.name ?? id, email: a.email, addedAt: a.addedAt };
  }
  return { config: { ...c, accounts }, migrated };
}

export async function loadConfig(): Promise<AppConfig> {
  const file = configPath();
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return defaults();
    throw err;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Config file ${file} is not valid JSON: ${(err as Error).message}`);
  }
  const parsed = AppConfigSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`Config file ${file} is invalid: ${z.prettifyError(parsed.error)}`);
  }
  const { config, migrated } = withNames(parsed.data);
  // Old alias-keyed configs: the ids stay the old aliases, so tokens/<alias>.enc keeps working without renames.
  // Best effort: a failed save must not stop the app; the next load migrates again.
  if (migrated) {
    try {
      await withConfigLock(() => saveConfig(config));
    } catch (e) {
      console.error(`multiple-gmail: could not save the migrated config ${file}: ${(e as Error).message}`);
    }
  }
  return config;
}

// ---------- read-modify-write ----------

// One in-process queue for every load-modify-save of the config, so two concurrent writers (two sign-ins finishing,
// a rename during a sign-in) cannot drop each other's change. Reentrant: code already holding the lock runs directly.
let configQueue: Promise<unknown> = Promise.resolve();
const holding = new AsyncLocalStorage<boolean>();

export function withConfigLock<T>(fn: () => Promise<T>): Promise<T> {
  if (holding.getStore()) return fn();
  const run = configQueue.then(() => holding.run(true, fn));
  configQueue = run.catch(() => {});
  return run;
}

// Loads the config, lets `fn` change it in place, and saves it, all under the config lock.
export function updateConfig<T>(fn: (cfg: AppConfig) => T | Promise<T>): Promise<T> {
  return withConfigLock(async () => {
    const cfg = await loadConfig();
    const result = await fn(cfg);
    await saveConfig(cfg);
    return result;
  });
}

export async function saveConfig(c: AppConfigInput): Promise<void> {
  const { config } = withNames(AppConfigSchema.parse(c));
  await ensureSecureDir(dataDir());
  await writeFileAtomic(configPath(), JSON.stringify(config, null, 2) + '\n');
}

// ---------- ids ----------

// Ids are file names (tokens/<id>.enc). Legacy aliases match this pattern; new ids are 12 lowercase base32 chars
// (lowercase only: Windows file names are case-insensitive).
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

export function validateId(id: string): string {
  if (!ID_RE.test(id) || id === 'all') throw new Error(`Invalid account id "${id}".`);
  return id;
}

export function newAccountId(): string {
  const bytes = randomBytes(12);
  let out = '';
  for (const b of bytes) out += BASE32[b & 31];
  return out;
}

// ---------- display names ----------

export const MAX_NAME_LENGTH = 40;
const ALLOWED_NAME_RE = /^[\p{L}\p{M}\p{N}\p{P}\p{S} ]+$/u;

export function normalizeName(raw: string): string {
  return raw.normalize('NFC').replace(/\s+/gu, ' ').trim();
}

export class NameError extends Error {
  readonly code: 'invalid' | 'taken';
  constructor(code: 'invalid' | 'taken', message: string) {
    super(message);
    this.name = 'NameError';
    this.code = code;
  }
}

const folds = (s: string) => [s.toLocaleLowerCase('tr-TR'), s.toLowerCase()];

// Case-insensitive under both Turkish and plain lowercasing: a match under either counts.
export function sameName(a: string, b: string): boolean {
  const [at, ap] = folds(normalizeName(a));
  const [bt, bp] = folds(normalizeName(b));
  return at === bt || ap === bp;
}

// Returns the normalized name or throws a user-facing message. `selfId` is the account being renamed.
export function validateName(raw: string, cfg: AppConfig, selfId?: string): string {
  const name = normalizeName(raw);
  if (!name) throw new NameError('invalid', 'Enter a name for the account.');
  if ([...name].length > MAX_NAME_LENGTH) {
    throw new NameError('invalid', `The account name is too long: use at most ${MAX_NAME_LENGTH} characters.`);
  }
  if (!ALLOWED_NAME_RE.test(name)) {
    throw new NameError('invalid', 'The account name can use letters, digits, spaces and punctuation only.');
  }
  if (sameName(name, 'all')) throw new NameError('invalid', '"all" is reserved; choose another name.');
  for (const [id, a] of Object.entries(cfg.accounts)) {
    // Emails resolve accounts too, so no name may equal one (not even the account's own).
    if (a.email.toLowerCase() === name.toLowerCase()) {
      throw new NameError('taken', `"${name}" is the email of an account; choose another name.`);
    }
    if (id === selfId) continue;
    if (sameName(a.name, name)) throw new NameError('taken', `An account named "${a.name}" already exists.`);
    // Another account's id (an old alias) still resolves to it: taking it as a name would hijack old references.
    if (sameName(id, name)) throw new NameError('taken', `"${name}" is already used by the account "${a.name}".`);
  }
  return name;
}

// Resolves a name (case-insensitive), email (case-insensitive) or id to the account id. Names win over ids, so a
// legacy id never shadows another account's display name (and validateName keeps new names off other ids).
export function findAccount(cfg: AppConfig, ref: string): string | undefined {
  const wanted = normalizeName(ref);
  if (!wanted) return undefined;
  const entries = Object.entries(cfg.accounts);
  const byName = () => entries.find(([, a]) => sameName(a.name, wanted))?.[0];
  const byEmail = () => entries.find(([, a]) => a.email.toLowerCase() === wanted.toLowerCase())?.[0];
  const byId = () => entries.find(([id]) => id === wanted || id === wanted.toLowerCase())?.[0];
  // A reference with "@" is an email first.
  return wanted.includes('@') ? (byEmail() ?? byName() ?? byId()) : (byName() ?? byEmail() ?? byId());
}

// Own-property lookup by id (never the prototype).
export function getAccount(cfg: AppConfig, id: string): AccountEntry | undefined {
  return Object.hasOwn(cfg.accounts, id) ? cfg.accounts[id] : undefined;
}

export function accountNames(cfg: AppConfig): string[] {
  return Object.values(cfg.accounts).map((a) => a.name);
}
