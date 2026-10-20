import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const web = (p: string) => new URL(`../../src/web/${p}`, import.meta.url);

async function json(p: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(web(p), 'utf8')) as Record<string, unknown>;
}

function flatten(obj: Record<string, unknown>, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string') out.set(key, v);
    else if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      for (const [kk, vv] of flatten(v as Record<string, unknown>, key)) out.set(kk, vv);
    } else throw new Error(`Unexpected value at ${key}`);
  }
  return out;
}

describe('wizard i18n', () => {
  it('en.json and tr.json have identical key sets', async () => {
    const en = flatten(await json('i18n/en.json'));
    const tr = flatten(await json('i18n/tr.json'));
    expect(en.size).toBeGreaterThan(50);
    expect([...tr.keys()].sort()).toEqual([...en.keys()].sort());
  });

  it('no value contains an em-dash and no value is empty', async () => {
    for (const lang of ['en', 'tr']) {
      for (const [k, v] of flatten(await json(`i18n/${lang}.json`))) {
        expect(v.includes('—'), `${lang}:${k}`).toBe(false);
        expect(v.trim().length, `${lang}:${k}`).toBeGreaterThan(0);
      }
    }
  });

  it('every t() key used in app.js exists in en.json', async () => {
    const en = flatten(await json('i18n/en.json'));
    const src = await readFile(web('app.js'), 'utf8');
    const used = [...src.matchAll(/\bt\('([a-zA-Z0-9_.]+)'/g)].map((m) => m[1]);
    expect(used.length).toBeGreaterThan(20);
    for (const k of used) expect(en.has(k), k).toBe(true);
  });
});

// Keys app.js builds with template strings; the literal-key test above cannot see them.
const GUIDE_DOS: Record<string, number> = { s1: 3, s2: 2, s3: 6, s4: 3, s5: 4, s6: 5 };
const DYNAMIC_KEYS = [
  ...['welcome', 'google', 'upload', 'accounts', 'ai', 'dashboard'].map((s) => `nav.${s}`),
  'lang.en',
  'lang.tr',
  ...[1, 2, 3, 4].map((n) => `welcome.plan${n}`),
  ...Object.entries(GUIDE_DOS).flatMap(([id, n]) => [
    `google.${id}.title`,
    `google.${id}.why`,
    ...Array.from({ length: n }, (_, i) => `google.${id}.do${i + 1}`),
  ]),
  ...['user_denied', 'timeout', 'admin_blocked', 'unknown'].map((r) => `accounts.failed.${r}`),
  ...['s1', 's2', 's3', 's4', 's5', 's6'].map((s) => `workspace.${s}`),
  ...['connected', 'needs_reauth', 'error', 'pending', 'failed'].map((s) => `status.${s}`),
  ...['colName', 'colEmail', 'colStatus', 'colActions'].map((k) => `dashboard.${k}`),
];

describe('wizard dynamic i18n keys', () => {
  it('every dynamically built key exists in both languages', async () => {
    const en = flatten(await json('i18n/en.json'));
    const tr = flatten(await json('i18n/tr.json'));
    for (const k of DYNAMIC_KEYS) {
      expect(en.has(k), `en:${k}`).toBe(true);
      expect(tr.has(k), `tr:${k}`).toBe(true);
    }
  });

  it('the guide step counts in app.js match the expected key list', async () => {
    const src = await readFile(web('app.js'), 'utf8');
    const found = Object.fromEntries(
      [...src.matchAll(/\{\s*id:\s*'(s\d)',[^}]*?\bdos:\s*(\d+)/g)].map((m) => [m[1], Number(m[2])]),
    );
    expect(found).toEqual(GUIDE_DOS);
  });
});

describe('wizard page safety', () => {
  it('app.js never assigns innerHTML or uses alert/confirm/prompt', async () => {
    const src = await readFile(web('app.js'), 'utf8');
    expect(src).not.toMatch(/\.(innerHTML|outerHTML)\s*\+?=/);
    expect(src).not.toMatch(/insertAdjacentHTML|document\.write/);
    expect(src).not.toMatch(/\b(alert|confirm|prompt)\s*\(/);
  });

  it('index.html has no inline scripts, inline handlers, or external resources', async () => {
    const html = await readFile(web('index.html'), 'utf8');
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    expect(html).not.toMatch(/\sstyle\s*=/i);
    expect(html).not.toMatch(/(src|href)\s*=\s*["']https?:/i);
    expect(html).toContain('type="module"');
  });

  it('no em-dash in any wizard file', async () => {
    for (const p of ['index.html', 'app.js', 'styles.css']) {
      expect((await readFile(web(p), 'utf8')).includes('—'), p).toBe(false);
    }
  });
});
