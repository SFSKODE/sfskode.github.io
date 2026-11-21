// Syntax tokenizers for Apex and SOQL. Pure functions, no DOM access.
// Every character of the input ends up in exactly one token, so joining token text reproduces the source.

export type TokType = 'kw' | 'ty' | 'fn' | 'st' | 'cm' | 'nu' | 'an' | 'bind' | 'lit' | 'op' | 'id' | 'ws';
export interface Token { t: TokType; s: string }
export type Lang = 'apex' | 'soql';

const set = (s: string) => new Set(s.split(/\s+/).filter(Boolean));

export const APEX_KEYWORDS = set(`abstract after before break case catch class continue default delete do else enum extends false final finally for get global
  if implements inherited instanceof insert interface merge new null on override private protected public return set static super switch testmethod this
  throw transient trigger true try undelete update upsert virtual void webservice when while with without sharing`);

export const APEX_TYPES = set(`String Integer Long Decimal Double Boolean Date Datetime Time Id Blob Object List Set Map SObject Database System Schema Limits
  Math JSON Test Trigger Savepoint Exception DmlException QueryException Pattern Matcher UserInfo Url EncodingUtil Crypto Http HttpRequest HttpResponse
  Messaging Apexpages ApexPages Type Iterable Iterator Comparable Queueable Schedulable Database.Batchable`);

const SOQL_KEYWORDS = set(`SELECT FROM WHERE AND OR NOT IN LIKE INCLUDES EXCLUDES ORDER BY GROUP HAVING LIMIT OFFSET ASC DESC NULLS FIRST LAST FOR VIEW REFERENCE UPDATE
  WITH SECURITY_ENFORCED USER_MODE SYSTEM_MODE TYPEOF WHEN THEN ELSE END ALL ROWS USING SCOPE ROLLUP CUBE AS TRUE FALSE NULL DATA CATEGORY ABOVE BELOW AT
  ABOVE_OR_BELOW SNIPPET TRACKING UPDATE_TRACKING UPDATE_VIEWSTAT DISTANCE GEOLOCATION FIND IN NAME FIELDS EMAIL PHONE SIDEBAR RETURNING NETWORK PRICEBOOKID
  METADATA SPELL_CORRECTION`);

const SOQL_FUNCS = set(`COUNT COUNT_DISTINCT SUM AVG MIN MAX FORMAT TOLABEL CONVERTCURRENCY CONVERTTIMEZONE CALENDAR_MONTH CALENDAR_QUARTER CALENDAR_YEAR DAY_IN_MONTH
  DAY_IN_WEEK DAY_IN_YEAR DAY_ONLY FISCAL_MONTH FISCAL_QUARTER FISCAL_YEAR HOUR_IN_DAY WEEK_IN_MONTH WEEK_IN_YEAR GROUPING DISTANCE GEOLOCATION`);

const DATE_LITERALS = set(`YESTERDAY TODAY TOMORROW LAST_WEEK THIS_WEEK NEXT_WEEK LAST_MONTH THIS_MONTH NEXT_MONTH LAST_90_DAYS NEXT_90_DAYS LAST_QUARTER THIS_QUARTER
  NEXT_QUARTER LAST_YEAR THIS_YEAR NEXT_YEAR LAST_FISCAL_QUARTER THIS_FISCAL_QUARTER NEXT_FISCAL_QUARTER LAST_FISCAL_YEAR THIS_FISCAL_YEAR NEXT_FISCAL_YEAR`);
const DATE_N_LITERALS = set(`LAST_N_DAYS NEXT_N_DAYS N_DAYS_AGO NEXT_N_WEEKS LAST_N_WEEKS N_WEEKS_AGO NEXT_N_MONTHS LAST_N_MONTHS N_MONTHS_AGO NEXT_N_QUARTERS LAST_N_QUARTERS
  N_QUARTERS_AGO NEXT_N_YEARS LAST_N_YEARS N_YEARS_AGO NEXT_N_FISCAL_QUARTERS LAST_N_FISCAL_QUARTERS N_FISCAL_QUARTERS_AGO NEXT_N_FISCAL_YEARS LAST_N_FISCAL_YEARS N_FISCAL_YEARS_AGO`);

export const SOQL_KEYWORD_LIST = [...SOQL_KEYWORDS].filter((k) => !['TRUE', 'FALSE', 'NULL'].includes(k));
export const SOQL_FUNCTION_LIST = ['COUNT', 'COUNT_DISTINCT', 'SUM', 'AVG', 'MIN', 'MAX', 'FORMAT', 'toLabel', 'convertCurrency', 'CALENDAR_YEAR', 'CALENDAR_MONTH',
  'DAY_ONLY', 'FISCAL_QUARTER', 'FISCAL_YEAR', 'HOUR_IN_DAY'];
export const DATE_LITERAL_LIST = [...DATE_LITERALS, 'LAST_N_DAYS:30', 'NEXT_N_DAYS:7', 'LAST_N_MONTHS:3'];

const isWordStart = (c: string) => /[A-Za-z_]/.test(c);
const isWord = (c: string) => /[A-Za-z0-9_]/.test(c);
const isDigit = (c: string) => c >= '0' && c <= '9';

const DATE_RE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?/;

function push(out: Token[], t: TokType, s: string) {
  if (!s) return;
  const last = out[out.length - 1];
  if (last && last.t === t && (t === 'ws' || t === 'op' || t === 'id')) last.s += s;
  else out.push({ t, s });
}

/** Scan a quoted string starting at i (text[i] === "'"). Stops at the closing quote or end of line. Returns the end index. */
function scanString(text: string, i: number, end: number): number {
  let j = i + 1;
  while (j < end) {
    const c = text[j];
    if (c === '\\') { j += 2; continue; }
    if (c === "'") return j + 1;
    if (c === '\n') return j;
    j++;
  }
  return Math.min(j, end);
}

/** Tokenize text[start,end) as SOQL (also used for inline Apex queries). */
function soqlRange(text: string, start: number, end: number, out: Token[], allowComments: boolean) {
  let i = start;
  let prevWord = '';
  while (i < end) {
    const c = text[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      let j = i + 1;
      while (j < end && /[ \t\r\n]/.test(text[j])) j++;
      push(out, 'ws', text.slice(i, j));
      i = j;
      continue;
    }
    if (allowComments && c === '/' && text[i + 1] === '/') {
      let j = i;
      while (j < end && text[j] !== '\n') j++;
      push(out, 'cm', text.slice(i, j));
      i = j;
      continue;
    }
    if (allowComments && c === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      const j = close < 0 || close + 2 > end ? end : close + 2;
      push(out, 'cm', text.slice(i, j));
      i = j;
      continue;
    }
    if (c === "'") {
      const j = scanString(text, i, end);
      push(out, 'st', text.slice(i, j));
      i = j;
      prevWord = '';
      continue;
    }
    if (c === ':') {
      // Bind variable (Apex) or the colon of LAST_N_DAYS:30 (handled with the word).
      const m = /^:\s*[A-Za-z_][A-Za-z0-9_]*(?:\s*\.\s*[A-Za-z_][A-Za-z0-9_]*)*(?:\(\))?/.exec(text.slice(i, Math.min(end, i + 200)));
      if (m) { push(out, 'bind', m[0]); i += m[0].length; continue; }
      push(out, 'op', c);
      i++;
      continue;
    }
    if (isDigit(c)) {
      const dm = DATE_RE.exec(text.slice(i, Math.min(end, i + 40)));
      if (dm) { push(out, 'lit', dm[0]); i += dm[0].length; prevWord = ''; continue; }
      const nm = /^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i, Math.min(end, i + 40)))!;
      push(out, 'nu', nm[0]);
      i += nm[0].length;
      prevWord = '';
      continue;
    }
    if (isWordStart(c)) {
      let j = i + 1;
      while (j < end && isWord(text[j])) j++;
      const word = text.slice(i, j);
      const up = word.toUpperCase();
      let k = j;
      while (k < end && (text[k] === ' ' || text[k] === '\t')) k++;
      const nextParen = text[k] === '(';
      const prevDot = i > start && text[i - 1] === '.';
      if (!prevDot && DATE_N_LITERALS.has(up) && text[j] === ':') {
        const m = /^:\d+/.exec(text.slice(j, j + 12));
        if (m) { push(out, 'lit', word + m[0]); i = j + m[0].length; prevWord = ''; continue; }
      }
      if (!prevDot && DATE_LITERALS.has(up)) push(out, 'lit', word);
      else if (!prevDot && SOQL_FUNCS.has(up) && nextParen) push(out, 'fn', word);
      else if (!prevDot && SOQL_KEYWORDS.has(up)) push(out, 'kw', word);
      else if (prevWord === 'FROM' && !prevDot) push(out, 'ty', word);
      else push(out, 'id', word);
      prevWord = prevDot ? '' : up;
      i = j;
      continue;
    }
    push(out, 'op', c);
    i++;
  }
}

/** Find the end (exclusive, index of the closing bracket) of an inline query that starts right after `[`. */
function inlineQueryEnd(text: string, from: number): number {
  let depth = 0;
  let i = from;
  while (i < text.length) {
    const c = text[i];
    if (c === "'") { i = scanString(text, i, text.length); continue; }
    if (c === '[') depth++;
    else if (c === ']') { if (depth === 0) return i; depth--; }
    else if (c === ';' && depth === 0) return i;
    i++;
  }
  return text.length;
}

export function tokenizeSoql(text: string): Token[] {
  const out: Token[] = [];
  soqlRange(text, 0, text.length, out, true);
  return out;
}

export function tokenizeApex(text: string): Token[] {
  const out: Token[] = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      let j = i + 1;
      while (j < n && /[ \t\r\n]/.test(text[j])) j++;
      push(out, 'ws', text.slice(i, j));
      i = j;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      let j = i;
      while (j < n && text[j] !== '\n') j++;
      push(out, 'cm', text.slice(i, j));
      i = j;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      const j = close < 0 ? n : close + 2;
      push(out, 'cm', text.slice(i, j));
      i = j;
      continue;
    }
    if (c === "'") {
      const j = scanString(text, i, n);
      push(out, 'st', text.slice(i, j));
      i = j;
      continue;
    }
    if (c === '[') {
      const m = /^\[\s*(?:select|find)\b/i.exec(text.slice(i, i + 40));
      if (m) {
        const e = inlineQueryEnd(text, i + 1);
        push(out, 'op', '[');
        soqlRange(text, i + 1, e, out, false);
        if (text[e] === ']') push(out, 'op', ']');
        i = Math.min(n, e + (text[e] === ']' ? 1 : 0));
        continue;
      }
    }
    if (c === '@' && isWordStart(text[i + 1] ?? '')) {
      let j = i + 2;
      while (j < n && isWord(text[j])) j++;
      push(out, 'an', text.slice(i, j));
      i = j;
      continue;
    }
    if (isDigit(c) || (c === '.' && isDigit(text[i + 1] ?? ''))) {
      const m = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?[LlDd]?/.exec(text.slice(i, i + 40))!;
      push(out, 'nu', m[0]);
      i += m[0].length;
      continue;
    }
    if (isWordStart(c)) {
      let j = i + 1;
      while (j < n && isWord(text[j])) j++;
      const word = text.slice(i, j);
      const low = word.toLowerCase();
      let k = j;
      while (k < n && (text[k] === ' ' || text[k] === '\t')) k++;
      const prevDot = i > 0 && text[i - 1] === '.';
      if (!prevDot && APEX_KEYWORDS.has(low)) push(out, 'kw', word);
      else if (text[k] === '(') push(out, /^[A-Z]/.test(word) && !prevDot && /\bnew\s+$/.test(text.slice(Math.max(0, i - 8), i)) ? 'ty' : 'fn', word);
      else if (APEX_TYPES.has(word) || /^[A-Z]/.test(word)) push(out, 'ty', word);
      else push(out, 'id', word);
      i = j;
      continue;
    }
    push(out, 'op', c);
    i++;
  }
  return out;
}

export function tokenize(text: string, lang: Lang): Token[] {
  return lang === 'apex' ? tokenizeApex(text) : tokenizeSoql(text);
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** HTML for the highlight layer. Whitespace-only and plain tokens carry no span to keep the DOM small. */
export function highlightHtml(text: string, lang: Lang): string {
  const toks = tokenize(text, lang);
  let h = '';
  for (const k of toks) {
    if (k.t === 'ws' || k.t === 'id' || k.t === 'op') h += esc(k.s);
    else h += `<span class="tk-${k.t}">${esc(k.s)}</span>`;
  }
  return h;
}
