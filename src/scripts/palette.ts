// Command-style search dialog, opened with "/" or Ctrl/Cmd+K, or from the header button.
// Results are grouped: Articles, Topics, Tags, Pages, Actions.
import { loadAll, searchDetailed, searchTracks, searchTags, searchPages, toTerms, highlight, escapeHtml, type SearchIndex } from './search-core';
import { iconSvg } from './icons';

const dlg = document.getElementById('palette') as HTMLDialogElement | null;
const input = document.getElementById('palette-input') as HTMLInputElement | null;
const list = document.getElementById('palette-list') as HTMLUListElement | null;
const allLink = dlg?.querySelector<HTMLAnchorElement>('[data-palette-all]') ?? null;

let data: SearchIndex | null = null;
let state: 'idle' | 'loading' | 'ready' | 'error' = 'idle';
let active = -1;
let wired = false;

function load() {
  if (state === 'loading' || state === 'ready') return;
  state = 'loading';
  loadAll()
    .then((d) => { data = d; state = 'ready'; })
    .catch(() => { state = 'error'; })
    .finally(() => { if (dlg?.open) render(); });
}
export function warmUp() { load(); }

const safe = (c: string) => (/^#[0-9a-f]{3,8}$/i.test(c) ? c : '#0176d3');
let seq = 0;
const group = (t: string) => `<li class="palette__group" role="presentation">${t}</li>`;
const opt = (inner: string, href: string | null, action?: string) =>
  `<li role="option" id="pal-opt-${seq++}" aria-selected="false">` +
  (href ? `<a class="palette__item" href="${href}" tabindex="-1">${inner}</a>` : `<button class="palette__item" type="button" tabindex="-1" data-action="${action}" style="width:100%;text-align:left;border:0;background:none">${inner}</button>`) +
  `</li>`;
const row = (ico: string, title: string, sub: string, hint = '', color = '') =>
  `<span class="palette__ico" style="${color ? `--c:${color}` : ''}">${ico}</span><span class="palette__txt"><span class="palette__title">${title}</span><span class="palette__sub"><span class="palette__desc">${sub}</span></span></span>${hint ? `<span class="palette__hint">${hint}</span>` : ''}`;

function message(text: string, extra = '') {
  if (!list) return;
  list.innerHTML = `<li class="palette__empty" role="presentation">${text}${extra}</li>`;
  input?.removeAttribute('aria-activedescendant');
  active = -1;
}

function setActive(i: number) {
  if (!list || !input) return;
  const opts = list.querySelectorAll<HTMLElement>('[role="option"]');
  if (!opts.length) { active = -1; input.removeAttribute('aria-activedescendant'); return; }
  active = (i + opts.length) % opts.length;
  opts.forEach((o, n) => o.setAttribute('aria-selected', String(n === active)));
  const el = opts[active];
  input.setAttribute('aria-activedescendant', el.id);
  // Keep the active row visible inside the list only (never scroll the page).
  // Positions are measured against the list itself (offsetTop would be relative to the dialog).
  const lr = list.getBoundingClientRect();
  const er = el.getBoundingClientRect();
  const top = er.top - lr.top + list.scrollTop;
  const bottom = top + er.height;
  const prev = el.previousElementSibling as HTMLElement | null;
  const lead = prev?.classList.contains('palette__group') ? prev.offsetHeight : 0;
  if (active === 0) list.scrollTop = 0;
  else if (top - lead < list.scrollTop) list.scrollTop = Math.max(0, top - lead - 8);
  else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight + 8;
}

function articleOpt(m: { it: import('./search-core').SearchItem }, terms: string[]) {
  const it = m.it;
  const thumb = it.thumb ? `<img class="palette__thumb" src="${escapeHtml(it.thumb.src)}" width="80" height="45" alt="" loading="lazy" decoding="async">` : '<span class="palette__thumb" aria-hidden="true"></span>';
  return opt(
    `${thumb}<span class="palette__txt"><span class="palette__title">${highlight(it.title, terms)}</span><span class="palette__sub"><span class="tag" style="--c:${safe(it.accent)}"><i class="dot"></i>${escapeHtml(it.short)}</span><span class="palette__desc">${highlight(it.description, terms)}</span></span></span>`,
    `/articles/${encodeURIComponent(it.id)}/`,
  );
}

function render() {
  if (!list || !input) return;
  seq = 0;
  const q = input.value.trim();
  if (allLink) allLink.href = q ? `/search/?q=${encodeURIComponent(q)}` : '/search/';
  if (state === 'loading' || state === 'idle') return message('Loading the library…');
  if (state === 'error' || !data) return message('Search could not load.', ' <a href="/search/">Open the full search page</a>.');
  const d = data;
  const terms = toTerms(q);
  const html: string[] = [];

  if (!terms.length) {
    html.push(group('Jump to'));
    for (const p of d.pages.slice(0, 4)) html.push(opt(row(iconSvg(p.icon, 20), escapeHtml(p.title), escapeHtml(p.description)), p.href));
    html.push(group('Latest guides'));
    for (const it of d.articles.slice(0, 4)) html.push(articleOpt({ it }, []));
    html.push(group('Actions'));
    html.push(opt(row(iconSvg('sun', 20), 'Switch theme', 'Light and dark', '<kbd class="kbd">T</kbd>'), null, 'theme'));
  } else {
    const arts = searchDetailed(d.articles, q).slice(0, 5);
    const topics = searchTracks(d.tracks, terms).slice(0, 2);
    const tags = searchTags(d.articles, terms).slice(0, 3);
    const pages = searchPages(d.pages, terms).slice(0, 3);
    // Typing "theme" or "dark" is a command first, a search second: list the action on top.
    if (/^(theme|dark|light|mode|appearance)/.test(terms[0])) { html.push(group('Actions')); html.push(opt(row(iconSvg('sun', 20), 'Switch theme', 'Light and dark', '<kbd class="kbd">T</kbd>'), null, 'theme')); }
    if (arts.length) { html.push(group('Articles')); arts.forEach((m) => html.push(articleOpt(m, terms))); }
    if (topics.length) { html.push(group('Topics')); topics.forEach((t) => html.push(opt(row(iconSvg(t.icon, 20), highlight(t.name, terms), `${t.count} guides · ${escapeHtml(t.description)}`, '', safe(t.accent)), `/category/${t.slug}/`))); }
    if (tags.length) { html.push(group('Tags')); tags.forEach((t) => html.push(opt(row(iconSvg('hash', 20), highlight(t.name, terms), `${t.count} ${t.count === 1 ? 'guide' : 'guides'}`), `/tag/${t.slug}/`))); }
    if (pages.length) { html.push(group('Pages')); pages.forEach((p) => html.push(opt(row(iconSvg(p.icon, 20), highlight(p.title, terms), escapeHtml(p.description)), p.href))); }
    html.push(group('Search'));
    html.push(opt(row(iconSvg('search', 20), `Search everything for “${escapeHtml(q)}”`, 'Filters, sorting and grouped results', '<kbd class="kbd">Enter</kbd>'), `/search/?q=${encodeURIComponent(q)}`));
    if (!arts.length && !topics.length && !tags.length && !pages.length) html.splice(0, 0, `<li class="palette__empty" role="presentation">No direct matches for “${escapeHtml(q)}”. Open the full search to look through article text.</li>`);
  }
  list.innerHTML = html.join('');
  setActive(terms.length ? 0 : -1);
}

function activate(li: HTMLElement | null) {
  if (!li) return;
  const a = li.querySelector<HTMLAnchorElement>('a');
  if (a) { location.href = a.href; return; }
  const act = li.querySelector<HTMLElement>('[data-action]')?.dataset.action;
  if (act === 'theme') { dlg?.close(); window.dispatchEvent(new Event('toggle-theme')); }
}

function wire() {
  if (wired || !dlg || !input || !list) return;
  wired = true;
  input.addEventListener('input', render);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(active + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(active - 1); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const li = active >= 0 ? list.querySelectorAll<HTMLElement>('[role="option"]')[active] : null;
      if (li) activate(li);
      else if (input.value.trim()) location.href = `/search/?q=${encodeURIComponent(input.value.trim())}`;
    }
  });
  list.addEventListener('mousemove', (e) => {
    const li = (e.target as HTMLElement).closest<HTMLElement>('[role="option"]');
    if (!li) return;
    const idx = [...list.querySelectorAll('[role="option"]')].indexOf(li);
    if (idx !== active) setActive(idx);
  });
  list.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-action]');
    if (btn) activate(btn.closest('li'));
  });
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); }); // backdrop click
  dlg.querySelector('[data-palette-close]')?.addEventListener('click', () => dlg.close());
}

export function openPalette() {
  if (!dlg || !input || typeof dlg.showModal !== 'function') { location.href = '/search/'; return; }
  wire();
  if (!dlg.open) dlg.showModal();
  input.value = '';
  load();
  render();
  input.focus();
}
