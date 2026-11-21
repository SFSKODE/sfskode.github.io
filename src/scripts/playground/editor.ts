// A small code editor: a transparent <textarea> on top of a syntax-highlighted layer.
// The textarea stays the single source of truth (native selection, IME, mobile keyboards, undo); the layers just follow its scroll.
import { highlightHtml, type Lang } from './tokenize';
import { completionContext, rank, type Context, type Suggestion } from './complete';

export interface EditorOptions {
  lang: Lang;
  value?: string;
  placeholder?: string;
  label: string;
  onRun?: () => void;
  onSave?: () => void;
  onChange?: (value: string) => void;
  /** Return suggestions for a completion context (may be async). Results are ranked against the typed prefix here. */
  suggest?: (ctx: Context, lang: Lang) => Suggestion[] | Promise<Suggestion[]>;
}

const PAIRS: Record<string, string> = { '(': ')', '[': ']', '{': '}', "'": "'", '"': '"' };
const CLOSERS = new Set([')', ']', '}', "'", '"']);
const KIND_LABEL: Record<string, string> = { object: 'obj', field: 'fld', rel: 'rel', kw: 'key', fn: 'fn', class: 'cls', snippet: 'snip', value: 'val', lit: 'lit', member: 'mem' };

export class CodeEditor {
  readonly root: HTMLElement;
  private ta: HTMLTextAreaElement;
  private hl: HTMLElement;
  private code: HTMLElement;
  private gutter: HTMLElement;
  private cur: HTMLElement;
  private err: HTMLElement;
  private ac: HTMLUListElement;
  private opts: EditorOptions;
  private lh = 22;
  private cw = 8;
  private pad = 14;
  private acItems: Suggestion[] = [];
  private acIndex = 0;
  private acPrefixLen = 0;
  private acSeq = 0;
  private lines = 1;
  private errLine: number | null = null;

  constructor(host: HTMLElement, opts: EditorOptions) {
    this.opts = opts;
    host.innerHTML = '';
    this.root = document.createElement('div');
    this.root.className = 'ed';
    this.root.innerHTML = `
      <div class="ed__gutter" aria-hidden="true"><div class="ed__nums"></div></div>
      <div class="ed__body">
        <div class="ed__cur" aria-hidden="true"></div>
        <div class="ed__err" aria-hidden="true" hidden></div>
        <pre class="ed__hl" aria-hidden="true"><code></code></pre>
        <textarea class="ed__ta" spellcheck="false" autocomplete="off" autocapitalize="off" autocorrect="off" wrap="off" aria-multiline="true"></textarea>
      </div>
      <ul class="ed__ac" role="listbox" hidden></ul>`;
    host.append(this.root);
    this.ta = this.root.querySelector('.ed__ta')!;
    this.hl = this.root.querySelector('.ed__hl')!;
    this.code = this.hl.querySelector('code')!;
    this.gutter = this.root.querySelector('.ed__nums')!;
    this.cur = this.root.querySelector('.ed__cur')!;
    this.err = this.root.querySelector('.ed__err')!;
    this.ac = this.root.querySelector('.ed__ac')!;
    this.ta.setAttribute('aria-label', opts.label);
    if (opts.placeholder) this.ta.placeholder = opts.placeholder;
    this.ta.value = opts.value ?? '';
    this.ta.addEventListener('input', () => { this.render(); this.opts.onChange?.(this.ta.value); this.updateComplete(false); });
    this.ta.addEventListener('scroll', () => this.syncScroll(), { passive: true });
    this.ta.addEventListener('keydown', (e) => this.onKey(e));
    this.ta.addEventListener('keyup', (e) => { if (/Arrow(Left|Right)|Home|End/.test(e.key)) { this.moveCursorUi(); this.closeComplete(); } });
    this.ta.addEventListener('click', () => { this.moveCursorUi(); this.closeComplete(); });
    this.ta.addEventListener('blur', () => window.setTimeout(() => this.closeComplete(), 120));
    this.ta.addEventListener('focus', () => this.moveCursorUi());
    new ResizeObserver(() => { this.measure(); this.render(); }).observe(this.root);
    this.measure();
    this.render();
  }

  /* ------------------------------ public ------------------------------ */
  get value() { return this.ta.value; }
  set value(v: string) { this.ta.value = v; this.render(); this.opts.onChange?.(v); }
  get lang() { return this.opts.lang; }
  setLang(l: Lang) { this.opts.lang = l; this.render(); }
  focus() { this.ta.focus({ preventScroll: true }); }
  hasFocus() { return document.activeElement === this.ta; }
  setPlaceholder(p: string) { this.ta.placeholder = p; }
  get selectionStart() { return this.ta.selectionStart; }
  /** Insert text at the caret (or replace the selection). Keeps native undo working where the browser allows. */
  insertAtCursor(text: string) { this.focus(); this.replace(this.ta.selectionStart, this.ta.selectionEnd, text); }
  /** Replace the whole document in one undoable edit. */
  replaceAll(text: string) { this.focus(); this.replace(0, this.ta.value.length, text, text.length); this.ta.scrollTop = 0; this.ta.scrollLeft = 0; this.syncScroll(); }
  /** Mark a line (1-based) as having a problem. Pass null to clear. */
  setError(line: number | null, message = '') {
    this.errLine = line && line > 0 ? Math.min(line, this.lines) : null;
    this.err.hidden = this.errLine === null;
    if (this.errLine !== null) { this.err.title = message; this.layoutMarkers(); }
    this.renderGutter();
  }
  goToLine(line: number) {
    const lines = this.ta.value.split('\n');
    let pos = 0;
    for (let i = 0; i < Math.min(line - 1, lines.length); i++) pos += lines[i].length + 1;
    this.ta.setSelectionRange(pos, pos);
    this.ta.scrollTop = Math.max(0, (line - 3) * this.lh);
    this.focus();
  }

  /* ------------------------------ rendering ------------------------------ */
  private measure() {
    const cs = getComputedStyle(this.ta);
    this.lh = parseFloat(cs.lineHeight) || 22;
    this.pad = parseFloat(cs.paddingTop) || 14;
    const probe = document.createElement('span');
    probe.textContent = 'x'.repeat(40);
    probe.style.cssText = `position:absolute;visibility:hidden;white-space:pre;font:${cs.font};letter-spacing:${cs.letterSpacing}`;
    this.root.append(probe);
    this.cw = probe.getBoundingClientRect().width / 40 || 8;
    probe.remove();
  }

  private render() {
    const text = this.ta.value;
    // A trailing newline needs a visible empty last line in the highlight layer, otherwise heights drift.
    this.code.innerHTML = highlightHtml(text, this.opts.lang) + (text.endsWith('\n') ? ' ' : '');
    this.lines = text.split('\n').length;
    this.renderGutter();
    this.syncScroll();
    this.moveCursorUi();
    if (this.errLine !== null) { this.errLine = Math.min(this.errLine, this.lines); this.layoutMarkers(); }
  }

  private renderGutter() {
    let h = '';
    for (let i = 1; i <= this.lines; i++) h += `<span${i === this.errLine ? ' class="is-err"' : ''}>${i}</span>`;
    this.gutter.innerHTML = h;
    const width = String(this.lines).length;
    this.root.style.setProperty('--ed-gutter-ch', String(Math.max(2, width)));
  }

  private syncScroll() {
    const x = this.ta.scrollLeft, y = this.ta.scrollTop;
    this.hl.style.transform = `translate(${-x}px, ${-y}px)`;
    this.gutter.style.transform = `translateY(${-y}px)`;
    this.layoutMarkers();
    if (!this.ac.hidden) this.placePopup();
  }

  private caretLineCol() {
    const before = this.ta.value.slice(0, this.ta.selectionStart);
    const nl = before.lastIndexOf('\n');
    return { line: before.split('\n').length, col: before.length - nl - 1 };
  }

  private layoutMarkers() {
    const y = this.ta.scrollTop;
    this.cur.style.transform = `translateY(${this.pad + (this.caretLineCol().line - 1) * this.lh - y}px)`;
    this.cur.style.height = `${this.lh}px`;
    if (this.errLine !== null) {
      this.err.style.transform = `translateY(${this.pad + (this.errLine - 1) * this.lh - y}px)`;
      this.err.style.height = `${this.lh}px`;
    }
  }

  private moveCursorUi() {
    this.cur.hidden = this.ta.selectionStart !== this.ta.selectionEnd || document.activeElement !== this.ta;
    this.layoutMarkers();
  }

  /* ------------------------------ editing ------------------------------ */
  private replace(start: number, end: number, text: string, selectStart?: number, selectEnd?: number) {
    this.ta.setSelectionRange(start, end);
    let done = false;
    try { done = document.execCommand('insertText', false, text); } catch { done = false; }
    if (!done || this.ta.value.slice(start, start + text.length) !== text) {
      this.ta.setRangeText(text, start, end, 'end');
      this.ta.dispatchEvent(new Event('input', { bubbles: true }));
    }
    if (selectStart !== undefined) this.ta.setSelectionRange(selectStart, selectEnd ?? selectStart);
    this.moveCursorUi();
  }

  private lineBounds(pos: number) {
    const v = this.ta.value;
    const s = v.lastIndexOf('\n', pos - 1) + 1;
    let e = v.indexOf('\n', pos);
    if (e === -1) e = v.length;
    return { s, e };
  }

  private onKey(e: KeyboardEvent) {
    const ta = this.ta;
    const mod = e.ctrlKey || e.metaKey;
    if (!this.ac.hidden) {
      if (e.key === 'ArrowDown') { e.preventDefault(); this.pick(this.acIndex + 1); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); this.pick(this.acIndex - 1); return; }
      if ((e.key === 'Enter' || e.key === 'Tab') && !mod && !e.shiftKey) { e.preventDefault(); this.applySuggestion(this.acIndex); return; }
      if (mod && e.key === 'Enter') this.closeComplete();
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.closeComplete(); return; }
    }
    if (mod && e.key === 'Enter') { e.preventDefault(); this.opts.onRun?.(); return; }
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); this.opts.onSave?.(); return; }
    if (mod && e.key === ' ') { e.preventDefault(); this.updateComplete(true); return; }
    if (mod && e.key === '/') { e.preventDefault(); this.toggleComment(); return; }
    const { selectionStart: a, selectionEnd: b, value: v } = ta;

    if (e.key === 'Tab' && !mod && !e.altKey) {
      e.preventDefault();
      if (a !== b && v.slice(a, b).includes('\n')) { this.indentLines(e.shiftKey); return; }
      if (e.shiftKey) { this.indentLines(true); return; }
      this.replace(a, b, '  ');
      return;
    }
    if (e.key === 'Enter' && !mod && !e.shiftKey) {
      const { s } = this.lineBounds(a);
      const line = v.slice(s, a);
      const indent = /^[ \t]*/.exec(line)![0];
      const prev = v[a - 1], next = v[a];
      e.preventDefault();
      if (prev === '{' && next === '}') this.replace(a, b, `\n${indent}  \n${indent}`, a + 1 + indent.length + 2);
      else this.replace(a, b, `\n${indent}${/[{(\[]\s*$/.test(line) ? '  ' : ''}`);
      return;
    }
    if (e.key === 'Backspace' && a === b && a > 0 && PAIRS[v[a - 1]] && PAIRS[v[a - 1]] === v[a]) {
      e.preventDefault(); this.replace(a - 1, a + 1, ''); return;
    }
    if (!mod && !e.altKey && e.key.length === 1) {
      const ch = e.key;
      if (CLOSERS.has(ch) && a === b && v[a] === ch && (ch !== "'" && ch !== '"' || /[\w]/.test(v[a - 1] ?? '') === false || v[a] === ch)) { e.preventDefault(); ta.setSelectionRange(a + 1, a + 1); return; }
      if (PAIRS[ch]) {
        const close = PAIRS[ch];
        const quote = ch === "'" || ch === '"';
        const prevWord = /\w/.test(v[a - 1] ?? '');
        if (a !== b) { e.preventDefault(); this.replace(a, b, ch + v.slice(a, b) + close, a + 1, b + 1); return; }
        if (quote && prevWord) return; // apostrophe inside a word
        if (!quote && /\w/.test(v[a] ?? '')) return;
        e.preventDefault(); this.replace(a, b, ch + close, a + 1);
      }
    }
  }

  private indentLines(outdent: boolean) {
    const ta = this.ta;
    const { s } = this.lineBounds(ta.selectionStart);
    const { e } = this.lineBounds(Math.max(ta.selectionStart, ta.selectionEnd - (ta.selectionEnd > ta.selectionStart && ta.value[ta.selectionEnd - 1] === '\n' ? 1 : 0)));
    const block = ta.value.slice(s, e);
    const next = block.split('\n').map((l) => (outdent ? l.replace(/^( {1,2}|\t)/, '') : '  ' + l)).join('\n');
    this.replace(s, e, next, s, s + next.length);
  }

  private toggleComment() {
    const ta = this.ta;
    const { s } = this.lineBounds(ta.selectionStart);
    const { e } = this.lineBounds(ta.selectionEnd);
    const lines = ta.value.slice(s, e).split('\n');
    const all = lines.filter((l) => l.trim()).every((l) => /^\s*\/\//.test(l));
    const next = lines.map((l) => (!l.trim() ? l : all ? l.replace(/^(\s*)\/\/ ?/, '$1') : l.replace(/^(\s*)/, '$1// '))).join('\n');
    this.replace(s, e, next, s, s + next.length);
  }

  /* ------------------------------ autocomplete ------------------------------ */
  private async updateComplete(force: boolean) {
    if (!this.opts.suggest || !this.hasFocus()) return;
    const pos = this.ta.selectionStart;
    if (this.ta.selectionEnd !== pos) return this.closeComplete();
    const ctx = completionContext(this.ta.value, pos, this.opts.lang);
    if (!ctx) return this.closeComplete();
    const typed = ctx.kind === 'apex' ? ctx.prefix : ctx.prefix;
    const hasDot = ctx.kind === 'apex' ? !!ctx.qualifier : ctx.kind === 'soql' && ctx.path.length > 0;
    if (!force && !typed && !hasDot && !(ctx.kind === 'soql' && ctx.clause === 'from-object')) return this.closeComplete();
    const seq = ++this.acSeq;
    let list: Suggestion[] = [];
    try { list = await this.opts.suggest(ctx, this.opts.lang); } catch { list = []; }
    if (seq !== this.acSeq) return;
    list = rank(list, typed, 40).filter((s) => !(typed && (s.insert ?? s.label) === typed && list.length === 1));
    if (!list.length) return this.closeComplete();
    this.acItems = list;
    this.acPrefixLen = typed.length;
    this.acIndex = 0;
    this.ac.innerHTML = list.map((s, i) => `<li role="option" id="ac-${i}" aria-selected="${i === 0}" data-i="${i}"><span class="ed__k ed__k--${s.kind}">${KIND_LABEL[s.kind] ?? ''}</span><span class="ed__l">${esc(s.label)}</span>${s.detail ? `<span class="ed__d">${esc(s.detail)}</span>` : ''}</li>`).join('');
    this.ac.hidden = false;
    this.ta.setAttribute('aria-activedescendant', 'ac-0');
    this.ac.onmousedown = (ev) => { ev.preventDefault(); const li = (ev.target as HTMLElement).closest('li'); if (li) this.applySuggestion(Number(li.dataset.i)); };
    this.placePopup();
  }

  private placePopup() {
    const { line, col } = this.caretLineCol();
    const gw = (this.root.querySelector('.ed__gutter') as HTMLElement).offsetWidth;
    const x = gw + 14 + (col - this.acPrefixLen) * this.cw - this.ta.scrollLeft;
    const y = this.pad + line * this.lh - this.ta.scrollTop;
    const w = this.ac.offsetWidth || 280;
    this.ac.style.left = `${Math.max(8, Math.min(x, this.root.clientWidth - w - 8))}px`;
    const h = this.ac.offsetHeight || 200;
    const below = y + h < this.root.clientHeight || y - this.lh - h < 0;
    this.ac.style.top = `${below ? y : y - this.lh - h}px`;
  }

  private pick(i: number) {
    const n = this.acItems.length;
    this.acIndex = (i + n) % n;
    this.ac.querySelectorAll('li').forEach((li, k) => li.setAttribute('aria-selected', String(k === this.acIndex)));
    const li = this.ac.children[this.acIndex] as HTMLElement;
    li.scrollIntoView({ block: 'nearest' });
    this.ta.setAttribute('aria-activedescendant', li.id);
  }

  private applySuggestion(i: number) {
    const s = this.acItems[i];
    if (!s) return;
    const pos = this.ta.selectionStart;
    const text = s.insert ?? s.label;
    this.closeComplete();
    this.replace(pos - this.acPrefixLen, pos, text, pos - this.acPrefixLen + text.length - (s.cursorBack ?? 0));
  }

  closeComplete() {
    this.acSeq++;
    if (this.ac.hidden) return;
    this.ac.hidden = true;
    this.ta.removeAttribute('aria-activedescendant');
  }
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
