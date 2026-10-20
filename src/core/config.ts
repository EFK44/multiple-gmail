import { readFile } from 'node:fs/promises';
import * as z from 'zod/v4';
import { writeFileAtomic } from './fsx.js';
import { configPath, dataDir } from './paths.js';
import { ensureSecureDir } from './secureDir.js';

const AccountEntrySchema = z.object({ email: z.string(), addedAt: z.string() });

const AppConfigSchema = z.object({
  port: z.number().int().min(1).max(65535),
  language: z.enum(['en', 'tr']),
  defaultAccount: z.string().nullable(),
  accounts: z.record(z.string(), AccountEntrySchema),
});

export type AccountEntry = z.infer<typeof AccountEntrySchema>;
export type AppConfig = z.infer<typeof AppConfigSchema>;

function defaults(): AppConfig {
  return { port: 47110, language: 'en', defaultAccount: null, accounts: {} };
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
  return parsed.data;
}

export async function saveConfig(c: AppConfig): Promise<void> {
  const valid = AppConfigSchema.parse(c);
  await ensureSecureDir(dataDir());
  await writeFileAtomic(configPath(), JSON.stringify(valid, null, 2) + '\n');
}

const ALIAS_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const RESERVED = new Set(['all']);

export function validateAlias(alias: string): string {
  const a = alias.trim().toLowerCase();
  if (!ALIAS_RE.test(a)) {
    throw new Error(
      `Invalid account alias "${alias}": use 1-32 characters a-z, 0-9, "-" or "_", starting with a letter or digit.`,
    );
  }
  if (RESERVED.has(a)) {
    throw new Error(`Account alias "${a}" is reserved; choose another name.`);
  }
  return a;
}
