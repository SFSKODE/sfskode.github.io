// The /search/ page: results grouped into meaningful sections, with filters, sorting and URL state.
import {
  loadAll, searchDetailed, searchTracks, searchTags, searchPages, didYouMean, allTags, toTerms, highlight, escapeHtml, resultHtml,
  type SearchIndex, type Match, type TrackItem,
} from './search-core';
import { iconSvg } from './icons';

type TypeKey = 'all' | 'articles' | 'topics' | 'tags' | 'pages';
interface State { q: string; type: TypeKey; track: string; level: string; sort: string; group: 'track' | 'none' }

const $ = <T extends HTMLElement>(s: string) => document.querySelector<T>(s);
const input = $<HTMLInputElement>('#search-page-input');
const out = $('#results');
const count = $('#count');
const filtersEl = $('[data-filters]');
const sortEl = $<HTMLSelectElement>('[data-sort]');
const clearBtn = $<HTMLButtonElement>('[data-clear]');
const kbd = $('[data-kbd]');
const activeEl = $('[data-active-filters]');
const fToggle = $<HTMLButtonElement>('[data-filters-toggle]');
const fCount = $('[data-fcount]');

const DEF: State = { q: '', type: 'all', track: '', level: '', sort: 'rel', group: 'track' };
let st: State = { ...DEF };
let data: SearchIndex | null = null;
const expanded = new Set<string>();
const PER_GROUP = 4;

/* ------------------------------ URL state ------------------------------ */
function readUrl() {
  const p = new URLSearchParams(location.search);
  const pick = <T extends string>(k: string, ok: readonly T[], d: T): T => (ok.includes(p.get(k) as T) ? (p.get(k) as T) : d);
  st = {
    q: (p.get('q') ?? '').slice(0, 200),
    type: pick('type', ['all', 'articles', 'topics', 'tags', 'pages'] as const, 'all'),
    track: p.get('track') ?? '',
    level: pick('level', ['', 'beginner', 'intermediate', 'advanced'] as const, ''),
    sort: pick('sort', ['rel', 'new', 'old', 'short', 'az'] as const, 'rel'),
    group: pick('group', ['track', 'none'] as const, 'track'),
  };
}
function writeUrl() {
  const p = new URLSearchParams();
  if (st.q.trim()) p.set('q', st.q.trim());
  for (const k of ['type', 'track', 'level', 'sort', 'group'] as const) if (st[k] !== DEF[k]) p.set(k, st[k]);
  const qs = p.toString();
  history.replaceState(null, '', location.pathname + (qs ? `?${qs}` : ''));
}

/* ------------------------------ helpers ------------------------------ */
const plural = (n: number, one: string, many = one + 's') => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
const trackOf = (slug: string) => data?.tracks.find((t) => t.slug === slug);

function sortMatches(list: Match[], terms: string[]): Match[] {
  const sort = st.sort === 'rel' && !terms.length ? 'new' : st.sort;
  if (sort === 'rel') return list;
  const a = [...list];
  const by: Record<string, (x: Match, y: Match) => number> = {
    new: (x, y) => +new Date(y.it.date) - +new Date(x.it.date),
    old: (x, y) => +new Date(x.it.date) - +new Date(y.it.date),
    short: (x, y) => x.it.mins - y.it.mins,
    az: (x, y) => x.it.title.localeCompare(y.it.title),
  };
  return a.sort(by[sort] ?? by.new);
}

const trackRow = (t: TrackItem, i: number, terms: string[]) =>
  `<article class="tres" style="--c:${escapeHtml(t.accent)};--i:${i}"><span class="tres__ico" aria-hidden="true">${iconSvg(t.icon)}</span>` +
  `<div class="tres__txt"><b><a href="/category/${t.slug}/">${highlight(t.name, terms)}</a></b><span>${escapeHtml(t.count + (t.count === 1 ? ' guide' : ' guides'))} · ${escapeHtml(t.description)}</span></div>` +
  `<span class="tres__go" aria-hidden="true">${iconSvg('arrow-right')}</span></article>`;

const section = (id: string, title: string, n: number, body: string) =>
  `<section class="rs" aria-labelledby="rs-${id}"><header class="rs__head"><h2 id="rs-${id}">${title}</h2><span class="rs__n">${n}</span></header>${body}</section>`;

function articleGroups(list: Match[], terms: string[], startIndex: number): string {
  const tracksInList = [...new Set(list.map((m) => m.it.categorySlug))];
  if (st.group === 'none' || tracksInList.length < 2) {
    return `<div class="rs__list">${list.map((m, i) => resultHtml(m, terms, { i: Math.min(startIndex + i, 8) })).join('')}</div>`;
  }
  return tracksInList.map((slug) => {
    const items = list.filter((m) => m.it.categorySlug === slug);
    const t = trackOf(slug);
    const open = expanded.has(slug);
    const shown = open ? items : items.slice(0, PER_GROUP);
    const more = items.length - shown.length;
    return `<div class="rgroup" style="--c:${escapeHtml(t?.accent ?? '#0176d3')}">` +
      `<div class="rgroup__head"><i class="dot"></i><h3>${escapeHtml(t?.name ?? slug)}</h3><small>${items.length}</small><a href="/category/${slug}/">Open topic</a></div>` +
      `<div class="rs__list">${shown.map((m, i) => resultHtml(m, terms, { i })).join('')}</div>` +
      (items.length > PER_GROUP ? `<button class="btn btn--sm rmore" type="button" data-more="${slug}" aria-expanded="${open}">${open ? 'Show fewer' : `Show ${more} more in ${escapeHtml(t?.short ?? slug)}`}${iconSvg('chevron', 16)}</button>` : '') +
      `</div>`;
  }).join('');
}

/* ------------------------------ views ------------------------------ */
function browseView(): string {
  const d = data!;
  const tags = allTags(d.articles).slice(0, 16);
  const latest = d.articles.slice(0, 5).map((it) => ({ it, score: 0, why: [] as string[] }));
  return `<div class="sx__browse">` +
    `<section><h2>Browse by topic</h2><div class="rs__grid">${d.tracks.map((t, i) => trackRow(t, i, [])).join('')}</div></section>` +
    `<section><h2>Popular tags</h2><div class="chips">${tags.map((t) => `<button class="chip" type="button" data-suggest="${escapeHtml(t.name)}">${escapeHtml(t.name)}<span class="chip__n">${t.count}</span></button>`).join('')}</div></section>` +
    `<section><h2>Recently added</h2><div class="rs__list">${latest.map((m, i) => resultHtml(m, [], { i })).join('')}</div></section>` +
    `</div>`;
}

function emptyView(): string {
  const d = data!;
  const hasFilters = !!(st.track || st.level || st.type !== 'all');
  const dym = didYouMean(d.articles, st.q);
  const tags = allTags(d.articles).slice(0, 6);
  return `<div class="sx__state"><div class="ico">${iconSvg('search', 28)}</div>` +
    `<h2>No results for “${escapeHtml(st.q.trim())}”</h2>` +
    `<p>${dym ? `Did you mean <button class="link-more" type="button" data-suggest="${escapeHtml(dym)}" style="display:inline"><b>${escapeHtml(dym)}</b></button>? ` : ''}${hasFilters ? 'Your filters may be too narrow. ' : ''}Try fewer or broader words, or start from a popular topic.</p>` +
    (hasFilters ? `<p><button class="btn btn--sm" type="button" data-reset-filters>Reset filters</button></p>` : '') +
    `<div class="chips">${tags.map((t) => `<button class="chip" type="button" data-suggest="${escapeHtml(t.name)}">${escapeHtml(t.name)}</button>`).join('')}</div></div>`;
}

function errorView() {
  if (!out) return;
  if (count) count.textContent = '';
  out.setAttribute('aria-busy', 'false');
  out.innerHTML = `<div class="sx__state sx__state--error"><div class="ico">${iconSvg('close', 28)}</div><h2>Search isn’t available right now</h2><p>The search index could not be loaded. Check your connection and try again.</p>` +
    `<p><button class="btn btn--primary" type="button" data-retry>Try again</button> <a class="btn" href="/articles/">Browse all articles</a></p></div>`;
}

/* ------------------------------ render ------------------------------ */
function render() {
  if (!out || !count || !data) return;
  const d = data;
  const terms = toTerms(st.q);
  const hasQuery = terms.length > 0;
  if (clearBtn) clearBtn.hidden = !st.q;
  if (kbd) (kbd as HTMLElement).hidden = !!st.q;
  if (sortEl) {
    sortEl.value = !hasQuery && st.sort === 'rel' ? 'new' : st.sort;
    const relOpt = sortEl.querySelector<HTMLOptionElement>('option[value="rel"]');
    if (relOpt) relOpt.disabled = !hasQuery;
  }

  // Counts for the sidebar (each ignores its own filter so you can see what switching would give).
  const base = searchDetailed(d.articles, st.q, { cat: st.track, level: st.level });
  const noTrack = searchDetailed(d.articles, st.q, { level: st.level });
  const noLevel = searchDetailed(d.articles, st.q, { cat: st.track });
  const topics = hasQuery ? searchTracks(d.tracks, terms) : [];
  const tags = searchTags(d.articles, terms);
  const pages = searchPages(d.pages, terms);
  const nums: Record<string, number> = {
    all: base.length + topics.length + tags.length + pages.length,
    articles: base.length, topics: topics.length, tags: tags.length, pages: pages.length,
    'track-all': noTrack.length,
    'level-all': noLevel.length,
  };
  for (const t of d.tracks) nums[`track-${t.slug}`] = noTrack.filter((m) => m.it.categorySlug === t.slug).length;
  for (const l of ['beginner', 'intermediate', 'advanced']) nums[`level-${l}`] = searchDetailed(d.articles, st.q, { cat: st.track, level: l }).length;
  document.querySelectorAll<HTMLElement>('[data-n]').forEach((el) => {
    const v = nums[el.dataset.n!];
    el.textContent = v === undefined ? '' : String(v);
    el.closest('.fopt')?.classList.toggle('is-zero', v === 0);
  });
  // Type counts for non-query browse mode make no sense; hide them.
  document.querySelectorAll<HTMLElement>('[data-group="type"] .fopt__n').forEach((el) => { el.hidden = !hasQuery; });

  paintFilterUi();
  out.setAttribute('aria-busy', 'false');

  const filtered = !!(st.track || st.level);
  if (!hasQuery && !filtered && st.type === 'all') {
    count.innerHTML = `<b>${d.articles.length}</b> guides to explore`;
    out.innerHTML = browseView();
    return;
  }

  const wantArticles = st.type === 'all' || st.type === 'articles';
  const wantTopics = (st.type === 'all' || st.type === 'topics') && !st.track && !st.level;
  const wantTags = (st.type === 'all' || st.type === 'tags') && !st.track && !st.level;
  const wantPages = (st.type === 'all' || st.type === 'pages') && !st.track && !st.level;

  const arts = wantArticles ? sortMatches(base, terms) : [];
  const parts: string[] = [];
  let idx = 0;
  let list = arts;
  if (hasQuery && arts.length && st.type === 'all' && st.sort === 'rel') {
    parts.push(section('top', 'Top result', 1, `<div class="rs__list">${resultHtml(arts[0], terms, { top: true })}</div>`));
    list = arts.slice(1);
    idx = 1;
  }
  if (wantTopics && topics.length) parts.push(section('topics', 'Topics', topics.length, `<div class="rs__grid">${topics.map((t, i) => trackRow(t, i, terms)).join('')}</div>`));
  if (list.length) parts.push(section('articles', st.type === 'all' && hasQuery && st.sort === 'rel' ? 'More articles' : 'Articles', list.length, articleGroups(list, terms, idx)));
  if (wantTags && tags.length) parts.push(section('tags', 'Tags', tags.length, `<div class="chips">${tags.slice(0, 24).map((t) => `<a class="chip" href="/tag/${t.slug}/">${highlight(t.name, terms)}<span class="chip__n">${t.count}</span></a>`).join('')}</div>`));
  if (wantPages && pages.length) parts.push(section('pages', 'Pages', pages.length, `<div class="rs__grid">${pages.map((p, i) => `<article class="tres" style="--i:${i}"><span class="tres__ico" aria-hidden="true">${iconSvg(p.icon)}</span><div class="tres__txt"><b><a href="${p.href}">${highlight(p.title, terms)}</a></b><span>${escapeHtml(p.description)}</span></div><span class="tres__go" aria-hidden="true">${iconSvg('arrow-right')}</span></article>`).join('')}</div>`));

  const shownTotal = (wantArticles ? arts.length : 0) + (wantTopics ? topics.length : 0) + (wantTags ? tags.length : 0) + (wantPages ? pages.length : 0);
  if (!parts.length) {
    count.innerHTML = hasQuery ? `No results for “${escapeHtml(st.q.trim())}”` : 'No guides match these filters';
    out.innerHTML = hasQuery ? emptyView() : `<div class="sx__state"><div class="ico">${iconSvg('search', 28)}</div><h2>No guides match these filters</h2><p>Try a different topic or level.</p><p><button class="btn btn--sm" type="button" data-reset-filters>Reset filters</button></p></div>`;
    return;
  }
  const bits = [`<b>${plural(arts.length, 'article')}</b>`];
  if (wantTopics && topics.length) bits.push(plural(topics.length, 'topic'));
  if (wantTags && tags.length) bits.push(plural(tags.length, 'tag'));
  if (wantPages && pages.length) bits.push(plural(pages.length, 'page'));
  count.innerHTML = (hasQuery ? `for “${escapeHtml(st.q.trim())}”: ` : '') + (wantArticles ? bits.join(' · ') : plural(shownTotal, 'result'));
  out.innerHTML = parts.join('');
}

function paintFilterUi() {
  document.querySelectorAll<HTMLElement>('[data-group]').forEach((g) => {
    const key = g.dataset.group as keyof State;
    g.querySelectorAll<HTMLElement>('.fopt').forEach((b) => b.setAttribute('aria-checked', String((b.dataset.v ?? '') === String(st[key]))));
  });
  // Active filter chips (so the state is obvious, and each one can be removed).
  const chips: { k: keyof State; label: string }[] = [];
  if (st.type !== 'all') chips.push({ k: 'type', label: `Show: ${st.type}` });
  if (st.track) chips.push({ k: 'track', label: `Topic: ${trackOf(st.track)?.short ?? st.track}` });
  if (st.level) chips.push({ k: 'level', label: `Level: ${st.level}` });
  if (activeEl) {
    activeEl.hidden = chips.length === 0;
    activeEl.innerHTML = chips.map((c) => `<button class="chip" type="button" data-remove="${c.k}">${escapeHtml(c.label)}${iconSvg('close', 14)}<span class="sr-only"> remove filter</span></button>`).join('');
  }
  if (fCount) { fCount.textContent = String(chips.length); (fCount as HTMLElement).hidden = chips.length === 0; }
}

/* ------------------------------ events ------------------------------ */
function update(opts: { url?: boolean } = {}) {
  render();
  if (opts.url !== false) writeUrl();
}
function setQuery(q: string, focus = true) {
  st.q = q;
  if (input) { input.value = q; if (focus) input.focus(); }
  update();
}

function start() {
  out?.setAttribute('aria-busy', 'true');
  loadAll().then((d) => { data = d; render(); }).catch(errorView);
}

if (input && out) {
  readUrl();
  input.value = st.q;
  let t = 0;
  input.addEventListener('input', () => {
    st.q = input.value;
    window.clearTimeout(t);
    t = window.setTimeout(() => update(), 90);
    if (clearBtn) clearBtn.hidden = !st.q;
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && input.value) { e.preventDefault(); setQuery('', true); }
  });
  clearBtn?.addEventListener('click', () => setQuery(''));
  sortEl?.addEventListener('change', () => { st.sort = sortEl.value; update(); });

  document.addEventListener('click', (e) => {
    const el = e.target as HTMLElement;
    const opt = el.closest<HTMLElement>('.fopt');
    if (opt && filtersEl?.contains(opt)) {
      const g = opt.closest<HTMLElement>('[data-group]')?.dataset.group as keyof State | undefined;
      if (g) { (st as unknown as Record<string, string>)[g] = opt.dataset.v ?? ''; expanded.clear(); update(); }
      return;
    }
    const sug = el.closest<HTMLElement>('[data-suggest]');
    if (sug) { setQuery(sug.dataset.suggest ?? ''); window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
    const more = el.closest<HTMLElement>('[data-more]');
    if (more) { const k = more.dataset.more!; if (expanded.has(k)) expanded.delete(k); else expanded.add(k); render(); return; }
    const rm = el.closest<HTMLElement>('[data-remove]');
    if (rm) { const k = rm.dataset.remove as keyof State; (st as unknown as Record<string, string>)[k] = DEF[k] as string; update(); return; }
    if (el.closest('[data-reset-filters]')) { st = { ...DEF, q: st.q, sort: st.sort }; expanded.clear(); update(); return; }
    if (el.closest('[data-retry]')) { start(); return; }
  });
  fToggle?.addEventListener('click', () => {
    const open = !filtersEl?.hasAttribute('data-open');
    filtersEl?.toggleAttribute('data-open', open);
    fToggle.setAttribute('aria-expanded', String(open));
  });
  window.addEventListener('popstate', () => { readUrl(); if (input) input.value = st.q; render(); });
  start();
}
