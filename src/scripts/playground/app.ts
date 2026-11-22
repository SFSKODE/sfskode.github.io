// Playground controller. Everything the page does after load lives here.
import * as api from './api';
import { CodeEditor } from './editor';
import { ResultsView } from './results';
import { LogView } from './logview';
import { openConnect } from './connect';
import { CHALLENGES, type Challenge } from '../../data/challenges';
import { evaluate, type Outcome, type CheckResult } from './challenge-check';
import { buildRows, collectColumns, errorPosition, firstLine, parseFromObject, stripSoqlComments, timeAgo, escapeHtml as esc, formatNumber } from './data-utils';
import { APEX_MEMBERS, APEX_SNIPPETS, SOQL_CLAUSE_KEYWORDS, SOQL_ORDER_KEYWORDS, SOQL_WHERE_KEYWORDS, apexKeywordItems, apexTypeItems, dateLiteralItems, instanceMethodItems, soqlFunctionItems, type Context, type Suggestion } from './complete';
import { tokenizeSoql, type Lang } from './tokenize';
import { EXAMPLES } from './examples';

const $ = <T extends HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector<T>(sel)!;
const $$ = <T extends HTMLElement>(sel: string, root: ParentNode = document) => [...root.querySelectorAll<T>(sel)];
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ------------------------------ persistence ------------------------------ */
interface HistoryItem { id: string; kind: Lang; code: string; ok: boolean; ms: number; ts: number; note: string }
interface Snippet { id: string; name: string; kind: Lang; code: string }
interface Store { drafts: { apex: string; soql: string }; lang: Lang; history: HistoryItem[]; snippets: Snippet[]; done: string[]; split: number; logLevel: string }
const KEY = 'skode:playground:v1';
const DEFAULTS: Store = { drafts: { apex: EXAMPLES.apex[0].code, soql: EXAMPLES.soql[0].code }, lang: 'soql', history: [], snippets: [], done: [], split: 0, logLevel: 'DEBUG' };
function load(): Store {
  try { const s = JSON.parse(localStorage.getItem(KEY) || 'null'); if (s && typeof s === 'object') return { ...DEFAULTS, ...s, drafts: { ...DEFAULTS.drafts, ...(s.drafts || {}) } }; } catch { /* private mode */ }
  return structuredClone(DEFAULTS);
}
const store = load();
let saveT = 0;
const persist = () => { window.clearTimeout(saveT); saveT = window.setTimeout(() => { try { localStorage.setItem(KEY, JSON.stringify(store)); } catch { /* ignore */ } }, 250); };

/* ------------------------------ elements & helpers ------------------------------ */
const root = $('[data-pg]');
const toasts = $('[data-toasts]');
function toast(msg: string) {
  const t = document.createElement('div');
  t.className = 'toast'; t.textContent = msg;
  toasts.append(t);
  window.setTimeout(() => { t.classList.add('is-out'); window.setTimeout(() => t.remove(), 300); }, 2400);
}
const svg = (p: string, s = 16) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const I = { play: '<path d="M7 5l12 7-12 7z"/>', db: '<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6"/>', trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12h10l1-12M9 7V4h6v3"/>', check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>', x: '<path d="M6 6l12 12M18 6 6 18"/>', link: '<path d="M14 4h6v6M20 4l-9 9M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/>', chev: '<path d="m9 6 6 6-6 6"/>' };

function tablist(list: HTMLElement, attr: string, onSelect: (v: string) => void) {
  const tabs = $$<HTMLButtonElement>(`[${attr}]`, list);
  const select = (b: HTMLButtonElement, focus = false) => {
    tabs.forEach((t) => { const on = t === b; t.setAttribute('aria-selected', String(on)); t.tabIndex = on ? 0 : -1; });
    if (focus) b.focus();
    onSelect(b.getAttribute(attr)!);
  };
  tabs.forEach((b, i) => {
    b.addEventListener('click', () => select(b));
    b.addEventListener('keydown', (e) => {
      const k = e.key;
      if (k !== 'ArrowRight' && k !== 'ArrowLeft' && k !== 'Home' && k !== 'End') return;
      e.preventDefault();
      const n = k === 'Home' ? 0 : k === 'End' ? tabs.length - 1 : (i + (k === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      select(tabs[n], true);
    });
  });
  return select;
}

/* ------------------------------ state ------------------------------ */
let config: api.Config | null = null;
let configFailed = false;
let session: api.SessionInfo = { connected: false };
let lang: Lang = store.lang;
let activeChallenge: Challenge | null = null;
let running = false;
let abort: AbortController | null = null;
const describeCache = new Map<string, Promise<api.Describe>>();
let objects: api.ObjectInfo[] | null = null;
let objectsPromise: Promise<api.ObjectInfo[]> | null = null;

const describe = (name: string) => {
  const k = name.toLowerCase();
  if (!describeCache.has(k)) describeCache.set(k, api.describeObject(name).catch((e) => { describeCache.delete(k); throw e; }));
  return describeCache.get(k)!;
};
const loadObjects = () => (objectsPromise ??= api.describeGlobal().then((r) => (objects = r.objects)).catch((e) => { objectsPromise = null; throw e; }));

/* ------------------------------ editor ------------------------------ */
const editor = new CodeEditor($('[data-editor]'), {
  lang, value: store.drafts[lang], label: 'Code editor',
  onRun: () => void run(), onSave: () => saveSnippet(),
  onChange: (v) => { store.drafts[lang] = v; persist(); editor.setError(null); },
  suggest: (ctx, l) => suggestions(ctx, l),
});
const placeholders: Record<Lang, string> = { apex: "// Apex runs as anonymous code, for example:\nSystem.debug('Hello');", soql: 'SELECT Id, Name FROM Account LIMIT 10' };
editor.setPlaceholder(placeholders[lang]);

async function suggestions(ctx: Context, l: Lang): Promise<Suggestion[]> {
  if (ctx.kind === 'apex') {
    if (ctx.qualifier) {
      const q = ctx.qualifier;
      const known = APEX_MEMBERS[q] || APEX_MEMBERS[q[0].toUpperCase() + q.slice(1)];
      return known ?? (/^[a-z]/.test(q) ? instanceMethodItems() : []);
    }
    const items: Suggestion[] = [...APEX_SNIPPETS, ...apexKeywordItems(), ...apexTypeItems()];
    if (session.connected) { try { (await loadObjects()).forEach((o) => items.push({ label: o.name, kind: 'object', detail: o.label })); } catch { /* ignore */ } }
    return items;
  }
  void l;
  if (ctx.clause === 'from-object') {
    if (!session.connected) return [];
    try { return (await loadObjects()).map((o) => ({ label: o.name, kind: 'object' as const, detail: o.label })); } catch { return []; }
  }
  if (ctx.clause === 'after-from') return SOQL_CLAUSE_KEYWORDS.map((k) => ({ label: k, kind: 'kw' as const }));
  if (ctx.clause === 'none') return [];
  const out: Suggestion[] = [];
  if (ctx.object && session.connected) {
    try {
      let obj = ctx.object;
      if (ctx.subquery && ctx.outerObject) {
        const outer = await describe(ctx.outerObject);
        const child = outer.childRelationships.find((c) => c.relationshipName?.toLowerCase() === ctx.object!.toLowerCase());
        if (child) obj = child.childSObject;
      }
      let d = await describe(obj);
      for (const step of ctx.path) {
        const f = d.fields.find((x) => x.relationshipName?.toLowerCase() === step.toLowerCase());
        if (!f || !f.referenceTo[0]) { d = null as never; break; }
        d = await describe(f.referenceTo[0]);
      }
      if (d) {
        const pre = ctx.path.length ? '' : '';
        for (const f of d.fields) {
          if (ctx.clause === 'picklist' && ctx.valueField && f.name === ctx.valueField) f.picklistValues.forEach((p) => out.push({ label: `'${p.value}'`, kind: 'value', detail: p.label }));
          if (ctx.clause !== 'picklist') out.push({ label: pre + f.name, kind: 'field', detail: f.type + (f.length ? ` (${f.length})` : '') });
          if (ctx.clause !== 'picklist' && f.relationshipName) out.push({ label: f.relationshipName + '.', insert: f.relationshipName + '.', kind: 'rel', detail: `→ ${f.referenceTo.join(', ')}` });
        }
        if (ctx.clause === 'select' && !ctx.path.length) d.childRelationships.forEach((c) => out.push({ label: `(SELECT Id FROM ${c.relationshipName})`, insert: `(SELECT Id FROM ${c.relationshipName})`, kind: 'snippet', detail: 'child subquery' }));
      }
    } catch { /* describe failed: fall back to keywords */ }
  }
  if (ctx.clause === 'select') out.push(...soqlFunctionItems());
  if (ctx.clause === 'where') { out.push(...SOQL_WHERE_KEYWORDS.map((k) => ({ label: k, kind: 'kw' as const }))); if (ctx.afterOperator) out.push(...dateLiteralItems()); }
  if (ctx.clause === 'order') out.push(...SOQL_ORDER_KEYWORDS.map((k) => ({ label: k, kind: 'kw' as const })));
  return out;
}

/* ------------------------------ connection ------------------------------ */
const connEl = $('[data-conn]');
const banner = $('[data-banner]');
/** The Playground server cannot be reached: say why, in terms that fit where the site is hosted. */
function drawServiceDown() {
  const local = ['localhost', '127.0.0.1'].includes(location.hostname);
  showBanner(api.isRemote || local || !navigator.onLine
    ? 'Could not reach the playground service. If it was idle, wait a minute and reload.'
    : 'The Playground server is not connected to this website yet. Site owner: build the site with <code>PUBLIC_SF_API_URL</code> set to your API address (see <code>GO-LIVE-PLAYGROUND.md</code>).', 'err');
}

function showBanner(html: string, kind: 'warn' | 'err' = 'warn') {
  banner.hidden = false; banner.className = `pg__banner container pg__banner--${kind}`; banner.innerHTML = html;
}
const hideBanner = () => { banner.hidden = true; banner.innerHTML = ''; };

function drawConn() {
  root.toggleAttribute('data-connected', session.connected);
  if (!session.connected) {
    connEl.innerHTML = `<button class="btn btn--primary pg__connect" type="button" data-open-connect>${svg('<path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1"/>', 18)} Connect Salesforce org</button><p class="pg__hint">Practise on a Developer Edition or sandbox org.</p>`;
  } else {
    const o = session.org, u = session.user;
    connEl.innerHTML = `<div class="org"><span class="org__dot" aria-hidden="true"></span><div class="org__t"><b>${esc(o?.name || 'Salesforce org')}</b><small>${esc(u?.username || u?.name || '')}</small></div><span class="pill ${o?.isSandbox ? 'pill--sb' : 'pill--prod'}">${o?.isSandbox ? 'Sandbox' : 'Production'}</span><button class="btn btn--sm" type="button" data-open-connect>Switch</button><button class="btn btn--sm" type="button" data-disconnect>Disconnect</button></div>`;
  }
  $$('[data-open-connect]', connEl).forEach((b) => b.addEventListener('click', openConnectDialog));
  $('[data-disconnect]', connEl)?.addEventListener('click', async () => {
    try { await api.logout(); } catch { /* ignore */ }
    session = { connected: false }; objects = null; objectsPromise = null; describeCache.clear();
    drawConn(); drawObjects(); hideBanner(); toast('Disconnected. Your tokens were deleted.');
  });
  $('[data-run]').classList.toggle('is-locked', !session.connected);
}

function openConnectDialog() {
  if (configFailed) { drawServiceDown(); return; }   // no server to log in through: do not open a window that can only show an error
  // One click: the dialog opens and the Salesforce login window opens with it (login.salesforce.com).
  openConnect($('[data-connect-dlg]'), {
    config, reduced, quick: true, fresh: session.connected,
    onConnected: (s) => { session = s; hideBanner(); drawConn(); drawObjects(); results.empty(true); },
  });
}

api.onSessionLost(() => {
  if (!session.connected) return;
  session = { connected: false }; objects = null; objectsPromise = null; describeCache.clear();
  drawConn(); drawObjects();
  showBanner('Your Salesforce session ended. Your code is safe, just <button class="linkbtn" type="button" data-reconnect>reconnect</button> to keep going.');
  $('[data-reconnect]', banner)?.addEventListener('click', openConnectDialog);
});

/* ------------------------------ output panes ------------------------------ */
const resultsPane = $('[data-out-pane="results"]');
const logPane = $('[data-out-pane="log"]');
logPane.innerHTML = '<div class="astat" data-astat hidden></div><div data-logview></div>';
let lastSoql = '';
const results = new ResultsView(resultsPane, {
  toast,
  onMore: (c) => api.queryMore(c),
  fieldTypes: (col) => {
    const from = parseFromObject(lastSoql);
    if (!from || col.includes('.')) return undefined;
    return resolved.get(from.toLowerCase())?.find((f) => f.name === col)?.type;
  },
  onCount: (n) => { const b = $('[data-badge-results]'); b.textContent = n ? String(n > 999 ? '999+' : n) : ''; },
});
const resolved = new Map<string, api.FieldInfo[]>();
const logView = new LogView($('[data-logview]', logPane), toast);
tablist($('.pg__otabs'), 'data-out-tab', (v) => {
  resultsPane.hidden = v !== 'results'; logPane.hidden = v !== 'log';
});
const status = $('[data-status]');
function setStatus(text: string, kind: 'ok' | 'err' | '' = '') { status.textContent = text; status.className = `pg__status${kind ? ` is-${kind}` : ''}`; }

/* ------------------------------ running ------------------------------ */
const cleanSoql = (t: string) => stripSoqlComments(t).replace(/^\s*--.*$/gm, '').trim().replace(/;+\s*$/, '');

async function run(): Promise<Outcome | null> {
  if (running) return null;
  if (!session.connected) { openConnectDialog(); return null; }
  const code = editor.value;
  if (!code.trim()) { toast('Write something to run first.'); return null; }
  running = true; abort = new AbortController();
  const runBtn = $('[data-run]');
  runBtn.classList.add('is-running'); runBtn.setAttribute('aria-busy', 'true');
  editor.setError(null); hideBanner();
  const kind = lang;
  const t0 = performance.now();
  let outcome: Outcome = { ran: false, ok: false, columns: [], rows: [], log: '' };
  try {
    if (kind === 'soql') {
      const soql = cleanSoql(code);
      if (!soql) throw new api.ApiError('bad_request', 'The query is empty (comments are ignored).', 400);
      lastSoql = soql;
      $$<HTMLButtonElement>('[data-out-tab]').forEach((b) => { const on = b.dataset.outTab === 'results'; b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1; });
      resultsPane.hidden = false; logPane.hidden = true;
      results.loading();
      const from = parseFromObject(soql);
      if (from) void describe(from).then((d) => { resolved.set(from.toLowerCase(), d.fields); }).catch(() => {});
      const res = await api.runQuery(soql, { all: ($('[data-opt-all]') as HTMLInputElement).checked, tooling: ($('[data-opt-tooling]') as HTMLInputElement).checked }, abort.signal);
      if (from) await describe(from).catch(() => null);
      results.show(res, soql);
      const rows = buildRows(res.records);
      outcome = { ran: true, ok: true, columns: collectColumns(rows), rows: rows.map((r) => r.cells as Record<string, unknown>), log: '' };
      setStatus(`${formatNumber(res.totalSize)} record${res.totalSize === 1 ? '' : 's'} · ${Math.round(res.ms)} ms`, 'ok');
    } else {
      $$<HTMLButtonElement>('[data-out-tab]').forEach((b) => { const on = b.dataset.outTab === 'log'; b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1; });
      resultsPane.hidden = true; logPane.hidden = false;
      logView.loading(); $('[data-astat]').hidden = true;
      const res = await api.runApex(code, ($('[data-loglevel]') as HTMLSelectElement).value, abort.signal);
      const ok = res.compiled && res.success;
      const astat = $('[data-astat]');
      astat.hidden = false;
      astat.className = `astat ${ok ? 'is-ok' : 'is-bad'}`;
      astat.innerHTML = ok
        ? `${svg(I.check, 18)}<div><b>Ran successfully</b><span>${Math.round(res.ms)} ms</span></div>`
        : `${svg(I.x, 18)}<div><b>${res.compiled ? 'Exception' : 'Compile error'}${res.line > 0 ? ` on line ${res.line}` : ''}</b><span>${esc(res.compileProblem || res.exceptionMessage || 'The code did not finish.')}</span>${res.exceptionStackTrace ? `<code>${esc(res.exceptionStackTrace)}</code>` : ''}</div>${res.line > 0 ? '<button class="btn btn--sm" type="button" data-goto>Go to line</button>' : ''}`;
      $('[data-goto]', astat)?.addEventListener('click', () => editor.goToLine(res.line));
      if (res.line > 0 && !ok) editor.setError(res.line, res.compileProblem || res.exceptionMessage || '');
      logView.show(res.log, !!res.truncated);
      $('[data-badge-log]').textContent = res.log ? String(logView.entryCount() || '') : '';
      outcome = { ran: true, ok, columns: [], rows: [], log: res.log };
      setStatus(ok ? `Apex ran · ${Math.round(res.ms)} ms` : res.compiled ? 'Apex threw an exception' : 'Apex did not compile', ok ? 'ok' : 'err');
    }
  } catch (e) {
    if ((e as Error).name === 'AbortError') { results.empty(true); setStatus('Cancelled'); }
    else {
      const err = e as api.ApiError;
      const msg = err.message || 'Request failed';
      if (kind === 'soql') {
        results.error(msg, { retry: () => void run(), hint: /MALFORMED|unexpected token|No such column|sObject type/i.test(msg) ? 'Check the spelling of fields and objects. Press Ctrl+Space in the editor for suggestions.' : undefined });
        const pos = errorPosition(msg); if (pos) editor.setError(pos.line, msg);
      } else { logView.empty(); $('[data-astat]').hidden = false; $('[data-astat]').className = 'astat is-bad'; $('[data-astat]').innerHTML = `${svg(I.x, 18)}<div><b>Could not run Apex</b><span>${esc(msg)}</span></div>`; }
      if (err.code === 'rate_limited') toast('Slow down a little: too many requests in a minute.');
      setStatus(kind === 'soql' ? 'Query failed' : 'Run failed', 'err');
      outcome = { ran: true, ok: false, columns: [], rows: [], log: '' };
    }
  } finally {
    running = false; abort = null;
    runBtn.classList.remove('is-running'); runBtn.removeAttribute('aria-busy');
  }
  if (outcome.ran) addHistory({ id: String(Date.now()), kind, code, ok: outcome.ok, ms: Math.round(performance.now() - t0), ts: Date.now(), note: firstLine(code, 70) });
  return outcome;
}
$('[data-run]').addEventListener('click', () => { if (running) abort?.abort(); else void run(); });

/* ------------------------------ language tabs ------------------------------ */
function applyLang(l: Lang, silent = false) {
  store.drafts[lang] = editor.value;
  lang = l; store.lang = l;
  editor.setLang(l); editor.value = store.drafts[l]; editor.setPlaceholder(placeholders[l]); editor.setError(null);
  $$('[data-soql-only]').forEach((el) => (el.hidden = l !== 'soql'));
  $$('[data-apex-only]').forEach((el) => (el.hidden = l !== 'apex'));
  $$<HTMLButtonElement>('[data-lang]').forEach((b) => { const on = b.dataset.lang === l; b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1; });
  persist();
  if (!silent) editor.focus();
}
const selectLang = tablist($('.pg__tabs'), 'data-lang', (v) => { if (v !== lang) { activeChallenge && activeChallenge.kind !== v && endChallenge(); applyLang(v as Lang); } });
void selectLang;
applyLang(lang, true);
($('[data-loglevel]', root) as HTMLSelectElement).value = store.logLevel;
$('[data-loglevel]').addEventListener('change', (e) => { store.logLevel = (e.target as HTMLSelectElement).value; persist(); });

/* ------------------------------ tidy ------------------------------ */
$('[data-format]').addEventListener('click', () => {
  if (lang !== 'soql') return;
  const toks = tokenizeSoql(editor.value);
  let out = '', depth = 0, prevKw = '';
  for (const t of toks) {
    if (t.s === '(') depth++;
    if (t.s === ')') depth--;
    const up = t.s.toUpperCase();
    if (t.t === 'kw' && depth === 0 && ['FROM', 'WHERE', 'GROUP', 'ORDER', 'HAVING', 'LIMIT', 'OFFSET'].includes(up) && !(up === 'BY')) { out = out.replace(/[ \t]+$/, '') + '\n'; }
    out += t.t === 'kw' ? up : t.s;
    prevKw = up;
  }
  void prevKw;
  editor.replaceAll(out.replace(/[ \t]+\n/g, '\n').replace(/\n{2,}/g, '\n').trim());
  toast('Tidied the query');
});

/* ------------------------------ history & snippets ------------------------------ */
function addHistory(h: HistoryItem) {
  store.history = [h, ...store.history.filter((x) => !(x.code === h.code && x.kind === h.kind))].slice(0, 50);
  persist(); drawHistory();
}
function loadCode(kind: Lang, code: string, note = '') {
  endChallengeUi();
  if (kind !== lang) applyLang(kind, true);
  editor.replaceAll(code);
  editor.focus();
  if (note) toast(note);
}
function saveSnippet() {
  const code = editor.value.trim();
  if (!code) return toast('Nothing to save yet.');
  const name = (window.prompt('Name this snippet', firstLine(code, 40)) || '').trim();
  if (!name) return;
  store.snippets = [{ id: String(Date.now()), name, kind: lang, code: editor.value }, ...store.snippets].slice(0, 100);
  persist(); drawLibrary(); toast('Snippet saved to Library');
}
$('[data-save]').addEventListener('click', saveSnippet);

const histPanel = $('[data-side-panel="history"]');
function drawHistory() {
  if (!store.history.length) { histPanel.innerHTML = '<div class="pgx pgx--side"><h3>Nothing run yet</h3><p>Your last 50 runs are kept here, in this browser only.</p></div>'; return; }
  histPanel.innerHTML = `<div class="pg__list">${store.history.map((h) => `<div class="hrow"><button type="button" class="hrow__main" data-h="${h.id}"><span class="hk hk--${h.kind}">${h.kind === 'apex' ? 'Apex' : 'SOQL'}</span><span class="hrow__t">${esc(h.note)}</span><small>${timeAgo(h.ts)} · ${h.ms} ms</small></button><i class="hrow__s ${h.ok ? 'is-ok' : 'is-bad'}" title="${h.ok ? 'Succeeded' : 'Failed'}"></i></div>`).join('')}</div><button class="btn btn--sm pg__clear" type="button" data-clear-history>Clear history</button>`;
  $$('[data-h]', histPanel).forEach((b) => b.addEventListener('click', () => { const h = store.history.find((x) => x.id === b.dataset.h); if (h) loadCode(h.kind, h.code); }));
  $('[data-clear-history]', histPanel).addEventListener('click', () => { store.history = []; persist(); drawHistory(); });
}

const libPanel = $('[data-side-panel="library"]');
function drawLibrary() {
  const group = (title: string, kind: Lang, items: { name: string; code: string; note?: string }[]) => `<h3 class="pg__gh">${title}</h3><div class="pg__list">${items.map((x, i) => `<button type="button" class="lrow" data-ex="${kind}:${i}"><b>${esc(x.name)}</b>${x.note ? `<small>${esc(x.note)}</small>` : ''}</button>`).join('')}</div>`;
  const mine = store.snippets.length ? `<h3 class="pg__gh">My snippets</h3><div class="pg__list">${store.snippets.map((s) => `<div class="hrow"><button type="button" class="hrow__main" data-snip="${s.id}"><span class="hk hk--${s.kind}">${s.kind === 'apex' ? 'Apex' : 'SOQL'}</span><span class="hrow__t">${esc(s.name)}</span></button><button class="iconbtn" type="button" data-del="${s.id}" aria-label="Delete ${esc(s.name)}">${svg(I.trash, 15)}</button></div>`).join('')}</div>` : '';
  libPanel.innerHTML = mine + group('SOQL examples', 'soql', EXAMPLES.soql) + group('Apex examples', 'apex', EXAMPLES.apex);
  $$('[data-ex]', libPanel).forEach((b) => b.addEventListener('click', () => { const [k, i] = b.dataset.ex!.split(':'); const ex = EXAMPLES[k as Lang][Number(i)]; loadCode(k as Lang, ex.code); }));
  $$('[data-snip]', libPanel).forEach((b) => b.addEventListener('click', () => { const s = store.snippets.find((x) => x.id === b.dataset.snip); if (s) loadCode(s.kind, s.code); }));
  $$('[data-del]', libPanel).forEach((b) => b.addEventListener('click', () => { store.snippets = store.snippets.filter((x) => x.id !== b.dataset.del); persist(); drawLibrary(); }));
}

/* ------------------------------ schema browser ------------------------------ */
const objList = $('[data-obj-list]');
let objKind: 'all' | 'standard' | 'custom' = 'all';
let objQ = '';
const expanded = new Set<string>();
function typeIcon(t: string) { return ({ id: 'ID', reference: '→', string: 'Aa', textarea: 'Aa', picklist: '≡', multipicklist: '≡', boolean: '✓', int: '#', double: '#', currency: '$', percent: '%', date: '▦', datetime: '▦', email: '@', phone: '☎', url: '↗' } as Record<string, string>)[t] || '·'; }

function drawObjects() {
  if (!session.connected) {
    objList.innerHTML = `<div class="pgx pgx--side"><div class="pgx__art" aria-hidden="true">${svg(I.db, 36)}</div><h3>Browse your org</h3><p>Connect to see every object and field in your org. Click a field to drop it into your query.</p><button class="btn btn--primary btn--sm" type="button" data-open-connect2>Connect Salesforce org</button></div>`;
    $('[data-open-connect2]', objList).addEventListener('click', openConnectDialog);
    return;
  }
  if (!objects) {
    objList.innerHTML = `<div class="pgsk pgsk--side">${'<i></i>'.repeat(8)}</div>`;
    loadObjects().then(() => drawObjects(), (e) => { objList.innerHTML = `<div class="pgx pgx--side pgx--err"><h3>Could not load objects</h3><p>${esc((e as Error).message)}</p><button class="btn btn--sm" type="button" data-r>Try again</button></div>`; $('[data-r]', objList).addEventListener('click', drawObjects); });
    return;
  }
  const q = objQ.trim().toLowerCase();
  const list = objects.filter((o) => (objKind === 'all' || (objKind === 'custom') === o.custom) && (!q || o.name.toLowerCase().includes(q) || o.label.toLowerCase().includes(q)));
  const shown = list.slice(0, 120);
  objList.innerHTML = shown.map((o) => `<div class="obj${expanded.has(o.name) ? ' is-open' : ''}" data-o="${esc(o.name)}"><button type="button" class="obj__h" aria-expanded="${expanded.has(o.name)}" data-toggle="${esc(o.name)}">${svg(I.chev, 14)}<span class="obj__t"><b>${esc(o.label)}</b><small>${esc(o.name)}</small></span>${o.custom ? '<i class="obj__c">custom</i>' : ''}</button><div class="obj__b" ${expanded.has(o.name) ? '' : 'hidden'}></div></div>`).join('') + (list.length > shown.length ? `<p class="pg__more">${formatNumber(list.length - shown.length)} more. Keep typing to narrow it down.</p>` : '') + (!list.length ? '<p class="pg__more">No objects match.</p>' : '');
  $$('[data-toggle]', objList).forEach((b) => b.addEventListener('click', () => toggleObject(b.dataset.toggle!)));
  for (const n of expanded) { const box = objList.querySelector<HTMLElement>(`[data-o="${CSS.escape(n)}"] .obj__b`); if (box) fillObject(n, box); }
}
async function toggleObject(name: string) {
  const el = objList.querySelector<HTMLElement>(`[data-o="${CSS.escape(name)}"]`)!;
  const box = $('.obj__b', el), head = $('.obj__h', el);
  const open = !expanded.has(name);
  open ? expanded.add(name) : expanded.delete(name);
  el.classList.toggle('is-open', open); head.setAttribute('aria-expanded', String(open)); box.hidden = !open;
  if (open) fillObject(name, box);
}
async function fillObject(name: string, box: HTMLElement) {
  box.innerHTML = `<div class="pgsk pgsk--side">${'<i></i>'.repeat(4)}</div>`;
  try {
    const d = await describe(name);
    resolved.set(name.toLowerCase(), d.fields);
    const label = (f: api.FieldInfo) => `<button type="button" class="fld" data-f="${esc(f.name)}" title="${esc(f.label)} · ${esc(f.type)}${f.referenceTo.length ? ' → ' + esc(f.referenceTo.join(', ')) : ''}"><i class="fld__t">${typeIcon(f.type)}</i><span>${esc(f.name)}</span><small>${esc(f.type)}</small></button>`;
    box.innerHTML = `<div class="obj__act"><button type="button" class="btn btn--sm" data-q="${esc(name)}">${svg(I.play, 13)} Query it</button><button type="button" class="btn btn--sm" data-ids="${esc(name)}">Insert fields</button></div>${d.fields.map(label).join('')}${d.childRelationships.length ? `<p class="pg__gh pg__gh--s">Child relationships</p>${d.childRelationships.slice(0, 40).map((c) => `<button type="button" class="fld fld--rel" data-f="${esc(c.relationshipName)}"><i class="fld__t">↳</i><span>${esc(c.relationshipName)}</span><small>${esc(c.childSObject)}</small></button>`).join('')}` : ''}`;
    $$('[data-f]', box).forEach((b) => b.addEventListener('click', () => { editor.insertAtCursor(b.dataset.f!); }));
    $('[data-q]', box).addEventListener('click', () => { if (lang !== 'soql') applyLang('soql', true); const cols = ['Id', ...(d.fields.some((f) => f.name === 'Name') ? ['Name'] : [])]; editor.replaceAll(`SELECT ${cols.join(', ')}\nFROM ${name}\nLIMIT 10`); editor.focus(); });
    $('[data-ids]', box).addEventListener('click', () => { editor.insertAtCursor(d.fields.slice(0, 12).map((f) => f.name).join(', ')); });
  } catch (e) {
    box.innerHTML = `<p class="pg__more">${esc((e as Error).message)}</p>`;
  }
}
$('[data-obj-filter]').addEventListener('input', (e) => { objQ = (e.target as HTMLInputElement).value; if (session.connected && objects) drawObjects(); });
$$<HTMLButtonElement>('[data-obj-kind]').forEach((b) => b.addEventListener('click', () => {
  objKind = b.dataset.objKind as typeof objKind;
  $$<HTMLButtonElement>('[data-obj-kind]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  if (session.connected && objects) drawObjects();
}));

/* ------------------------------ challenges ------------------------------ */
const learnPanel = $('[data-side-panel="learn"]');
const lesson = $('[data-lesson]');
let hintsShown = 0;
let lastResults: CheckResult[] | null = null;
const miniMd = (s: string) => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*(.+?)\*/g, '<em>$1</em>');
function drawLearn() {
  const done = store.done.length;
  $('[data-learn-badge]').textContent = `${done}/${CHALLENGES.length}`;
  const levels: Challenge['level'][] = ['Beginner', 'Intermediate', 'Advanced'];
  learnPanel.innerHTML = `<div class="prog" role="progressbar" aria-valuemin="0" aria-valuemax="${CHALLENGES.length}" aria-valuenow="${done}" aria-label="Challenges completed"><i style="--p:${(done / CHALLENGES.length) * 100}%"></i><span>${done} of ${CHALLENGES.length} complete</span></div>` +
    levels.map((lv) => { const items = CHALLENGES.filter((c) => c.level === lv); return items.length ? `<h3 class="pg__gh">${lv}</h3><div class="pg__list">${items.map((c) => `<button type="button" class="crow${activeChallenge?.id === c.id ? ' is-on' : ''}" data-c="${c.id}"><i class="crow__s ${store.done.includes(c.id) ? 'is-done' : ''}">${store.done.includes(c.id) ? svg(I.check, 13) : ''}</i><span class="crow__t"><b>${esc(c.title)}</b><small>${c.kind === 'apex' ? 'Apex' : 'SOQL'}</small></span></button>`).join('')}</div>` : ''; }).join('');
  $$('[data-c]', learnPanel).forEach((b) => b.addEventListener('click', () => startChallenge(CHALLENGES.find((c) => c.id === b.dataset.c)!)));
}
function startChallenge(c: Challenge) {
  activeChallenge = c; hintsShown = 0; lastResults = null;
  if (c.kind !== lang) applyLang(c.kind, true);
  editor.replaceAll(c.starter); editor.setError(null);
  drawLesson(); drawLearn();
  root.classList.add('has-lesson');
  window.setTimeout(() => editor.focus(), 50);
  $('.pg__work').scrollIntoView({ block: 'start', behavior: reduced ? 'auto' : 'smooth' });
}
function endChallengeUi() { if (!activeChallenge) return; activeChallenge = null; lesson.hidden = true; lesson.innerHTML = ''; root.classList.remove('has-lesson'); drawLearn(); }
function endChallenge() { endChallengeUi(); }
function drawLesson() {
  const c = activeChallenge;
  if (!c) { lesson.hidden = true; return; }
  const idx = CHALLENGES.findIndex((x) => x.id === c.id);
  const nextC = CHALLENGES[idx + 1];
  const done = store.done.includes(c.id);
  const res = lastResults;
  lesson.hidden = false; lesson.className = `pg__lesson${done ? ' is-done' : ''}`;
  lesson.innerHTML = `<div class="les__head"><span class="les__lv les__lv--${c.level.toLowerCase()}">${c.level}</span><h2>${esc(c.title)}</h2><button class="iconbtn" type="button" data-les-close aria-label="Close challenge">${svg(I.x, 16)}</button></div>
    <p class="les__story">${miniMd(c.story)}</p>
    ${hintsShown ? `<ol class="les__hints">${c.hints.slice(0, hintsShown).map((h) => `<li>${hintsShown && c.hints.indexOf(h) === c.hints.length - 1 ? `<code class="les__ans">${esc(h)}</code>` : esc(h)}</li>`).join('')}</ol>` : ''}
    <ul class="les__checks">${(res ?? c.checks.map((k) => ({ label: k.label, pass: null as boolean | null, hint: undefined as string | undefined }))).map((r) => `<li class="${r.pass === null ? '' : r.pass ? 'is-pass' : 'is-fail'}"><i>${r.pass ? svg(I.check, 13) : r.pass === false ? svg(I.x, 13) : ''}</i><span>${esc(r.label)}${'hint' in r && r.hint && !r.pass ? `<small>${esc(r.hint)}</small>` : ''}</span></li>`).join('')}</ul>
    <div class="les__act"><button class="btn btn--primary btn--sm" type="button" data-check>${done ? 'Check again' : 'Check my answer'}</button>${hintsShown < c.hints.length ? `<button class="btn btn--sm" type="button" data-hint>Show hint ${hintsShown + 1} of ${c.hints.length}</button>` : ''}<button class="btn btn--sm" type="button" data-reset>Reset code</button><a class="les__art" href="/articles/${c.article}/" target="_blank" rel="noopener">Read the guide ${svg(I.link, 13)}</a>${done && nextC ? '<button class="btn btn--sm les__next" type="button" data-next>Next challenge →</button>' : ''}</div>
    <div class="les__win" aria-hidden="true"></div>`;
  $('[data-les-close]', lesson).addEventListener('click', endChallenge);
  $('[data-check]', lesson).addEventListener('click', () => void checkChallenge());
  $('[data-hint]', lesson)?.addEventListener('click', () => { hintsShown++; drawLesson(); });
  $('[data-reset]', lesson).addEventListener('click', () => { editor.replaceAll(c.starter); lastResults = null; drawLesson(); editor.focus(); });
  $('[data-next]', lesson)?.addEventListener('click', () => startChallenge(nextC));
}
async function checkChallenge() {
  const c = activeChallenge;
  if (!c) return;
  if (!session.connected) { openConnectDialog(); return; }
  const btn = $('[data-check]', lesson) as HTMLButtonElement; btn.disabled = true; btn.textContent = 'Checking…';
  const o = await run();
  const { results: r, passed } = evaluate(c, editor.value, o);
  lastResults = r;
  const first = !store.done.includes(c.id);
  if (passed && first) { store.done.push(c.id); persist(); }
  drawLesson(); drawLearn();
  if (passed) celebrate();
  else toast(`${r.filter((x) => x.pass).length} of ${r.length} checks passed`);
}
function celebrate() {
  const host = $('.les__win', lesson);
  lesson.classList.add('is-win');
  if (reduced) return;
  const colors = ['var(--brand)', 'var(--cyan-500, #1ab9ff)', 'var(--violet, #7b5cfa)', 'var(--amber, #e8890c)', 'var(--mint, #0e9f8e)'];
  for (let i = 0; i < 26; i++) {
    const p = document.createElement('i');
    const a = (Math.PI * 2 * i) / 26 + Math.random() * 0.4, d = 50 + Math.random() * 90;
    p.style.cssText = `--x:${Math.cos(a) * d}px;--y:${Math.sin(a) * d - 20}px;--r:${Math.random() * 540 - 270}deg;background:${colors[i % colors.length]};animation-delay:${Math.random() * 90}ms`;
    host.append(p);
  }
  window.setTimeout(() => { host.innerHTML = ''; lesson.classList.remove('is-win'); }, 1400);
}

/* ------------------------------ layout bits ------------------------------ */
tablist($('.pg__stabs'), 'data-side-tab', (v) => { $$('[data-side-panel]').forEach((p) => (p.hidden = p.dataset.sidePanel !== v)); });
$('[data-side-toggle]').addEventListener('click', (e) => {
  const side = $('[data-side]'); const open = !side.hasAttribute('data-open');
  side.toggleAttribute('data-open', open); (e.currentTarget as HTMLElement).setAttribute('aria-expanded', String(open));
});
{ // drag-to-resize between editor and output
  const work = $('.pg__work'); const split = $('[data-split]'); const wrap = $('[data-editor-wrap]');
  const set = (px: number) => { const v = Math.max(140, Math.min(px, work.clientHeight - 220)); wrap.style.setProperty('--ed-h', `${v}px`); split.setAttribute('aria-valuenow', String(Math.round((v / work.clientHeight) * 100))); store.split = v; persist(); };
  if (store.split) wrap.style.setProperty('--ed-h', `${store.split}px`);
  split.addEventListener('pointerdown', (e) => {
    e.preventDefault(); split.setPointerCapture(e.pointerId); split.classList.add('is-drag');
    const startY = e.clientY, startH = wrap.getBoundingClientRect().height;
    const move = (m: PointerEvent) => set(startH + (m.clientY - startY));
    const up = () => { split.classList.remove('is-drag'); split.removeEventListener('pointermove', move); split.removeEventListener('pointerup', up); };
    split.addEventListener('pointermove', move); split.addEventListener('pointerup', up);
  });
  split.addEventListener('keydown', (e) => { if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); set(wrap.getBoundingClientRect().height + (e.key === 'ArrowDown' ? 32 : -32)); } });
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && running) abort?.abort(); });

/* ------------------------------ boot ------------------------------ */
drawConn(); drawObjects(); drawHistory(); drawLibrary(); drawLearn();
results.empty(false);
(async () => {
  const qs = new URLSearchParams(location.search);
  const arrived = api.takeTokenFromUrl();           // hosted API: this window was opened by the login with the token in the URL
  if (arrived?.popup) { try { window.close(); } catch { /* not allowed: carry on as a normal tab */ } }
  try { config = await api.getConfig(); } catch { configFailed = true; drawServiceDown(); }
  try { session = await api.getSession(); } catch { session = { connected: false }; }
  drawConn(); drawObjects(); if (session.connected) results.empty(true);
  if (qs.get('connected')) toast('Connected to Salesforce');
  if (qs.get('sf_error')) showBanner(`Salesforce could not log you in (${esc(qs.get('sf_error')!)}). Pick the environment again and retry.`, 'err');
  if (qs.has('connected') || qs.has('sf_error')) history.replaceState(null, '', location.pathname);
  const want = qs.get('c');
  if (want) { const c = CHALLENGES.find((x) => x.id === want); if (c) startChallenge(c); }
})();
