// The results table: type-aware cells, click-to-sort, filter, chunked rendering, load more, CSV/JSON export.
import { buildRows, collectColumns, columnLabels, cellKind, filterRows, formatDate, formatDateTime, formatNumber, isCountOnly, shortId, sortRows, toCsv, escapeHtml as esc, type Row, type Cell, type SubResult, type Rec } from './data-utils';
import type { QueryResult } from './api';

const CHUNK = 200;
export interface ResultsHooks { onMore: (cursor: string) => Promise<QueryResult>; toast: (m: string) => void; fieldTypes?: (col: string) => string | undefined; onCount?: (n: number) => void }

export class ResultsView {
  private host: HTMLElement;
  private hooks: ResultsHooks;
  private rows: Row[] = [];
  private cols: string[] = [];
  private labels: Record<string, string> = {};
  private soql = '';
  private total = 0;
  private done = true;
  private cursor: string | undefined;
  private ms = 0;
  private sort: { col: string; dir: 1 | -1 } | null = null;
  private q = '';
  private shown = CHUNK;
  private loadingMore = false;

  constructor(host: HTMLElement, hooks: ResultsHooks) { this.host = host; this.hooks = hooks; this.empty(); }

  empty(connected = false) {
    this.host.innerHTML = `<div class="pgx"><div class="pgx__art" aria-hidden="true"><svg viewBox="0 0 120 80" width="120" height="80" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="8" y="10" width="104" height="60" rx="8"/><path d="M8 28h104M40 28v42M76 28v42M8 46h104"/></svg></div><h3>Results appear here</h3><p>${connected ? 'Write a query and press <kbd class="kbd">Ctrl</kbd> <kbd class="kbd">Enter</kbd> to run it.' : 'Connect an org, then run a query. Your rows show up in a sortable table you can export.'}</p></div>`;
    this.hooks.onCount?.(0);
  }
  loading(what = 'Running query') {
    this.host.innerHTML = `<div class="pgx pgx--load" role="status"><div class="pgsk">${'<i></i>'.repeat(6)}</div><p>${what}…</p></div>`;
  }
  error(message: string, extra?: { retry?: () => void; hint?: string }) {
    this.host.innerHTML = `<div class="pgx pgx--err" role="alert"><h3>That didn’t work</h3><pre class="pgx__msg">${esc(message)}</pre>${extra?.hint ? `<p>${esc(extra.hint)}</p>` : ''}${extra?.retry ? '<button class="btn btn--sm" type="button" data-retry>Try again</button>' : ''}</div>`;
    this.host.querySelector('[data-retry]')?.addEventListener('click', () => extra?.retry?.());
    this.hooks.onCount?.(0);
  }

  show(res: QueryResult, soql: string) {
    this.soql = soql; this.total = res.totalSize; this.done = res.done; this.cursor = res.nextCursor; this.ms = res.ms;
    this.rows = buildRows(res.records);
    this.sort = null; this.q = ''; this.shown = CHUNK;
    this.recomputeCols();
    this.hooks.onCount?.(this.rows.length);
    if (isCountOnly(soql) && !this.rows.length) {
      this.host.innerHTML = `<div class="pgx pgx--count"><div class="pgx__num">${formatNumber(res.totalSize)}</div><p>records match · ${Math.round(res.ms)} ms</p></div>`;
      return;
    }
    this.draw(true);
  }

  private recomputeCols() { this.cols = collectColumns(this.rows); this.labels = columnLabels(this.cols, this.soql); }
  private visible(): Row[] {
    let r = filterRows(this.rows, this.cols, this.q);
    if (this.sort) r = sortRows(r, this.sort.col, this.sort.dir);
    return r;
  }

  private cell(v: Cell, col: string): string {
    const kind = cellKind(v, col, this.hooks.fieldTypes?.(col));
    switch (kind) {
      case 'null': return '<td class="c c--null"><span aria-label="empty">—</span></td>';
      case 'bool': return `<td class="c"><span class="chipb chipb--${v ? 'y' : 'n'}">${v ? 'true' : 'false'}</span></td>`;
      case 'num': return `<td class="c c--num">${formatNumber(v as number)}</td>`;
      case 'id': return `<td class="c c--id"><button type="button" class="idbtn" data-copy="${esc(String(v))}" title="Copy ${esc(String(v))}">${esc(shortId(String(v)))}</button></td>`;
      case 'date': return `<td class="c c--date">${esc(formatDate(String(v)))}</td>`;
      case 'datetime': return `<td class="c c--date" title="${esc(String(v))}">${esc(formatDateTime(String(v)))}</td>`;
      case 'sub': {
        const s = v as SubResult;
        if (!s.records.length) return '<td class="c c--null"><span>0 records</span></td>';
        const sub = buildRows(s.records);
        const sc = collectColumns(sub);
        return `<td class="c"><details class="subr"><summary>${s.totalSize} record${s.totalSize === 1 ? '' : 's'}</summary><table class="mini"><thead><tr>${sc.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${sub.map((r) => `<tr>${sc.map((c) => `<td>${r.cells[c] == null ? '—' : typeof r.cells[c] === 'object' ? '…' : esc(String(r.cells[c]))}</td>`).join('')}</tr>`).join('')}</tbody></table></details></td>`;
      }
      default: return `<td class="c">${esc(String(v))}</td>`;
    }
  }

  private draw(first = false) {
    const all = this.visible();
    const rows = all.slice(0, this.shown);
    const head = this.cols.map((c) => {
      const on = this.sort?.col === c;
      return `<th scope="col" aria-sort="${on ? (this.sort!.dir === 1 ? 'ascending' : 'descending') : 'none'}"><button type="button" class="th" data-sort="${esc(c)}"><span>${esc(this.labels[c] ?? c)}</span><i class="th__ar" aria-hidden="true">${on ? (this.sort!.dir === 1 ? '↑' : '↓') : ''}</i></button></th>`;
    }).join('');
    const body = rows.map((r, i) => `<tr style="--i:${Math.min(i, 20)}">${this.cols.map((c) => this.cell(r.cells[c], c)).join('')}</tr>`).join('');
    const hidden = all.length - rows.length;
    const more = !this.done && this.cursor && !this.q;
    const prevFilter = this.host.querySelector<HTMLInputElement>('[data-rfilter]');
    const hadFocus = document.activeElement === prevFilter;
    const sel = prevFilter?.selectionStart ?? 0;
    this.host.innerHTML = `<div class="rv${first ? ' rv--first' : ''}">
      <div class="rv__bar">
        <p class="rv__sum" role="status"><b>${formatNumber(all.length)}</b> ${all.length === this.rows.length ? `row${all.length === 1 ? '' : 's'}` : `of ${formatNumber(this.rows.length)} rows`}${this.total > this.rows.length ? ` <span class="rv__dim">· ${formatNumber(this.total)} in the org</span>` : ''}<span class="rv__dim"> · ${Math.round(this.ms)} ms</span></p>
        <label class="rv__f"><span class="sr-only">Filter results</span><input type="search" placeholder="Filter rows" value="${esc(this.q)}" data-rfilter autocomplete="off" /></label>
        <button class="btn btn--sm" type="button" data-csv>Download CSV</button>
        <button class="btn btn--sm" type="button" data-json>Copy JSON</button>
      </div>
      <div class="rv__scroll" tabindex="0" role="region" aria-label="Query results"><table class="rt"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>
        ${!all.length ? '<p class="rv__none">No rows match that filter.</p>' : ''}
        ${hidden > 0 ? `<div class="rv__foot"><button class="btn btn--sm" type="button" data-showmore>Show ${Math.min(CHUNK, hidden)} more rows <span class="rv__dim">(${formatNumber(hidden)} hidden)</span></button></div>` : ''}
        ${more && hidden <= 0 ? `<div class="rv__foot"><button class="btn btn--sm" type="button" data-more>${this.loadingMore ? 'Loading…' : `Load more from Salesforce (${formatNumber(this.total - this.rows.length)} left)`}</button></div>` : ''}
      </div></div>`;
    this.wire();
    if (hadFocus) { const f = this.host.querySelector<HTMLInputElement>('[data-rfilter]'); f?.focus(); f?.setSelectionRange(sel, sel); }
  }

  private wire() {
    const h = this.host;
    h.querySelectorAll<HTMLElement>('[data-sort]').forEach((b) => b.addEventListener('click', () => {
      const col = b.dataset.sort!;
      this.sort = !this.sort || this.sort.col !== col ? { col, dir: 1 } : this.sort.dir === 1 ? { col, dir: -1 } : null;
      this.draw();
    }));
    const f = h.querySelector<HTMLInputElement>('[data-rfilter]')!;
    f.addEventListener('input', () => { this.q = f.value; this.shown = CHUNK; this.draw(); });
    h.querySelector('[data-showmore]')?.addEventListener('click', () => { this.shown += CHUNK; this.draw(); });
    h.querySelector('[data-more]')?.addEventListener('click', () => void this.loadMore());
    h.querySelector('[data-csv]')?.addEventListener('click', () => this.download());
    h.querySelector('[data-json]')?.addEventListener('click', () => {
      const data = JSON.stringify(this.visible().map((r) => r.raw), null, 2);
      void navigator.clipboard?.writeText(data).then(() => this.hooks.toast('Copied rows as JSON'), () => this.hooks.toast('Copy was blocked by the browser'));
    });
    h.querySelectorAll<HTMLElement>('[data-copy]').forEach((b) => b.addEventListener('click', () => {
      void navigator.clipboard?.writeText(b.dataset.copy || '').then(() => this.hooks.toast('Copied Id'), () => {});
    }));
  }

  private download() {
    const rows = this.visible();
    const csv = toCsv(this.cols, rows);
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url; a.download = `query-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`;
    document.body.append(a); a.click(); a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 2000);
    this.hooks.toast(`Downloaded ${rows.length} row${rows.length === 1 ? '' : 's'}`);
  }

  private async loadMore() {
    if (this.loadingMore || !this.cursor) return;
    this.loadingMore = true; this.draw();
    try {
      const r = await this.hooks.onMore(this.cursor);
      this.rows = this.rows.concat(buildRows(r.records as Rec[]));
      this.done = r.done; this.cursor = r.nextCursor; this.shown = Math.max(this.shown, this.rows.length > CHUNK * 3 ? this.shown : this.rows.length);
      this.recomputeCols(); this.hooks.onCount?.(this.rows.length);
    } catch (e) { this.hooks.toast((e as Error).message); }
    this.loadingMore = false; this.draw();
  }
}
