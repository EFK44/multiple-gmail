// multiple-gmail setup wizard. Plain ES module, no dependencies.
// CSP is "default-src 'self'": every node is built with createElement/textContent, never HTML strings.

// Account names: same rules as the server (src/core/config.ts validateName).
const MAX_NAME = 40;
const NAME_RE = /^[\p{L}\p{M}\p{N}\p{P}\p{S} ]+$/u;
const POLL_MS = 1500;
const POLL_LIMIT_MS = 6 * 60 * 1000;
const MAX_FILE = 1024 * 1024;
const SCOPE = 'https://www.googleapis.com/auth/gmail.modify';
const KEY_PLACEHOLDER = '<YOUR_API_KEY>';
const GUIDE_STORE = 'multiple-gmail.guideDone';

const LINKS = {
  projectCreate: 'https://console.cloud.google.com/projectcreate',
  gmailApi: 'https://console.cloud.google.com/apis/library/gmail.googleapis.com',
  authOverview: 'https://console.cloud.google.com/auth/overview',
  scopes: 'https://console.cloud.google.com/auth/scopes',
  clients: 'https://console.cloud.google.com/auth/clients',
  audience: 'https://console.cloud.google.com/auth/audience',
  admin: 'https://admin.google.com/ac/owl/list?tab=configuredApps',
};

const SCREENS = ['welcome', 'google', 'upload', 'accounts', 'ai', 'dashboard'];
const STEPS = ['welcome', 'google', 'upload', 'accounts', 'ai'];

const GUIDE = [
  { id: 's1', link: LINKS.projectCreate, dos: 3 },
  { id: 's2', link: LINKS.gmailApi, dos: 2 },
  { id: 's3', link: LINKS.authOverview, dos: 6 },
  { id: 's4', link: LINKS.scopes, dos: 3, scope: true },
  { id: 's5', link: LINKS.clients, dos: 4, note: true },
  { id: 's6', link: LINKS.audience, dos: 5 },
];

const S = {
  lang: 'en',
  dict: {},
  fallback: {},
  state: null,
  screen: 'welcome',
  // account id (or "new:<name>" until the server returns the id) -> { status, reason?, message?, email?, name?, clientId?, authUrl? }
  flows: new Map(),
  polls: new Map(),
  apiKey: null,
  showKey: false,
  integrations: null,
  autostart: null,
  results: {},
  upload: null,
  guideDone: loadGuideDone(),
  openGuide: null,
  form: { name: '', email: '', touched: false },
  sessionLost: false,
  wsOpen: false,
  keyError: null,
  dashMsg: null,
};

// ---------- small helpers ----------

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'open') el[k] = Boolean(v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

function lookup(dict, key) {
  let v = dict;
  for (const part of key.split('.')) {
    if (v === null || typeof v !== 'object') return undefined;
    v = v[part];
  }
  return typeof v === 'string' ? v : undefined;
}

function t(key, vars) {
  let s = lookup(S.dict, key) ?? lookup(S.fallback, key) ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  return s;
}

function announce(text) {
  const el = document.getElementById('announce');
  el.textContent = '';
  // A fresh text node after a tick makes screen readers repeat identical messages.
  setTimeout(() => (el.textContent = text), 50);
}

function loadGuideDone() {
  try {
    const raw = localStorage.getItem(GUIDE_STORE);
    const arr = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

function saveGuideDone() {
  try {
    localStorage.setItem(GUIDE_STORE, JSON.stringify([...S.guideDone]));
  } catch {
    // Storage may be blocked; the checkboxes still work for this visit.
  }
}

function extLink(href, label, cls = 'btn btn-secondary') {
  return h(
    'a',
    { class: cls, href, target: '_blank', rel: 'noopener noreferrer' },
    label,
    h('span', { class: 'sr-only' }, ` (${t('common.newTab')})`),
    h('span', { class: 'ext', 'aria-hidden': 'true' }),
  );
}

// Stored messages keep their i18n key so they follow a language switch.
function msgText(m) {
  return m.key ? t(m.key, m.vars) : (m.raw ?? '');
}

function msg(kind, text, extra) {
  return h('div', { class: `msg msg-${kind}`, role: kind === 'error' ? 'alert' : 'status' }, h('p', {}, text), extra);
}

// ---------- API ----------

class SessionLost extends Error {}

async function api(method, path, body, rawBody = false) {
  const init = { method, credentials: 'same-origin', headers: {} };
  if (method !== 'GET') {
    init.headers['Content-Type'] = 'application/json';
    init.body = rawBody ? body : JSON.stringify(body ?? {});
  }
  let res;
  try {
    res = await fetch(`/api${path}`, init);
  } catch {
    throw new Error(t('errors.network'));
  }
  if (res.status === 401) {
    // Server mode answers with the admin sign-in page to go to.
    let lost = null;
    try {
      lost = await res.json();
    } catch {
      lost = null;
    }
    if (lost && typeof lost.login === 'string' && lost.login.startsWith('/') && !lost.login.startsWith('//')) {
      location.assign(lost.login);
      throw new SessionLost('session');
    }
    S.sessionLost = true;
    stopAllPolls();
    render();
    throw new SessionLost('session');
  }
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { ok: res.ok, status: res.status, json: json ?? {} };
}

function serverError(r) {
  const m = r?.json?.error;
  return m ? t('errors.server', { message: m }) : t('errors.network');
}

async function refreshState() {
  const r = await api('GET', '/state');
  if (r.ok) S.state = r.json;
  return S.state;
}

async function loadDict(lang) {
  const res = await fetch(`/i18n/${lang}.json`, { credentials: 'same-origin' });
  if (!res.ok) throw new Error('i18n');
  return res.json();
}

async function setLanguage(lang) {
  if (lang === S.lang) return;
  try {
    S.dict = await loadDict(lang);
    S.lang = lang;
  } catch {
    return;
  }
  forgetKey();
  render();
  api('POST', '/language', { language: lang }).catch(() => {});
}

// Clipboard works on 127.0.0.1 (a secure context); the textarea path covers older or locked-down browsers.
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = h('textarea', { class: 'sr-only', readonly: true, 'aria-hidden': 'true' });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

// A copy button plus a visible error line next to it (failures must not be announce-only).
function copyButton(getText, label = t('common.copy')) {
  const btn = h('button', { type: 'button', class: 'btn btn-small btn-quiet' }, label);
  const err = h('span', { class: 'copy-err', role: 'status' });
  let timer = 0;
  const show = (ok, text) => {
    clearTimeout(timer);
    btn.textContent = ok ? t('common.copied') : t('common.notCopied');
    btn.classList.toggle('is-done', ok);
    btn.classList.toggle('is-failed', !ok);
    err.textContent = ok ? '' : text;
    announce(ok ? t('common.copied') : text);
    timer = setTimeout(() => {
      btn.textContent = label;
      btn.classList.remove('is-done', 'is-failed');
    }, 3000);
  };
  btn.addEventListener('click', async () => {
    let text;
    try {
      text = await getText();
    } catch (e) {
      if (!(e instanceof SessionLost)) show(false, e.message);
      return;
    }
    const ok = await copyText(text);
    // The key is only kept in memory while it is shown on screen.
    if (!S.showKey) S.apiKey = null;
    show(ok, t('common.copyFailed'));
  });
  return h('span', { class: 'copy' }, btn, err);
}

// Called on every navigation and language switch so the real key never lingers on screen or in memory.
function forgetKey() {
  S.apiKey = null;
  S.showKey = false;
  S.keyError = null;
}

async function getApiKey() {
  if (S.apiKey) return S.apiKey;
  const r = await api('GET', '/apikey');
  if (!r.ok || typeof r.json.apiKey !== 'string') throw new Error(serverError(r));
  S.apiKey = r.json.apiKey;
  return S.apiKey;
}

// ---------- navigation ----------

function isRemote() {
  return S.state?.mode === 'remote';
}
function hasClient() {
  return Boolean(S.state?.hasClient);
}
function accounts() {
  return S.state?.accounts ?? [];
}

function reachable(screen) {
  if (screen === 'accounts') return hasClient();
  if (screen === 'ai' || screen === 'dashboard') return hasClient() && accounts().length > 0;
  return true;
}

function stepDone(screen) {
  if (screen === 'welcome') return hasClient();
  if (screen === 'google') return hasClient() || S.guideDone.size >= GUIDE.length;
  if (screen === 'upload') return hasClient();
  if (screen === 'accounts') return accounts().length > 0;
  return false;
}

function defaultScreen() {
  if (hasClient() && accounts().length > 0) return 'dashboard';
  if (hasClient()) return 'accounts';
  return 'welcome';
}

function screenFromHash() {
  const id = location.hash.slice(1);
  if (SCREENS.includes(id) && reachable(id)) return id;
  return null;
}

function go(screen) {
  S.dashMsg = null;
  forgetKey();
  if (location.hash === `#${screen}`) {
    S.screen = screen;
    render(true);
  } else {
    location.hash = screen;
  }
}

window.addEventListener('hashchange', () => {
  const id = location.hash.slice(1);
  // The skip link targets #main; it is not a screen.
  if (id === 'main') return;
  const next = screenFromHash();
  if (!next) return void history.replaceState(null, '', `#${S.screen}`);
  forgetKey();
  S.screen = next;
  render(true);
});

// ---------- rendering ----------

function render(focusMain = false) {
  const focusedId = document.activeElement?.id;
  document.documentElement.lang = S.lang;
  document.title = `${t(`nav.${S.screen}`)} | multiple-gmail`;
  document.getElementById('skip').textContent = t('app.skip');
  document.getElementById('tagline').textContent = t('app.tagline');
  renderLangSwitch(document.getElementById('lang-switch'));
  renderRail(document.getElementById('rail'));
  const main = document.getElementById('main');
  main.replaceChildren(S.sessionLost ? sessionScreen() : SCREEN_RENDER[S.screen]());
  if (focusMain) {
    const h1 = main.querySelector('h1');
    (h1 ?? main).focus();
    window.scrollTo(0, 0);
  } else if (focusedId) {
    document.getElementById(focusedId)?.focus();
  }
}

function renderLangSwitch(el) {
  el.replaceChildren(
    h('span', { class: 'sr-only', id: 'lang-label' }, t('lang.label')),
    h(
      'div',
      { class: 'seg', role: 'group', 'aria-labelledby': 'lang-label' },
      ['tr', 'en'].map((code) =>
        h(
          'button',
          {
            type: 'button',
            id: `lang-top-${code}`,
            lang: code,
            class: 'seg-btn',
            'aria-pressed': String(S.lang === code),
            onclick: () => setLanguage(code),
          },
          t(`lang.${code}`),
        ),
      ),
    ),
  );
}

function renderRail(el) {
  const total = STEPS.length;
  const items = STEPS.map((id, i) => {
    const current = S.screen === id;
    const ok = reachable(id);
    const done = stepDone(id);
    const label = [
      h('span', { class: 'rail-num', 'aria-hidden': 'true' }, done && !current ? '' : String(i + 1)),
      h('span', { class: 'rail-text' }, t(`nav.${id}`)),
      done ? h('span', { class: 'sr-only' }, ` (${t('nav.done')})`) : null,
    ];
    const cls = `rail-item${current ? ' is-current' : ''}${done ? ' is-done' : ''}${ok ? '' : ' is-locked'}`;
    return h(
      'li',
      { class: cls },
      ok
        ? h('a', { href: `#${id}`, 'aria-current': current ? 'step' : null }, label)
        : h('span', { class: 'rail-locked', title: t('nav.locked') }, label, h('span', { class: 'sr-only' }, ` (${t('nav.locked')})`)),
    );
  });
  const dashOk = reachable('dashboard');
  const idx = STEPS.indexOf(S.screen);
  el.setAttribute('aria-label', t('nav.label'));
  const parts = [
    idx >= 0 ? h('p', { class: 'rail-progress' }, t('nav.stepOf', { n: idx + 1, total })) : null,
    h('ol', { class: 'rail-list' }, items),
    dashOk
      ? h(
          'a',
          { class: `rail-dash${S.screen === 'dashboard' ? ' is-current' : ''}`, href: '#dashboard', 'aria-current': S.screen === 'dashboard' ? 'page' : null },
          t('nav.dashboard'),
        )
      : null,
  ];
  el.replaceChildren(...parts.filter(Boolean));
}

function header(titleKey, leadKey) {
  return [h('h1', { tabindex: '-1' }, t(titleKey)), leadKey ? h('p', { class: 'lead' }, t(leadKey)) : null];
}

function sessionScreen() {
  return h('section', { class: 'screen' }, h('h1', { tabindex: '-1' }, t('app.name')), msg('error', t('errors.session')));
}

// ---------- screen 1: welcome ----------

function welcomeScreen() {
  return h(
    'section',
    { class: 'screen screen-welcome' },
    header('welcome.title', 'welcome.lead'),
    h(
      'div',
      { class: 'lang-pick' },
      h('h2', { id: 'lang-pick-label', class: 'h3' }, t('welcome.langPrompt')),
      h(
        'div',
        { class: 'lang-cards', role: 'group', 'aria-labelledby': 'lang-pick-label' },
        ['tr', 'en'].map((code) =>
          h(
            'button',
            {
              type: 'button',
              id: `lang-card-${code}`,
              lang: code,
              class: 'lang-card',
              'aria-pressed': String(S.lang === code),
              onclick: () => setLanguage(code),
            },
            t(`lang.${code}`),
          ),
        ),
      ),
    ),
    h('h2', {}, t('welcome.planTitle')),
    h('ol', { class: 'plan' }, ['plan1', 'plan2', 'plan3', 'plan4'].map((k) => h('li', {}, t(`welcome.${k}`)))),
    h('p', { class: 'note note-quiet' }, t('welcome.privacy')),
    h('p', { class: 'note' }, t('welcome.keepOpen')),
    h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn btn-primary', id: 'start', onclick: () => go('google') }, t('welcome.start'))),
  );
}

// ---------- screen 2: Google Cloud guide ----------

function googleScreen() {
  const total = GUIDE.length;
  const doneCount = GUIDE.filter((g) => S.guideDone.has(g.id)).length;
  const firstOpen = S.openGuide ?? GUIDE.find((g) => !S.guideDone.has(g.id))?.id ?? null;
  const progress = h('p', { class: 'progress', id: 'guide-progress' }, t('google.progress', { done: doneCount, total }));
  const bar = h('div', { class: 'bar', 'aria-hidden': 'true' }, h('span'));
  bar.firstChild.style.width = `${(doneCount / total) * 100}%`;

  const steps = GUIDE.map((g, i) => {
    const done = S.guideDone.has(g.id);
    const cbId = `guide-${g.id}-done`;
    const details = h(
      'details',
      { class: `guide${done ? ' is-done' : ''}`, open: firstOpen === g.id },
      h(
        'summary',
        { id: `guide-${g.id}-summary` },
        h('span', { class: 'guide-num', 'aria-hidden': 'true' }, done ? '' : String(i + 1)),
        h('span', { class: 'guide-title' }, t(`google.${g.id}.title`)),
        done ? h('span', { class: 'sr-only' }, ` (${t('nav.done')})`) : null,
      ),
      h(
        'div',
        { class: 'guide-body' },
        h('p', { class: 'why' }, h('strong', {}, t('google.whyLabel')), ' ', t(`google.${g.id}.why`)),
        h('ol', { class: 'dos' }, Array.from({ length: g.dos }, (_, n) => h('li', {}, t(`google.${g.id}.do${n + 1}`)))),
        g.scope
          ? h(
              'div',
              { class: 'codebox' },
              h('span', { class: 'codebox-label' }, t('google.s4.scopeLabel')),
              h('code', {}, SCOPE),
              copyButton(() => SCOPE),
            )
          : null,
        g.note ? h('p', { class: 'note note-warn' }, t('google.s5.note')) : null,
        g.note && isRemote() ? remoteRedirectNote('remote.guideNote') : null,
        h(
          'div',
          { class: 'guide-actions' },
          extLink(g.link, t('google.open')),
          h(
            'label',
            { class: 'check', for: cbId },
            h('input', {
              type: 'checkbox',
              id: cbId,
              checked: done,
              onchange: (e) => {
                if (e.target.checked) S.guideDone.add(g.id);
                else S.guideDone.delete(g.id);
                saveGuideDone();
                const next = GUIDE.find((x) => !S.guideDone.has(x.id));
                S.openGuide = e.target.checked ? (next?.id ?? null) : g.id;
                render();
                const n = GUIDE.filter((x) => S.guideDone.has(x.id)).length;
                announce(t('google.progress', { done: n, total }));
                if (e.target.checked && next) document.getElementById(`guide-${next.id}-summary`)?.focus();
              },
            }),
            h('span', {}, t('google.markDone')),
          ),
        ),
      ),
    );
    details.addEventListener('toggle', () => {
      if (details.open) S.openGuide = g.id;
    });
    return details;
  });

  return h(
    'section',
    { class: 'screen' },
    header('google.title', 'google.lead'),
    h('p', { class: 'note note-quiet' }, t('common.mayDiffer')),
    h('div', { class: 'progress-wrap' }, progress, bar),
    h('div', { class: 'guide-list' }, steps),
    h(
      'section',
      { class: 'ahead', 'aria-labelledby': 'ahead-title' },
      h('h2', { id: 'ahead-title' }, t('google.aheadTitle')),
      h('h3', {}, t('google.ahead1Title')),
      h('p', {}, t('google.ahead1')),
      h('h3', {}, t('google.ahead2Title')),
      h('p', {}, t('google.ahead2')),
    ),
    h(
      'div',
      { class: 'actions' },
      h('button', { type: 'button', class: 'btn btn-quiet', onclick: () => go('welcome') }, t('common.back')),
      h('button', { type: 'button', class: 'btn btn-primary', id: 'guide-continue', onclick: () => go('upload') }, t('google.continue')),
    ),
  );
}

// ---------- screen 3: upload credentials.json ----------

const UPLOAD_ERRORS = [
  [/not valid JSON/i, 'upload.err.notJson'],
  [/service account/i, 'upload.err.serviceAccount'],
  [/not a JSON object|neither "installed" nor "web"/i, 'upload.err.notClient'],
  [/missing client_id/i, 'upload.err.missingId'],
  [/missing client_secret/i, 'upload.err.missingSecret'],
];

async function uploadFile(file) {
  if (!file) return;
  if (file.size > MAX_FILE) {
    S.upload = { kind: 'error', key: 'upload.err.tooBig' };
    return render();
  }
  S.upload = { kind: 'info', key: 'upload.checking' };
  render();
  try {
    const text = await file.text();
    const r = await api('POST', '/client', text, true);
    if (r.ok) {
      await refreshState();
      S.upload = { kind: r.json.kind === 'web' ? 'warn' : 'ok', key: r.json.kind === 'web' ? 'upload.webWarning' : 'upload.ok' };
    } else {
      const m = String(r.json.error ?? '');
      const key = UPLOAD_ERRORS.find(([re]) => re.test(m))?.[1];
      S.upload = key ? { kind: 'error', key } : { kind: 'error', raw: serverError(r) };
    }
  } catch (e) {
    if (e instanceof SessionLost) return;
    S.upload = { kind: 'error', raw: e.message };
  }
  render();
  announce(msgText(S.upload));
}

function uploadScreen() {
  const input = h('input', {
    type: 'file',
    id: 'client-file',
    class: 'file-input',
    accept: '.json,application/json',
    onchange: (e) => uploadFile(e.target.files?.[0]),
  });
  const zone = h(
    'div',
    { class: 'dropzone', id: 'dropzone' },
    h('span', { class: 'drop-icon', 'aria-hidden': 'true' }),
    h('p', { class: 'drop-title' }, t('upload.drop')),
    h('p', { class: 'drop-or' }, t('upload.or')),
    input,
    h('label', { for: 'client-file', class: 'btn btn-secondary' }, t('upload.choose'), h('span', { class: 'sr-only' }, `: ${t('upload.inputLabel')}`)),
  );
  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    zone.classList.add('is-over');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('is-over'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('is-over');
    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;
    if (files.length > 1) {
      S.upload = { kind: 'error', key: 'upload.err.oneFile' };
      render();
      return announce(msgText(S.upload));
    }
    uploadFile(files[0]);
  });

  const st = S.state;
  const status = S.upload
    ? msg(S.upload.kind, msgText(S.upload))
    : st?.hasClient
      ? st.clientKind === 'web' && !isRemote()
        ? msg('warn', t('upload.webWarning'))
        : msg('quiet', t('upload.already'))
      : null;
  return h(
    'section',
    { class: 'screen' },
    header('upload.title', 'upload.lead'),
    isRemote() ? remoteRedirectNote('remote.uploadNote') : null,
    zone,
    h('div', { class: 'status-slot' }, status),
    h('p', { class: 'note note-warn' }, t('upload.secret')),
    h(
      'div',
      { class: 'actions' },
      h('button', { type: 'button', class: 'btn btn-quiet', onclick: () => go('google') }, t('common.back')),
      st?.hasClient ? h('button', { type: 'button', class: 'btn btn-primary', id: 'upload-next', onclick: () => go('accounts') }, t('upload.next')) : null,
    ),
  );
}

// ---------- screen 4: accounts ----------

function normalizeName(raw) {
  return raw.normalize('NFC').replace(/\s+/gu, ' ').trim();
}

// Case-insensitive under both Turkish and plain lowercasing, like the server.
function sameName(a, b) {
  const x = normalizeName(a);
  const y = normalizeName(b);
  return x.toLocaleLowerCase('tr-TR') === y.toLocaleLowerCase('tr-TR') || x.toLowerCase() === y.toLowerCase();
}

// selfId: the account being renamed (its own name is not "taken").
function nameProblem(raw, selfId) {
  const a = normalizeName(raw);
  if (!a) return 'accounts.nameErr.empty';
  if ([...a].length > MAX_NAME) return 'accounts.nameErr.tooLong';
  if (!NAME_RE.test(a)) return 'accounts.nameErr.invalid';
  if (sameName(a, 'all')) return 'accounts.nameErr.reserved';
  if (accounts().some((x) => x.email.toLowerCase() === a.toLowerCase())) return 'accounts.nameErr.email';
  if (accounts().some((x) => x.id !== selfId && (sameName(x.name, a) || sameName(x.id, a)))) return 'accounts.nameErr.taken';
  return null;
}

function accountName(key) {
  return S.flows.get(key)?.name ?? accounts().find((a) => a.id === key)?.name ?? key;
}

function stopPoll(id) {
  const p = S.polls.get(id);
  if (p) clearTimeout(p.timer);
  S.polls.delete(id);
}

function stopAllPolls() {
  for (const id of [...S.polls.keys()]) stopPoll(id);
}

function pollStatus(id) {
  stopPoll(id);
  const started = Date.now();
  const entry = { timer: 0 };
  S.polls.set(id, entry);
  const tick = async () => {
    if (S.polls.get(id) !== entry) return;
    if (Date.now() - started > POLL_LIMIT_MS) {
      S.polls.delete(id);
      S.flows.set(id, { status: 'gaveup', name: S.flows.get(id)?.name });
      render();
      return announce(t('accounts.gaveUp'));
    }
    let r;
    try {
      r = await api('GET', `/accounts/${encodeURIComponent(id)}/status`);
    } catch (e) {
      if (e instanceof SessionLost) return;
      r = null;
    }
    if (S.polls.get(id) !== entry) return;
    const status = r?.ok ? r.json.status : null;
    if (!status || status === 'pending') {
      entry.timer = setTimeout(tick, POLL_MS);
      return;
    }
    S.polls.delete(id);
    const prev = S.flows.get(id) ?? {};
    S.flows.set(id, { ...r.json, name: r.json.name ?? prev.name, authUrl: prev.authUrl });
    if (status === 'connected') {
      await refreshState().catch(() => {});
      if (S.screen === 'accounts') S.form = { name: '', email: '', touched: false };
      announce(t('accounts.connected', { name: r.json.name ?? accountName(id), email: r.json.email ?? '' }));
    } else if (status === 'failed') {
      announce(failText(r.json.reason));
    }
    render();
  };
  entry.timer = setTimeout(tick, POLL_MS);
}

function failText(reason) {
  const known = ['user_denied', 'timeout', 'admin_blocked', 'unknown'];
  return t(`accounts.failed.${known.includes(reason) ? reason : 'unknown'}`);
}

// New account: target is the display name. Reconnect: target is the account id.
async function startConnect(target, email, reconnect) {
  const name = reconnect ? accountName(target) : normalizeName(target);
  // Until the server answers with the id, a new account's flow lives under a temporary key.
  const temp = reconnect ? target : `new:${name}`;
  S.flows.set(temp, { status: 'starting', name });
  render();
  let r;
  try {
    r = reconnect
      ? await api('POST', `/accounts/${encodeURIComponent(target)}/reconnect`, {})
      : await api('POST', '/accounts', email ? { name, email } : { name });
  } catch (e) {
    if (e instanceof SessionLost) return;
    S.flows.set(temp, { status: 'error-start', message: e.message, name });
    render();
    return announce(e.message);
  }
  if (!r.ok || typeof r.json.authUrl !== 'string' || typeof r.json.id !== 'string') {
    const text = serverError(r);
    S.flows.set(temp, { status: 'error-start', message: text, name });
    render();
    return announce(text);
  }
  const id = r.json.id;
  if (temp !== id) S.flows.delete(temp);
  window.open(r.json.authUrl, '_blank', 'noopener');
  S.flows.set(id, { status: 'pending', authUrl: r.json.authUrl, name });
  render();
  announce(t('accounts.waiting'));
  pollStatus(id);
}

function workspaceSteps(clientId) {
  return h(
    'div',
    { class: 'ws-steps' },
    h('ol', { class: 'dos' }, ['s1', 's2', 's3', 's4', 's5', 's6'].map((k) => h('li', {}, t(`workspace.${k}`)))),
    clientId
      ? h(
          'div',
          { class: 'codebox' },
          h('span', { class: 'codebox-label' }, t('workspace.clientIdLabel')),
          h('code', {}, clientId),
          copyButton(() => clientId),
        )
      : h('p', { class: 'note note-quiet' }, t('workspace.noClient')),
    h('div', { class: 'guide-actions' }, extLink(LINKS.admin, t('workspace.openAdmin'))),
    h('p', { class: 'note note-quiet' }, t('common.mayDifferShort')),
  );
}

// The status block for one account's sign-in, shared by the accounts screen and the dashboard.
function flowStatus(key) {
  const f = S.flows.get(key);
  if (!f) return null;
  if (f.status === 'starting') return msg('info', t('common.working'));
  if (f.status === 'pending') {
    return msg(
      'info',
      t('accounts.waiting'),
      f.authUrl
        ? h('p', { class: 'small' }, t('accounts.popupBlocked'), ' ', extLink(f.authUrl, t('accounts.openSignIn'), 'link'))
        : null,
    );
  }
  if (f.status === 'connected') return msg('ok', t('accounts.connected', { name: f.name ?? accountName(key), email: f.email ?? '' }));
  if (f.status === 'gaveup') return msg('error', t('accounts.gaveUp'));
  if (f.status === 'error-start') return msg('error', f.message);
  if (f.status === 'failed') {
    const admin = f.reason === 'admin_blocked';
    return msg('error', failText(f.reason), admin ? workspaceSteps(f.clientId ?? S.state?.clientId ?? null) : null);
  }
  return msg('error', t('accounts.failed.unknown'));
}

function badge(status) {
  const known = ['connected', 'needs_reauth', 'error', 'pending', 'failed'];
  const s = status === 'ok' ? 'connected' : known.includes(status) ? status : 'error';
  return h('span', { class: `badge badge-${s}` }, h('span', { class: 'dot', 'aria-hidden': 'true' }), t(`status.${s}`));
}

function accountsScreen() {
  const f = S.form;
  const problem = f.touched ? nameProblem(f.name) : null;
  const busy = [...S.flows.values()].some((x) => x.status === 'starting');

  const nameInput = h('input', {
    id: 'acct-name',
    name: 'acct-name',
    type: 'text',
    autocomplete: 'off',
    spellcheck: 'false',
    maxlength: '80',
    required: true,
    value: f.name,
    'aria-describedby': 'name-hint name-err',
    'aria-invalid': problem ? 'true' : 'false',
  });
  const nameErr = h('p', { id: 'name-err', class: 'field-err' }, problem ? t(problem) : '');
  nameInput.addEventListener('input', () => {
    f.name = nameInput.value;
    f.touched = true;
    const p = nameProblem(f.name);
    nameErr.textContent = p ? t(p) : '';
    nameInput.setAttribute('aria-invalid', p ? 'true' : 'false');
  });
  const emailInput = h('input', {
    id: 'email',
    name: 'email',
    type: 'email',
    autocomplete: 'email',
    maxlength: '320',
    value: f.email,
    'aria-describedby': 'email-hint',
    oninput: (e) => (f.email = e.target.value),
  });

  const form = h(
    'form',
    { class: 'form', novalidate: true, 'aria-labelledby': 'form-title' },
    h('h2', { id: 'form-title' }, t('accounts.formTitle')),
    h(
      'div',
      { class: 'field' },
      h('label', { for: 'acct-name' }, t('accounts.nameLabel')),
      h('p', { id: 'name-hint', class: 'field-hint' }, t('accounts.nameHint')),
      nameInput,
      nameErr,
    ),
    h(
      'div',
      { class: 'field' },
      h('label', { for: 'email' }, t('accounts.emailLabel')),
      h('p', { id: 'email-hint', class: 'field-hint' }, t('accounts.emailHint')),
      emailInput,
    ),
    h('div', { class: 'actions actions-left' }, h('button', { type: 'submit', class: 'btn btn-primary btn-google', id: 'connect', disabled: busy }, t('accounts.connect'))),
  );
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    f.touched = true;
    const p = nameProblem(f.name);
    if (p) {
      render();
      document.getElementById('acct-name')?.focus();
      return announce(t(p));
    }
    f.name = normalizeName(f.name);
    startConnect(f.name, f.email.trim() || undefined, false);
  });

  // Flows for accounts that are not yet saved (new connections in progress or failed).
  const known = new Set(accounts().map((a) => a.id));
  const loose = [...S.flows.keys()].filter((a) => !known.has(a) || S.flows.get(a).status !== 'connected');

  const list = accounts().length
    ? h(
        'ul',
        { class: 'acct-list' },
        accounts().map((a) =>
          h('li', {}, h('span', { class: 'acct-alias' }, a.name), h('span', { class: 'acct-email' }, a.email), badge(a.status)),
        ),
      )
    : h('p', { class: 'empty' }, t('accounts.empty'));

  return h(
    'section',
    { class: 'screen' },
    header('accounts.title', 'accounts.lead'),
    h(
      'details',
      { class: 'ws', open: S.wsOpen, ontoggle: (e) => (S.wsOpen = e.currentTarget.open) },
      h('summary', {}, t('workspace.title')),
      h('div', { class: 'ws-body' }, h('p', {}, t('workspace.lead')), workspaceSteps(S.state?.clientId ?? null)),
    ),
    form,
    h('div', { class: 'status-slot' }, loose.map((a) => flowStatus(a))),
    h('h2', {}, t('accounts.listTitle')),
    list,
    accounts().length ? h('p', { class: 'note note-quiet' }, t('accounts.more')) : null,
    h(
      'div',
      { class: 'actions' },
      h('button', { type: 'button', class: 'btn btn-quiet', onclick: () => go('upload') }, t('common.back')),
      accounts().length ? h('button', { type: 'button', class: 'btn btn-primary', id: 'accounts-next', onclick: () => go('ai') }, t('accounts.next')) : null,
    ),
  );
}

// ---------- screen 5: connect your AI ----------

async function loadIntegrations() {
  try {
    const r = await api('GET', '/integrations');
    S.integrations = r.ok ? r.json : { error: serverError(r) };
  } catch (e) {
    if (e instanceof SessionLost) return;
    S.integrations = { error: e.message };
  }
  if (S.screen === 'ai') render();
}

async function runIntegration(id, path) {
  S.results[id] = { busy: true };
  render();
  try {
    const r = await api('POST', path, {});
    S.results[id] = r.ok ? { data: r.json } : { error: serverError(r) };
  } catch (e) {
    if (e instanceof SessionLost) return;
    S.results[id] = { error: e.message };
  }
  render();
  const res = S.results[id];
  if (res.error) return announce(res.error);
  const doneKey = { claudeDesktop: 'ai.claudeDesktop.done', gemini: 'ai.gemini.done' }[id];
  if (id === 'claudeDesktop' && res.data?.notice) {
    announce(`${t('ai.claudeDesktop.done')} ${t('ai.claudeDesktop.noticeTitle')}`);
  } else if (doneKey) announce(t(doneKey));
  else if (id === 'claudeCode') announce(res.data?.ok ? t('ai.claudeCode.runOk') : t('ai.claudeCode.runFail', { code: res.data?.code }));
}

function fillKey(text) {
  return S.showKey && S.apiKey ? text.split(KEY_PLACEHOLDER).join(S.apiKey) : text;
}

function card(id, titleKey, ...body) {
  return h('section', { class: 'ai-row', id: `ai-${id}`, 'aria-labelledby': `ai-${id}-title` }, h('h2', { id: `ai-${id}-title`, class: 'h3' }, t(titleKey)), ...body);
}

// routes.ts returns written as [{ path, backup, created }] (backup is null when the file did not exist yet).
function writtenList(written) {
  if (!Array.isArray(written) || written.length === 0) return null;
  return h(
    'ul',
    { class: 'paths' },
    written.map((w) => {
      const path = typeof w === 'string' ? w : w?.path;
      const backup = typeof w === 'object' && w ? w.backup : null;
      return h(
        'li',
        {},
        t('ai.changed', { path: path ?? '' }),
        backup ? h('br') : null,
        backup ? t('ai.backup', { path: backup }) : null,
      );
    }),
  );
}

function claudeDesktopCard(info) {
  const res = S.results.claudeDesktop;
  if (!info?.supported) return card('claude-desktop', 'ai.claudeDesktop.title', h('p', {}, t('ai.claudeDesktop.desc')), msg('quiet', t('ai.unsupported')));
  let out = null;
  if (res?.busy) out = msg('info', t('common.working'));
  else if (res?.error) out = msg('error', res.error);
  else if (res?.data?.supported === false) out = msg('quiet', t('ai.unsupported'));
  else if (res?.data) {
    out = h(
      'div',
      {},
      msg('ok', t('ai.claudeDesktop.done'), writtenList(res.data.written)),
      res.data.notice
        ? h(
            'div',
            { class: 'notice', role: 'alert' },
            h('p', { class: 'notice-title' }, t('ai.claudeDesktop.noticeTitle')),
            h('p', {}, S.lang === 'en' ? res.data.notice : t('ai.claudeDesktop.notice')),
          )
        : null,
    );
  } else if (info.configured) out = msg('quiet', t('ai.already'));
  return card(
    'claude-desktop',
    'ai.claudeDesktop.title',
    h('p', {}, t('ai.claudeDesktop.desc')),
    h(
      'div',
      { class: 'row-actions' },
      h('button', { type: 'button', class: 'btn btn-primary', id: 'add-claude-desktop', disabled: res?.busy, onclick: () => runIntegration('claudeDesktop', '/integrations/claude-desktop') }, t('ai.claudeDesktop.button')),
    ),
    out,
  );
}

function claudeCodeCard(info) {
  const res = S.results.claudeCode;
  const command = info?.command ?? '';
  let out = null;
  if (res?.busy) out = msg('info', t('common.working'));
  else if (res?.error) out = msg('error', res.error);
  else if (res?.data?.supported === false) out = msg('quiet', t('ai.unsupported'));
  else if (res?.data) {
    out = res.data.ok
      ? msg('ok', t('ai.claudeCode.runOk'))
      : msg('error', t('ai.claudeCode.runFail', { code: res.data.code }), res.data.stderr ? h('pre', { class: 'out' }, res.data.stderr) : null);
  }
  return card(
    'claude-code',
    'ai.claudeCode.title',
    h('p', {}, t('ai.claudeCode.desc')),
    h('div', { class: 'codebox codebox-block' }, h('span', { class: 'codebox-label' }, t('ai.claudeCode.commandLabel')), h('pre', {}, h('code', {}, command)), copyButton(() => command)),
    info?.available
      ? h('div', { class: 'row-actions' }, h('button', { type: 'button', class: 'btn btn-secondary', id: 'run-claude-code', disabled: res?.busy, onclick: () => runIntegration('claudeCode', '/integrations/claude-code') }, t('ai.claudeCode.run')))
      : h('p', { class: 'note note-quiet' }, t('ai.claudeCode.notFound')),
    out,
  );
}

function geminiCard(info) {
  const res = S.results.gemini;
  let out = null;
  if (res?.busy) out = msg('info', t('common.working'));
  else if (res?.error) out = msg('error', res.error);
  else if (res?.data) out = msg('ok', t('ai.gemini.done'), writtenList(res.data.written));
  else if (info?.configured) out = msg('quiet', t('ai.already'));
  return card(
    'gemini',
    'ai.gemini.title',
    h('p', {}, t('ai.gemini.desc')),
    h('div', { class: 'row-actions' }, h('button', { type: 'button', class: 'btn btn-primary', id: 'add-gemini', disabled: res?.busy, onclick: () => runIntegration('gemini', '/integrations/gemini-cli') }, t('ai.gemini.button'))),
    out,
  );
}

function httpCard(info) {
  if (!info) return null;
  const masked = S.state?.apiKeyMasked ?? '';
  const toggle = h('button', {
    type: 'button',
    class: 'btn btn-small btn-secondary',
    id: 'toggle-key',
    'aria-pressed': String(S.showKey),
    onclick: async () => {
      S.keyError = null;
      if (S.showKey) {
        forgetKey();
        return render();
      }
      try {
        await getApiKey();
        S.showKey = true;
        render();
      } catch (e) {
        if (e instanceof SessionLost) return;
        S.keyError = e.message;
        render();
        announce(e.message);
      }
    },
  }, S.showKey ? t('ai.http.hideKey') : t('ai.http.showKey'));
  const snippet = (key, labelKey) =>
    h(
      'div',
      { class: 'codebox codebox-block' },
      h('span', { class: 'codebox-label' }, t(labelKey)),
      h('pre', {}, h('code', {}, fillKey(info.snippets?.[key] ?? ''))),
      copyButton(async () => (info.snippets?.[key] ?? '').split(KEY_PLACEHOLDER).join(await getApiKey())),
    );
  return card(
    'http',
    'ai.http.title',
    h('p', {}, t('ai.http.desc')),
    h(
      'dl',
      { class: 'kv' },
      h('dt', {}, t('ai.http.urlLabel')),
      h('dd', {}, h('code', {}, info.url), copyButton(() => info.url)),
      h('dt', {}, t('ai.http.keyLabel')),
      h('dd', {}, h('code', {}, S.showKey && S.apiKey ? S.apiKey : masked), copyButton(() => getApiKey())),
    ),
    h('div', { class: 'row-actions' }, toggle),
    S.keyError ? msg('error', S.keyError) : null,
    h('p', { class: 'note note-quiet' }, S.showKey ? t('ai.http.keyWarn') : t('ai.http.keyHidden')),
    snippet('cursor', 'ai.http.cursor'),
    snippet('vscode', 'ai.http.vscode'),
    snippet('generic', 'ai.http.generic'),
    h('p', { class: 'note note-quiet' }, t('ai.http.tip')),
  );
}

// Server mode: the redirect URI Google must know, with a copy button.
function remoteRedirectNote(key) {
  const uri = S.state?.googleRedirectUri ?? '';
  return h(
    'div',
    { class: 'note note-warn' },
    h('p', {}, t(key)),
    h('div', { class: 'codebox' }, h('code', {}, uri), copyButton(() => uri)),
  );
}

// Server mode: web AI apps add this server as a custom connector; local integrations do not apply.
function remoteAiScreen() {
  const url = S.state?.mcpUrl ?? '';
  return h(
    'section',
    { class: 'screen' },
    header('ai.title', 'remote.aiLead'),
    h(
      'div',
      { class: 'ai-list' },
      card(
        'remote',
        'remote.aiTitle',
        h('p', {}, t('remote.aiDesc')),
        h('dl', { class: 'kv' }, h('dt', {}, t('remote.mcpUrlLabel')), h('dd', {}, h('code', {}, url), copyButton(() => url))),
        h('p', {}, t('remote.claude')),
        h('p', {}, t('remote.chatgpt')),
        h('p', { class: 'note note-quiet' }, t('remote.password')),
      ),
    ),
    h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn btn-primary', onclick: () => go('dashboard') }, t('ai.next'))),
  );
}

async function signOut() {
  try {
    await fetch('/admin/logout', { method: 'POST', credentials: 'same-origin' });
  } catch {
    // The sign-in page is shown either way.
  }
  location.assign('/admin/login');
}

function aiScreen() {
  if (isRemote()) return remoteAiScreen();
  const info = S.integrations;
  if (!info) loadIntegrations();
  const body = !info
    ? h('p', { class: 'loading' }, t('app.loading'))
    : info.error
      ? msg('error', info.error)
      : h(
          'div',
          { class: 'ai-list' },
          claudeDesktopCard(info.claudeDesktop),
          claudeCodeCard(info.claudeCode),
          geminiCard(info.geminiCli),
          httpCard(info.http),
          card('web', 'ai.web.title', h('p', {}, t('ai.web.desc'))),
        );
  return h(
    'section',
    { class: 'screen' },
    header('ai.title', 'ai.lead'),
    body,
    h(
      'div',
      { class: 'actions' },
      h('button', { type: 'button', class: 'btn btn-quiet', onclick: () => go('accounts') }, t('common.back')),
      h('button', { type: 'button', class: 'btn btn-primary', id: 'ai-next', onclick: () => go('dashboard') }, t('ai.next')),
    ),
  );
}

// ---------- dialog ----------

// requireText: the user must type this (compared like account names) to enable the button.
// edit: { label, value, problem(value) -> i18n key | null } shows an editable field; onConfirm gets its value.
function openDialog({ title, body, confirmLabel, danger, requireText, edit, onConfirm, trigger }) {
  const dlg = document.getElementById('dialog');
  const confirmBtn = h('button', { type: 'button', class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`, id: 'dialog-confirm', disabled: Boolean(requireText || edit) }, confirmLabel);
  const cancelBtn = h('button', { type: 'button', class: 'btn btn-quiet', id: 'dialog-cancel', onclick: () => dlg.close() }, t('common.cancel'));
  let input = null;
  let field = null;
  if (requireText) {
    input = h('input', { type: 'text', id: 'dialog-input', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false' });
    input.addEventListener('input', () => (confirmBtn.disabled = !sameName(input.value, requireText)));
    field = h('div', { class: 'field' }, h('label', { for: 'dialog-input' }, t('remove.typeLabel', { name: requireText })), input);
  } else if (edit) {
    input = h('input', { type: 'text', id: 'dialog-input', autocomplete: 'off', spellcheck: 'false', maxlength: '80', value: edit.value, 'aria-describedby': 'dialog-err' });
    const err = h('p', { id: 'dialog-err', class: 'field-err' }, '');
    const check = () => {
      const p = edit.problem(input.value);
      err.textContent = p ? t(p) : '';
      input.setAttribute('aria-invalid', p ? 'true' : 'false');
      confirmBtn.disabled = Boolean(p) || normalizeName(input.value) === normalizeName(edit.value);
    };
    input.addEventListener('input', check);
    field = h('div', { class: 'field' }, h('label', { for: 'dialog-input' }, edit.label), input, err);
  }
  input?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    // Without this the Enter also activates the trigger button that gets focus back on close, reopening the dialog.
    e.preventDefault();
    if (!confirmBtn.disabled) confirmBtn.click();
  });
  confirmBtn.addEventListener('click', async () => {
    confirmBtn.disabled = true;
    const value = input?.value ?? '';
    dlg.close();
    await onConfirm(value);
  });
  dlg.setAttribute('aria-labelledby', 'dialog-title');
  dlg.setAttribute('aria-describedby', 'dialog-body');
  dlg.replaceChildren(
    h(
      'div',
      { class: 'dialog-inner' },
      h('h2', { id: 'dialog-title' }, title),
      h('p', { id: 'dialog-body' }, body),
      field,
      h('div', { class: 'actions' }, cancelBtn, confirmBtn),
    ),
  );
  dlg.onclose = () => {
    if (trigger?.isConnected) trigger.focus();
    else document.querySelector('#main h1')?.focus();
  };
  dlg.showModal();
  (input ?? cancelBtn).focus();
  if (edit) input.select();
}

// ---------- screen 6: dashboard ----------

async function removeAccountNow(id) {
  const name = accountName(id);
  let r;
  try {
    r = await api('DELETE', `/accounts/${encodeURIComponent(id)}`);
  } catch (e) {
    if (!(e instanceof SessionLost)) announce(e.message);
    return;
  }
  stopPoll(id);
  S.flows.delete(id);
  const note = !r.ok
    ? { kind: 'error', raw: serverError(r) }
    : r.json.revoked === false
      ? { kind: 'warn', key: 'remove.notRevoked', vars: { name } }
      : { kind: 'ok', key: 'remove.done', vars: { name } };
  await refreshState().catch(() => {});
  if (!reachable(S.screen)) go(defaultScreen());
  else {
    S.dashMsg = note;
    render(true);
  }
  announce(msgText(note));
}

async function renameAccountNow(id, newName) {
  const before = accountName(id);
  let r;
  try {
    r = await api('POST', `/accounts/${encodeURIComponent(id)}/rename`, { name: normalizeName(newName) });
  } catch (e) {
    if (!(e instanceof SessionLost)) announce(e.message);
    return;
  }
  const note = r.ok
    ? { kind: 'ok', key: 'rename.done', vars: { old: before, name: r.json.name ?? normalizeName(newName) } }
    : { kind: 'error', raw: serverError(r) };
  if (r.ok) {
    const f = S.flows.get(id);
    if (f) S.flows.set(id, { ...f, name: r.json.name });
  }
  await refreshState().catch(() => {});
  S.dashMsg = note;
  render(true);
  announce(msgText(note));
}

async function loadAutostart() {
  try {
    const r = await api('GET', '/autostart');
    S.autostart = r.ok ? r.json : { supported: false };
  } catch (e) {
    if (e instanceof SessionLost) return;
    S.autostart = { supported: false };
  }
  if (S.screen === 'dashboard') render();
}

async function setAutostartNow(enabled) {
  S.autostart = { ...S.autostart, busy: true };
  render();
  try {
    const r = await api('POST', '/autostart', { enabled });
    S.autostart = r.ok ? r.json : { ...S.autostart, busy: false, error: serverError(r) };
  } catch (e) {
    if (e instanceof SessionLost) return;
    S.autostart = { ...S.autostart, busy: false, error: e.message };
  }
  render();
  announce(S.autostart.error ?? (S.autostart.enabled ? t('dashboard.autostartOn') : t('dashboard.autostartOff')));
}

function dashboardScreen() {
  const remote = isRemote();
  if (!remote && S.autostart === null) {
    S.autostart = { loading: true };
    loadAutostart();
  }
  const rows = accounts().map((a) => {
    const flow = S.flows.get(a.id);
    const pending = flow && (flow.status === 'pending' || flow.status === 'starting');
    const status = pending ? 'pending' : flow?.status === 'failed' ? 'failed' : a.status;
    return [
      h(
        'tr',
        {},
        h('th', { scope: 'row', 'data-label': t('dashboard.colName') }, a.name),
        h('td', { 'data-label': t('dashboard.colEmail') }, a.email),
        h('td', { 'data-label': t('dashboard.colStatus') }, badge(status)),
        h(
          'td',
          { class: 'cell-actions', 'data-label': t('dashboard.colActions') },
          h('button', { type: 'button', class: 'btn btn-small btn-secondary', id: `reconnect-${a.id}`, disabled: pending, onclick: () => startConnect(a.id, undefined, true) }, t('dashboard.reconnect'), h('span', { class: 'sr-only' }, ` ${a.name}`)),
          h(
            'button',
            {
              type: 'button',
              class: 'btn btn-small btn-quiet',
              id: `rename-${a.id}`,
              onclick: (e) =>
                openDialog({
                  title: t('rename.title', { name: a.name }),
                  body: t('rename.body'),
                  confirmLabel: t('rename.confirm'),
                  edit: { label: t('rename.label'), value: a.name, problem: (v) => nameProblem(v, a.id) },
                  trigger: e.currentTarget,
                  onConfirm: (v) => renameAccountNow(a.id, v),
                }),
            },
            t('dashboard.rename'),
            h('span', { class: 'sr-only' }, ` ${a.name}`),
          ),
          h(
            'button',
            {
              type: 'button',
              class: 'btn btn-small btn-quiet btn-danger-quiet',
              id: `remove-${a.id}`,
              onclick: (e) =>
                openDialog({
                  title: t('remove.title', { name: a.name }),
                  body: t('remove.body'),
                  confirmLabel: t('remove.confirm'),
                  danger: true,
                  requireText: a.name,
                  trigger: e.currentTarget,
                  onConfirm: () => removeAccountNow(a.id),
                }),
            },
            t('dashboard.remove'),
            h('span', { class: 'sr-only' }, ` ${a.name}`),
          ),
        ),
      ),
      flow && flow.status !== 'connected'
        ? h('tr', { class: 'row-status' }, h('td', { colspan: '4' }, flowStatus(a.id)))
        : null,
    ];
  });
  const needsReauth = accounts().some((a) => a.status === 'needs_reauth');

  const as = S.autostart ?? {};
  const autostartBlock = as.loading
    ? h('p', { class: 'loading' }, t('app.loading'))
    : as.supported === false
      ? h('p', { class: 'note note-quiet' }, t('ai.unsupported'))
      : h(
          'div',
          { class: 'switch-row' },
          h(
            'button',
            {
              type: 'button',
              role: 'switch',
              id: 'autostart',
              class: 'switch',
              'aria-checked': String(Boolean(as.enabled)),
              'aria-labelledby': 'autostart-label',
              'aria-describedby': 'autostart-desc',
              disabled: as.busy,
              onclick: () => setAutostartNow(!as.enabled),
            },
            h('span', { class: 'switch-knob', 'aria-hidden': 'true' }),
          ),
          h('span', { id: 'autostart-label', class: 'switch-label' }, t('dashboard.autostart')),
        );

  return h(
    'section',
    { class: 'screen screen-dash' },
    header('dashboard.title', 'dashboard.lead'),
    S.dashMsg ? msg(S.dashMsg.kind, msgText(S.dashMsg)) : null,
    h(
      'section',
      { class: 'panel', 'aria-labelledby': 'dash-accounts' },
      h('div', { class: 'panel-head' }, h('h2', { id: 'dash-accounts' }, t('dashboard.accounts')), h('button', { type: 'button', class: 'btn btn-small btn-secondary', id: 'dash-add', onclick: () => go('accounts') }, t('dashboard.add'))),
      h(
        'table',
        { class: 'acct-table' },
        h('thead', {}, h('tr', {}, ['colName', 'colEmail', 'colStatus', 'colActions'].map((k) => h('th', { scope: 'col' }, t(`dashboard.${k}`))))),
        h('tbody', {}, rows),
      ),
      needsReauth ? h('p', { class: 'note note-warn' }, t('dashboard.reconnectHint')) : null,
    ),
    h(
      'section',
      { class: 'panel', 'aria-labelledby': 'dash-ai' },
      h('h2', { id: 'dash-ai' }, t('dashboard.ai')),
      h('p', {}, t('dashboard.aiDesc')),
      h('div', { class: 'row-actions' }, h('button', { type: 'button', class: 'btn btn-secondary', id: 'dash-ai-go', onclick: () => go('ai') }, t('dashboard.ai'))),
    ),
    remote
      ? h(
          'section',
          { class: 'panel', 'aria-labelledby': 'dash-signout' },
          h('h2', { id: 'dash-signout' }, t('remote.signOutTitle')),
          h('p', {}, t('remote.signOutDesc')),
          h('div', { class: 'row-actions' }, h('button', { type: 'button', class: 'btn btn-secondary', id: 'sign-out', onclick: () => signOut() }, t('remote.signOut'))),
        )
      : null,
    remote ? null : h(
      'section',
      { class: 'panel', 'aria-labelledby': 'dash-key' },
      h('h2', { id: 'dash-key' }, t('dashboard.apikey')),
      h('p', {}, t('dashboard.apikeyDesc')),
      h('p', { class: 'key-line' }, h('code', { class: 'key' }, S.state?.apiKeyMasked ?? '')),
      h(
        'div',
        { class: 'row-actions' },
        copyButton(() => getApiKey(), t('dashboard.copyKey')),
        h(
          'button',
          {
            type: 'button',
            class: 'btn btn-small btn-quiet',
            id: 'rotate',
            onclick: (e) =>
              openDialog({
                title: t('dashboard.rotateTitle'),
                body: t('dashboard.rotateBody'),
                confirmLabel: t('dashboard.rotate'),
                trigger: e.currentTarget,
                onConfirm: async () => {
                  try {
                    const r = await api('POST', '/apikey/rotate', {});
                    S.apiKey = null;
                    S.showKey = false;
                    S.dashMsg = r.ok ? { kind: 'ok', key: 'dashboard.rotated' } : { kind: 'error', raw: serverError(r) };
                    await refreshState().catch(() => {});
                    render();
                    announce(msgText(S.dashMsg));
                  } catch (err) {
                    if (!(err instanceof SessionLost)) announce(err.message);
                  }
                },
              }),
          },
          t('dashboard.rotate'),
        ),
      ),
    ),
    remote ? null : h(
      'section',
      { class: 'panel', 'aria-labelledby': 'dash-auto' },
      h('h2', { id: 'dash-auto' }, t('dashboard.autostart')),
      h('p', { id: 'autostart-desc' }, t('dashboard.autostartDesc')),
      autostartBlock,
      as.error ? msg('error', as.error) : null,
    ),
    h(
      'section',
      { class: 'panel', 'aria-labelledby': 'dash-lang' },
      h('h2', { id: 'dash-lang' }, t('dashboard.language')),
      h(
        'div',
        { class: 'seg', role: 'group', 'aria-labelledby': 'dash-lang' },
        ['tr', 'en'].map((code) =>
          h('button', { type: 'button', id: `lang-dash-${code}`, lang: code, class: 'seg-btn', 'aria-pressed': String(S.lang === code), onclick: () => setLanguage(code) }, t(`lang.${code}`)),
        ),
      ),
    ),
  );
}

const SCREEN_RENDER = {
  welcome: welcomeScreen,
  google: googleScreen,
  upload: uploadScreen,
  accounts: accountsScreen,
  ai: aiScreen,
  dashboard: dashboardScreen,
};

// ---------- boot ----------

async function boot() {
  try {
    S.fallback = await loadDict('en');
  } catch {
    S.fallback = {};
  }
  try {
    await refreshState();
  } catch (e) {
    if (e instanceof SessionLost) return;
    S.dict = S.fallback;
    S.sessionLost = false;
    document.getElementById('main').replaceChildren(msg('error', t('errors.network')));
    return;
  }
  S.lang = S.state?.language === 'tr' ? 'tr' : 'en';
  try {
    S.dict = S.lang === 'en' ? S.fallback : await loadDict(S.lang);
  } catch {
    S.dict = S.fallback;
  }
  S.screen = screenFromHash() ?? defaultScreen();
  history.replaceState(null, '', `#${S.screen}`);
  render();
}

boot();
