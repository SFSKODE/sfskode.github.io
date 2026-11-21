// Shared by the command palette, the hero suggestions and the /search/ page.
export interface SearchItem {
  id: string;
  title: string;
  description: string;
  category: string;
  categorySlug: string;
  short: string;
  accent: string;
  tags: string[];
  date: string;
  mins: number;
  api?: string;
  text: string;
  thumb?: { src: string; w: number; h: number } | null;
  level?: { first: string; last: string; label: string } | null;
}
export interface TrackItem { slug: string; name: string; short: string; accent: string; icon: string; description: string; topics: string[]; count: number }
export interface PageItem { title: string; href: string; description: string; keywords: string[]; icon: string }
export interface SearchIndex { articles: SearchItem[]; tracks: TrackItem[]; pages: PageItem[] }
export interface Match { it: SearchItem; score: number; why: string[] }

let cache: Promise<SearchIndex> | null = null;

/** Fetch the whole search index once. A failed attempt is not cached, so retrying works. */
export function loadAll(): Promise<SearchIndex> {
  cache ??= fetch('/search.json', { headers: { Accept: 'application/json' } })
    .then((r) => {
      if (!r.ok) throw new Error(`search.json ${r.status}`);
      return r.json() as Promise<SearchIndex>;
    })
    .catch((err) => {
      cache = null;
      throw err;
    });
  return cache;
}
/** Articles only (hero suggestions). */
export const loadIndex = (): Promise<SearchItem[]> => loadAll().then((d) => d.articles);

export const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export const toTerms = (q: string) => q.toLowerCase().split(/\s+/).filter(Boolean);
const safeColor = (c: string) => (/^#[0-9a-f]{3,8}$/i.test(c) ? c : '#0176d3');

/* ------------------------------ ranking ------------------------------ */
interface Hay { t: string; tw: string[]; d: string; tags: string[]; x: string }
const hay = new WeakMap<SearchItem, Hay>();
function hayFor(it: SearchItem): Hay {
  let h = hay.get(it);
  if (!h) {
    const t = it.title.toLowerCase();
    h = { t, tw: t.split(/[^a-z0-9+#.]+/).filter(Boolean), d: it.description.toLowerCase(), tags: it.tags.map((x) => x.toLowerCase()), x: it.text.toLowerCase() };
    hay.set(it, h);
  }
  return h;
}

function scoreWhy(it: SearchItem, terms: string[]): { score: number; why: string[] } {
  const h = hayFor(it);
  let total = 0;
  const why = new Set<string>();
  for (const w of terms) {
    let s = 0;
    if (h.tw.some((x) => x.startsWith(w))) { s += 12; why.add('title'); }
    else if (h.t.includes(w)) { s += 7; why.add('title'); }
    if (h.tags.includes(w)) { s += 10; why.add(`tag: ${w}`); }
    else if (h.tags.some((t) => t.includes(w))) { s += 5; why.add('tag'); }
    if (h.d.includes(w)) { s += 4; why.add('description'); }
    if (h.x.includes(w)) { s += 1; why.add('content'); }
    if (!s) return { score: 0, why: [] }; // every term must match somewhere
    total += s;
  }
  if (terms.length > 1 && h.t.includes(terms.join(' '))) total += 15;
  return { score: total, why: [...why] };
}

const LEVEL_ORDER = ['beginner', 'intermediate', 'advanced'];
export const levelsCovered = (it: SearchItem) => {
  if (!it.level) return [] as string[];
  const a = LEVEL_ORDER.indexOf(it.level.first);
  const b = LEVEL_ORDER.indexOf(it.level.last);
  return a < 0 || b < 0 ? [] : LEVEL_ORDER.slice(a, b + 1);
};

export interface Filters { cat?: string; level?: string }
/** Filter and rank articles. With no query the index order (newest first) is kept. */
export function searchDetailed(items: SearchItem[], query: string, f: Filters = {}): Match[] {
  let pool = items;
  if (f.cat) pool = pool.filter((i) => i.categorySlug === f.cat);
  if (f.level) pool = pool.filter((i) => levelsCovered(i).includes(f.level!));
  const terms = toTerms(query);
  if (!terms.length) return pool.map((it) => ({ it, score: 0, why: [] }));
  return pool
    .map((it, i) => ({ it, i, ...scoreWhy(it, terms) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map(({ it, score, why }) => ({ it, score, why }));
}
/** Simple list form (hero suggestions). */
export const search = (items: SearchItem[], query: string, cat = ''): SearchItem[] => searchDetailed(items, query, { cat }).map((m) => m.it);

export function searchTracks(tracks: TrackItem[], terms: string[]): TrackItem[] {
  if (!terms.length) return [];
  return tracks
    .map((t) => {
      const hayT = [t.name, t.short, t.description, ...t.topics].join(' ').toLowerCase();
      const name = (t.name + ' ' + t.short).toLowerCase();
      let s = 0;
      for (const w of terms) {
        if (!hayT.includes(w)) return { t, s: 0 };
        s += name.includes(w) ? 8 : 3;
      }
      return { t, s };
    })
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .map((x) => x.t);
}

export interface TagHit { name: string; slug: string; count: number }
export const tagSlug = (t: string) => t.toLowerCase().replace(/[^a-z0-9+#]+/g, '-').replace(/^-+|-+$/g, '');
export function allTags(items: SearchItem[]): TagHit[] {
  const m = new Map<string, TagHit>();
  for (const it of items) for (const raw of new Set(it.tags)) {
    const k = raw.toLowerCase();
    const cur = m.get(k);
    if (cur) cur.count++;
    else m.set(k, { name: raw, slug: tagSlug(raw), count: 1 });
  }
  return [...m.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}
export function searchTags(items: SearchItem[], terms: string[]): TagHit[] {
  if (!terms.length) return [];
  return allTags(items).filter((t) => terms.every((w) => t.name.toLowerCase().includes(w)));
}
export function searchPages(pages: PageItem[], terms: string[]): PageItem[] {
  if (!terms.length) return [];
  return pages.filter((p) => {
    const h = [p.title, p.description, ...p.keywords].join(' ').toLowerCase();
    return terms.every((w) => h.includes(w));
  });
}

/** A short "did you mean" using the closest known tag or title word (edit distance <= 2). */
export function didYouMean(items: SearchItem[], query: string): string | null {
  const terms = toTerms(query);
  if (!terms.length) return null;
  const vocab = new Set<string>();
  for (const it of items) { hayFor(it).tw.forEach((w) => w.length > 3 && vocab.add(w)); hayFor(it).tags.forEach((t) => vocab.add(t)); }
  const dist = (a: string, b: string) => {
    if (Math.abs(a.length - b.length) > 2) return 3;
    const row = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      let prev = row[0];
      row[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const tmp = row[j];
        row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
        prev = tmp;
      }
    }
    return row[b.length];
  };
  let changed = false;
  const out = terms.map((w) => {
    if (w.length < 4 || vocab.has(w) || [...vocab].some((v) => v.startsWith(w))) return w;
    let best = w, bd = 3;
    for (const v of vocab) { const d = dist(w, v); if (d < bd) { bd = d; best = v; } }
    if (best !== w) changed = true;
    return best;
  });
  return changed ? out.join(' ') : null;
}

/* ------------------------------ presentation ------------------------------ */
/** Escape `text` and wrap matches of `terms` in <mark>. */
export function highlight(text: string, terms: string[]): string {
  const lower = text.toLowerCase();
  if (!terms.length || lower.length !== text.length) return escapeHtml(text);
  const ranges: [number, number][] = [];
  for (const t of terms) {
    let i = 0;
    while ((i = lower.indexOf(t, i)) !== -1) { ranges.push([i, i + t.length]); i += t.length; }
  }
  if (!ranges.length) return escapeHtml(text);
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  let out = '';
  let pos = 0;
  for (const [s, e] of merged) {
    out += escapeHtml(text.slice(pos, s)) + '<mark class="hit">' + escapeHtml(text.slice(s, e)) + '</mark>';
    pos = e;
  }
  return out + escapeHtml(text.slice(pos));
}

/** A ~170 character excerpt of the article body around the first match, or '' when the match is already in the title/description. */
export function snippet(it: SearchItem, terms: string[]): string {
  if (!terms.length) return '';
  const h = hayFor(it);
  if (terms.every((w) => h.t.includes(w) || h.d.includes(w))) return '';
  let at = -1;
  for (const w of terms) { const i = h.x.indexOf(w); if (i !== -1 && (at === -1 || i < at)) at = i; }
  if (at === -1) return '';
  const start = Math.max(0, at - 60);
  const end = Math.min(it.text.length, at + 110);
  return (start > 0 ? '…' : '') + it.text.slice(start, end).trim() + (end < it.text.length ? '…' : '');
}

const dateFmt = new Intl.DateTimeFormat('en-IN', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'Asia/Kolkata' });
export const formatDate = (iso: string) => dateFmt.format(new Date(iso));

const levelHtml = (it: SearchItem) =>
  it.level ? `<span class="level" data-lv="${escapeHtml(it.level.first)}" data-lv-max="${escapeHtml(it.level.last)}"><span class="level__bars" aria-hidden="true"><i></i><i></i><i></i></span>${escapeHtml(it.level.label)}</span>` : '';

/** One search result row. `top` renders the larger "best match" variant. */
export function resultHtml(m: Match, terms: string[], opts: { top?: boolean; i?: number } = {}): string {
  const it = m.it;
  const media = it.thumb
    ? `<img class="cover-img" src="${escapeHtml(it.thumb.src)}" width="${it.thumb.w}" height="${it.thumb.h}" alt="" loading="lazy" decoding="async">`
    : `<div class="cover-art"><span class="cover-art__grid" aria-hidden="true"></span><span class="cover-art__label">${escapeHtml(it.short)}</span></div>`;
  const snip = snippet(it, terms);
  const why = m.why.length ? `<p class="res__why">Matched in ${m.why.slice(0, 3).map((w) => `<span>${escapeHtml(w)}</span>`).join('')}</p>` : '';
  return (
    `<article class="res${opts.top ? ' res--top' : ''}" style="--c:${safeColor(it.accent)};--i:${opts.i ?? 0}">` +
    `<div class="res__media">${media}${levelHtml(it)}</div>` +
    `<div class="res__body">` +
    (opts.top ? `<span class="res__best">Best match</span>` : '') +
    `<div class="res__meta"><span class="tag"><i class="dot"></i>${escapeHtml(it.short)}</span><span>${it.mins} min read</span><time datetime="${escapeHtml(it.date)}">${formatDate(it.date)}</time></div>` +
    `<h3 class="res__title"><a href="/articles/${encodeURIComponent(it.id)}/">${highlight(it.title, terms)}</a></h3>` +
    `<p class="res__desc">${highlight(it.description, terms)}</p>` +
    (snip ? `<p class="res__snip">${highlight(snip, terms)}</p>` : '') +
    why +
    `</div></article>`
  );
}
