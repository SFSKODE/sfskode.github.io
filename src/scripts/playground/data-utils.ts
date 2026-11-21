// Pure helpers for query results: flattening, type-aware formatting, sorting, CSV, SOQL parsing and error positions.

export type Rec = Record<string, unknown>;
export interface SubResult { __sub: true; records: Rec[]; totalSize: number }
export type Cell = string | number | boolean | null | SubResult | undefined;
export type Row = { raw: Rec; cells: Record<string, Cell> };

const isObj = (v: unknown): v is Rec => !!v && typeof v === 'object' && !Array.isArray(v);

/** Flatten nested relationship objects into dotted keys: { Account: { Name: 'x' } } -> { 'Account.Name': 'x' }. */
export function flattenRecord(rec: Rec, prefix = '', out: Record<string, Cell> = {}): Record<string, Cell> {
  for (const [k, v] of Object.entries(rec)) {
    if (k === 'attributes') continue;
    const key = prefix ? `${prefix}.${k}` : k;
    if (isObj(v)) {
      if (Array.isArray((v as Rec).records)) {
        out[key] = { __sub: true, records: (v as Rec).records as Rec[], totalSize: Number((v as Rec).totalSize ?? ((v as Rec).records as unknown[]).length) };
      } else flattenRecord(v, key, out);
    } else if (Array.isArray(v)) {
      out[key] = { __sub: true, records: v as Rec[], totalSize: v.length };
    } else out[key] = v as Cell;
  }
  return out;
}

export function buildRows(records: Rec[]): Row[] {
  return records.map((raw) => ({ raw, cells: flattenRecord(raw) }));
}

/** Union of keys in order of first appearance. A relationship that was null everywhere does not get its own column when children exist. */
export function collectColumns(rows: Row[], limit = 200): string[] {
  const cols: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < Math.min(rows.length, limit); i++) {
    for (const k of Object.keys(rows[i].cells)) if (!seen.has(k)) { seen.add(k); cols.push(k); }
  }
  return cols.filter((c) => {
    if (!cols.some((o) => o.startsWith(c + '.'))) return true;
    return rows.slice(0, limit).some((r) => r.cells[c] != null);
  });
}

/* ---------------------------- SOQL text helpers ---------------------------- */

/** Blank out // and block comments but keep every newline and column so error positions still line up. */
export function stripSoqlComments(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== "'" && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') { out += ' '; i++; }
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const close = src.indexOf('*/', i + 2);
      const end = close < 0 ? src.length : close + 2;
      out += src.slice(i, end).replace(/[^\n]/g, ' ');
      i = end;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Split `s` on commas that sit at bracket depth 0 and outside strings. */
function splitTop(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'") {
      let j = i + 1;
      while (j < s.length && s[j] !== "'") j += s[j] === '\\' ? 2 : 1;
      cur += s.slice(i, j + 1);
      i = j;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') depth--;
    if (c === ',' && depth === 0) { parts.push(cur); cur = ''; } else cur += c;
  }
  if (cur.trim()) parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** Index of the first top-level keyword (depth 0, outside strings) at or after `from`, or -1. */
export function findTopLevel(src: string, word: RegExp, from = 0): number {
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    const c = src[i];
    if (c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== "'") j += src[j] === '\\' ? 2 : 1;
      i = j;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (depth === 0 && /[A-Za-z]/.test(c) && (i === 0 || !/[A-Za-z0-9_.]/.test(src[i - 1]))) {
      const m = word.exec(src.slice(i, i + 24));
      if (m && m.index === 0) return i;
    }
  }
  return -1;
}

export interface SelectItem { text: string; alias: string | null; isAgg: boolean; isSub: boolean; key: string }
const AGG = /^(COUNT|COUNT_DISTINCT|SUM|AVG|MIN|MAX|GROUPING|CALENDAR_(?:MONTH|QUARTER|YEAR)|DAY_(?:IN_MONTH|IN_WEEK|IN_YEAR|ONLY)|FISCAL_(?:MONTH|QUARTER|YEAR)|HOUR_IN_DAY|WEEK_IN_(?:MONTH|YEAR))\s*\(/i;

export function parseSelectList(soql: string): SelectItem[] {
  const src = stripSoqlComments(soql);
  const s = findTopLevel(src, /^SELECT\b/i);
  if (s < 0) return [];
  const f = findTopLevel(src, /^FROM\b/i, s + 6);
  const body = src.slice(s + 6, f < 0 ? src.length : f);
  let n = 0;
  return splitTop(body).map((text) => {
    const isSub = /^\(\s*SELECT\b/i.test(text);
    const am = /^(.*\))\s+(?:AS\s+)?([A-Za-z_][A-Za-z0-9_]*)$/is.exec(text);
    const isAgg = !isSub && AGG.test(text);
    let alias: string | null = null;
    if (am && !isSub) alias = am[2];
    else if (!isSub && !AGG.test(text)) {
      const fm = /^([A-Za-z_][\w.]*)\s+(?:AS\s+)?([A-Za-z_]\w*)$/i.exec(text);
      if (fm) alias = fm[2];
    }
    let key = alias ?? text;
    if (isAgg && !alias) key = `expr${n++}`;
    if (isSub) {
      const rm = /\bFROM\s+([A-Za-z_]\w*)/i.exec(text);
      key = rm ? rm[1] : text;
    }
    return { text, alias, isAgg, isSub, key };
  });
}

/** Display labels for aggregate columns: expr0 -> COUNT(Id). */
export function columnLabels(cols: string[], soql: string): Record<string, string> {
  const labels: Record<string, string> = {};
  const items = parseSelectList(soql);
  for (const it of items) if (it.isAgg && !it.alias) labels[it.key] = it.text.replace(/\s+/g, ' ');
  for (const c of cols) if (!labels[c]) labels[c] = c;
  return labels;
}

export function isCountOnly(soql: string): boolean {
  const it = parseSelectList(soql);
  return it.length === 1 && /^COUNT\s*\(\s*\)$/i.test(it[0].text) && !it[0].alias;
}

/** The FROM object of the outermost SELECT (first top-level FROM). */
export function parseFromObject(soql: string): string | null {
  const src = stripSoqlComments(soql);
  const s = findTopLevel(src, /^SELECT\b/i);
  if (s < 0) return null;
  const f = findTopLevel(src, /^FROM\b/i, s + 6);
  if (f < 0) return null;
  const m = /^FROM\s+([A-Za-z_][A-Za-z0-9_]*)/i.exec(src.slice(f));
  return m ? m[1] : null;
}

/** Row/column from a Salesforce error message ("ERROR at Row:1:Column:12"). */
export function errorPosition(message: string): { line: number; col: number } | null {
  const m = /Row:(\d+):Column:(\d+)/i.exec(message ?? '');
  if (m) return { line: Number(m[1]), col: Number(m[2]) };
  const m2 = /(?:line|Line)\s+(\d+)\s*,?\s*(?:column|col|Column)\s+(\d+)/.exec(message ?? '');
  return m2 ? { line: Number(m2[1]), col: Number(m2[2]) } : null;
}

/* ------------------------------ Formatting ------------------------------ */

export type CellKind = 'null' | 'bool' | 'num' | 'id' | 'date' | 'datetime' | 'sub' | 'text';
const ID_RE = /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/;

export function cellKind(v: Cell, col: string, fieldType?: string): CellKind {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'object') return 'sub';
  if (typeof v === 'boolean') return 'bool';
  if (typeof v === 'number') return 'num';
  const s = String(v);
  if (fieldType === 'date' && DATE_ONLY.test(s)) return 'date';
  if (fieldType === 'datetime' && DATETIME.test(s)) return 'datetime';
  if ((fieldType === 'id' || fieldType === 'reference' || /(^|\.)(Id|[A-Za-z]+Id)$/.test(col)) && ID_RE.test(s) && /\d/.test(s)) return 'id';
  if (DATE_ONLY.test(s)) return 'date';
  if (DATETIME.test(s)) return 'datetime';
  return 'text';
}

export function formatDate(s: string, locale?: string): string {
  const m = DATE_ONLY.exec(s);
  if (m) {
    const d = new Date(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)));
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(d);
  }
  return s;
}

export function formatDateTime(s: string, locale?: string): string {
  const d = new Date(s.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  if (Number.isNaN(d.getTime())) return s;
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(d);
}

export function shortId(id: string): string {
  return id.length > 10 ? `${id.slice(0, 5)}…${id.slice(-3)}` : id;
}

export function formatNumber(n: number): string {
  return Number.isInteger(n) ? n.toLocaleString('en-US') : n.toLocaleString('en-US', { maximumFractionDigits: 4 });
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function timeAgo(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return `${d} d ago`;
}

/* -------------------------------- Sorting -------------------------------- */

export function compareCells(a: Cell, b: Cell): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  if (typeof a === 'object' && typeof b === 'object' && a && b) return (a as SubResult).totalSize - (b as SubResult).totalSize;
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

/** Stable sort by a column; nulls always sink to the bottom. dir: 1 ascending, -1 descending. */
export function sortRows(rows: Row[], col: string, dir: 1 | -1): Row[] {
  const idx = rows.map((r, i) => [r, i] as const);
  idx.sort(([a, ai], [b, bi]) => {
    const x = a.cells[col];
    const y = b.cells[col];
    const xn = x === null || x === undefined;
    const yn = y === null || y === undefined;
    if (xn || yn) return xn && yn ? ai - bi : xn ? 1 : -1;
    return compareCells(x, y) * dir || ai - bi;
  });
  return idx.map(([r]) => r);
}

export function filterRows(rows: Row[], cols: string[], q: string): Row[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return rows;
  return rows.filter((r) => cols.some((c) => {
    const v = r.cells[c];
    if (v === null || v === undefined) return false;
    if (typeof v === 'object') return false;
    return String(v).toLowerCase().includes(needle);
  }));
}

/* ---------------------------------- CSV ---------------------------------- */

export function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return '';
  let s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (/[",\r\n]/.test(s) || /^\s|\s$/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

export function toCsv(cols: string[], rows: Row[], withBom = true): string {
  const lines = [cols.map(csvEscape).join(',')];
  for (const r of rows) {
    lines.push(cols.map((c) => {
      const v = r.cells[c];
      if (v && typeof v === 'object') return csvEscape((v as SubResult).records);
      return csvEscape(v);
    }).join(','));
  }
  return (withBom ? '﻿' : '') + lines.join('\r\n') + '\r\n';
}

/* ----------------------------- Misc small bits ----------------------------- */

export function firstLine(code: string, max = 90): string {
  const l = code.split('\n').map((s) => s.trim()).find((s) => s && !s.startsWith('//')) ?? code.trim();
  return l.length > max ? l.slice(0, max - 1) + '…' : l;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
