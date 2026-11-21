// Debug log viewer: summary cards, limit meters, filters, search, collapsible call tree, raw view.
import { parseLog, matchesFilter, entryText, userDebugLevel, formatMs, type LogNode, type LogEntry, type LogFilter, type ParsedLog } from './log-parser';
import { escapeHtml as esc, formatBytes } from './data-utils';

const FILTERS: [LogFilter, string][] = [['all', 'Everything'], ['debug', 'USER_DEBUG'], ['errors', 'Errors'], ['soql', 'SOQL'], ['dml', 'DML'], ['limits', 'Limits']];

export class LogView {
  private host: HTMLElement;
  private raw = '';
  private p: ParsedLog | null = null;
  private filter: LogFilter = 'debug';
  private q = '';
  private mode: 'tree' | 'raw' = 'tree';
  private toast: (m: string) => void;
  constructor(host: HTMLElement, toast: (m: string) => void) { this.host = host; this.toast = toast; this.empty(); }

  empty() {
    this.host.innerHTML = `<div class="pgx"><div class="pgx__art" aria-hidden="true"><svg viewBox="0 0 120 80" width="120" height="80" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="12" y="8" width="96" height="64" rx="8"/><path d="M26 24h40M26 36h58M26 48h30M26 60h48"/></svg></div><h3>The debug log shows up here</h3><p>Run Apex and every <code>System.debug</code>, query and DML statement is listed in order.</p></div>`;
  }
  loading() { this.host.innerHTML = `<div class="pgx pgx--load" role="status"><div class="pgsk">${'<i></i>'.repeat(5)}</div><p>Running Apex…</p></div>`; }
  get hasErrors() { return (this.p?.counts.errors ?? 0) > 0; }

  show(log: string, truncated = false) {
    this.raw = log; this.p = parseLog(log);
    const hasDebug = this.p.counts.debug > 0;
    this.filter = hasDebug ? 'debug' : 'all'; this.q = ''; this.mode = 'tree';
    this.draw(truncated);
  }
  entryCount() { return this.p?.counts.debug ?? 0; }

  private draw(truncated = false) {
    const p = this.p!;
    if (!p.entries.length) { this.host.innerHTML = `<div class="pgx"><h3>No log lines came back</h3><p>Raise the log level, or make sure your code calls <code>System.debug</code>.</p></div>`; return; }
    const cards = [
      ['SOQL queries', p.counts.soql, `${p.soqlRows} rows`], ['DML statements', p.counts.dml, ''], ['Debug lines', p.counts.debug, ''],
      ['CPU time', p.cpuMs != null ? `${p.cpuMs} ms` : '—', p.cpuMax ? `of ${p.cpuMax.toLocaleString()}` : ''], ['Duration', formatMs(p.totalMs), ''],
    ].map(([l, v, s]) => `<div class="lcard"><span>${l}</span><b>${v}</b>${s ? `<small>${s}</small>` : ''}</div>`).join('');
    const lim = p.limits.filter((l) => l.max > 0).slice(0, 8).map((l) => { const pct = Math.min(100, (l.used / l.max) * 100); return `<li class="${pct > 80 ? 'is-hot' : ''}"><span>${esc(l.label)}</span><i style="--p:${pct.toFixed(1)}%"></i><b>${l.used.toLocaleString()} / ${l.max.toLocaleString()}</b></li>`; }).join('');
    this.host.innerHTML = `<div class="lv">
      <div class="lv__cards">${cards}</div>
      ${lim ? `<details class="lv__lim"><summary>Governor limits used</summary><ul>${lim}</ul></details>` : ''}
      <div class="lv__bar">
        <div class="lv__chips" role="group" aria-label="Filter log">${FILTERS.map(([f, l]) => `<button type="button" class="chipf" aria-pressed="${this.filter === f}" data-f="${f}">${l}${f !== 'all' ? ` <i>${this.countFor(f)}</i>` : ''}</button>`).join('')}</div>
        <label class="rv__f"><span class="sr-only">Search the log</span><input type="search" placeholder="Search log" value="${esc(this.q)}" data-lq autocomplete="off"/></label>
        <div class="pg__seg" role="group" aria-label="View"><button type="button" aria-pressed="${this.mode === 'tree'}" data-mode="tree">Timeline</button><button type="button" aria-pressed="${this.mode === 'raw'}" data-mode="raw">Raw</button></div>
        <button class="btn btn--sm" type="button" data-lcopy>Copy</button><button class="btn btn--sm" type="button" data-ldl>Download</button>
      </div>
      ${truncated ? '<p class="lv__warn">The log was longer than 2 MB and has been cut.</p>' : ''}
      <div class="lv__body" tabindex="0" role="region" aria-label="Debug log lines">${this.mode === 'raw' ? this.rawHtml() : this.listHtml()}</div>
      <p class="lv__foot">${p.entries.length.toLocaleString()} lines · ${formatBytes(new Blob([this.raw]).size)}</p></div>`;
    this.wire();
  }

  private countFor(f: LogFilter) { return this.p!.entries.filter((e) => matchesFilter(e, f)).length; }
  private hit(e: LogEntry) { return !this.q || e.raw.toLowerCase().includes(this.q.toLowerCase()); }
  private mark(s: string) { const t = esc(s); if (!this.q) return t; const re = new RegExp(`(${this.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'ig'); return esc(s).replace(re, '<mark class="hit">$1</mark>').replace(/&lt;mark class="hit"&gt;/g, '<mark class="hit">').replace(/&lt;\/mark&gt;/g, '</mark>'); }

  private line(e: LogEntry, depth = 0, dur: number | null = null): string {
    const k = e.kind;
    const line = /^\[(\d+)\]/.exec(e.fields[0] ?? '')?.[1];
    const lvl = e.event === 'USER_DEBUG' ? `<span class="lvl lvl--${userDebugLevel(e).toLowerCase()}">${userDebugLevel(e)}</span>` : `<span class="evt">${esc(e.event.replace(/_/g, ' ').toLowerCase())}</span>`;
    return `<div class="ll ll--${k}" style="--d:${depth}"><time>${esc(e.time.slice(0, 12))}</time>${lvl}<span class="ll__t">${this.mark(entryText(e))}</span>${line ? `<span class="ll__ln">line ${line}</span>` : ''}${dur != null && dur >= 0.05 ? `<span class="ll__d">${formatMs(dur)}</span>` : ''}</div>`;
  }

  private listHtml(): string {
    const p = this.p!;
    if (this.filter !== 'all' || this.q) {
      const items = p.entries.filter((e) => matchesFilter(e, this.filter) && this.hit(e) && !/_END$|_FINISHED$|_EXIT$/.test(e.event) || (this.filter === 'all' && this.hit(e)));
      if (!items.length) return '<p class="lv__none">Nothing matches. Try another filter.</p>';
      return items.map((e) => this.line(e)).join('');
    }
    const walk = (n: LogNode): string => {
      const own = this.line(n.entry, n.depth, n.durMs);
      if (!n.children.length) return own;
      return `<details class="ln" ${n.depth < 2 ? 'open' : ''}><summary>${own}</summary>${n.children.map(walk).join('')}</details>`;
    };
    return p.roots.map(walk).join('') || p.entries.map((e) => this.line(e)).join('');
  }
  private rawHtml() { return `<pre class="lv__raw">${this.mark(this.raw)}</pre>`; }

  private wire() {
    const h = this.host;
    h.querySelectorAll<HTMLElement>('[data-f]').forEach((b) => b.addEventListener('click', () => { this.filter = b.dataset.f as LogFilter; this.mode = 'tree'; this.draw(); }));
    h.querySelectorAll<HTMLElement>('[data-mode]').forEach((b) => b.addEventListener('click', () => { this.mode = b.dataset.mode as 'tree' | 'raw'; this.draw(); }));
    const q = h.querySelector<HTMLInputElement>('[data-lq]')!;
    q.addEventListener('input', () => { this.q = q.value; const pos = q.selectionStart ?? 0; this.draw(); const n = h.querySelector<HTMLInputElement>('[data-lq]')!; n.focus(); n.setSelectionRange(pos, pos); });
    h.querySelector('[data-lcopy]')?.addEventListener('click', () => void navigator.clipboard?.writeText(this.raw).then(() => this.toast('Copied the log'), () => this.toast('Copy was blocked')));
    h.querySelector('[data-ldl]')?.addEventListener('click', () => {
      const url = URL.createObjectURL(new Blob([this.raw], { type: 'text/plain' }));
      const a = document.createElement('a'); a.href = url; a.download = 'apex-debug.log'; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1500);
    });
  }
}
