// Autocomplete: context detection (pure) and ranking. The editor feeds it the text and cursor, the controller supplies describe data.
import { tokenizeApex, tokenizeSoql, APEX_KEYWORDS, APEX_TYPES, SOQL_FUNCTION_LIST, DATE_LITERAL_LIST } from './tokenize';
import { findTopLevel } from './data-utils';

export type Lang = 'apex' | 'soql';
export type ItemKind = 'object' | 'field' | 'rel' | 'kw' | 'fn' | 'class' | 'snippet' | 'value' | 'lit' | 'member';
export interface Suggestion { label: string; insert?: string; detail?: string; kind: ItemKind; cursorBack?: number }

export interface SoqlContext {
  kind: 'soql';
  clause: 'select' | 'from-object' | 'where' | 'order' | 'group' | 'after-from' | 'none' | 'picklist';
  prefix: string;
  path: string[]; // relationship path typed before the prefix: Account.Owner.Na -> ['Account','Owner']
  object: string | null; // FROM object (or child relationship name for a subquery)
  outerObject: string | null; // set for subqueries: the outer FROM object
  subquery: boolean;
  afterOperator: boolean;
  valueField?: string; // picklist context: the field path being compared
}
export interface ApexContext { kind: 'apex'; prefix: string; qualifier: string | null }
export type Context = SoqlContext | ApexContext;

const CLAUSES: [RegExp, SoqlContext['clause']][] = [
  [/^SELECT\b/i, 'select'],
  [/^FROM\b/i, 'from-object'],
  [/^WHERE\b/i, 'where'],
  [/^HAVING\b/i, 'where'],
  [/^ORDER\s+BY\b/i, 'order'],
  [/^GROUP\s+BY\b/i, 'group'],
  [/^(LIMIT|OFFSET|FOR|WITH|USING|TYPEOF|UPDATE)\b/i, 'none'],
];

/** Locate the inline query region around the cursor inside Apex: [start, end) of the text between [ and ]. */
function apexQueryRegion(text: string, cursor: number): [number, number] | null {
  let depth = 0;
  let i = cursor - 1;
  let start = -1;
  for (; i >= 0; i--) {
    const c = text[i];
    if (c === ';' || c === '{' || c === '}') return null;
    if (c === ']') depth++;
    else if (c === '[') {
      if (depth === 0) { start = i + 1; break; }
      depth--;
    }
  }
  if (start < 0 || !/^\s*select\b/i.test(text.slice(start, start + 30))) return null;
  let d = 0;
  let end = text.length;
  for (let j = cursor; j < text.length; j++) {
    const c = text[j];
    if (c === ';') { end = j; break; }
    if (c === '[') d++;
    else if (c === ']') { if (d === 0) { end = j; break; } d--; }
  }
  return [start, end];
}

function insideStringOrComment(text: string, cursor: number, lang: Lang): { kind: 'st' | 'cm'; start: number } | null {
  const before = text.slice(0, cursor);
  const toks = lang === 'apex' ? tokenizeApex(before) : tokenizeSoql(before);
  let pos = 0;
  for (const t of toks) {
    const end = pos + t.s.length;
    if (end === cursor) {
      if (t.t === 'st' && (t.s.length < 2 || !/(^|[^\\])'$/.test(t.s) || /\\'$/.test(t.s))) return { kind: 'st', start: pos };
      if (t.t === 'cm' && !t.s.startsWith('/*') ) return { kind: 'cm', start: pos };
      if (t.t === 'cm' && !t.s.endsWith('*/')) return { kind: 'cm', start: pos };
    }
    pos = end;
  }
  return null;
}

/** Top-level clause keyword in `s` (text of the current segment before the cursor), and where its argument text starts. */
function currentClause(s: string): { clause: SoqlContext['clause'] | null; argStart: number } {
  let depth = 0;
  let clause: SoqlContext['clause'] | null = null;
  let argStart = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'") {
      let j = i + 1;
      while (j < s.length && s[j] !== "'") j += s[j] === '\\' ? 2 : 1;
      i = j;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (depth === 0 && /[A-Za-z]/.test(c) && (i === 0 || !/[A-Za-z0-9_.]/.test(s[i - 1]))) {
      const chunk = s.slice(i, i + 20);
      for (const [re, name] of CLAUSES) {
        const m = re.exec(chunk);
        if (m) { clause = name; argStart = i + m[0].length; i += m[0].length - 1; break; }
      }
    }
  }
  return { clause, argStart };
}

export function completionContext(text: string, cursor: number, lang: Lang): Context | null {
  let region: [number, number] | null = null;
  let mode: Lang = lang;
  if (lang === 'apex') {
    region = apexQueryRegion(text, cursor);
    mode = region ? 'soql' : 'apex';
  } else region = [0, text.length];

  const sc = insideStringOrComment(text, cursor, lang);
  if (sc && sc.kind === 'cm') return null;

  if (mode === 'apex') {
    if (sc) return null;
    const before = text.slice(0, cursor);
    const pm = /([A-Za-z_]\w*)?$/.exec(before)!;
    const prefix = pm[1] ?? '';
    const rest = before.slice(0, before.length - prefix.length);
    const qm = /([A-Za-z_]\w*)\s*\.$/.exec(rest);
    return { kind: 'apex', prefix, qualifier: qm ? qm[1] : null };
  }

  // SOQL (standalone or inline)
  const [rs, re] = region!;
  const rel = cursor - rs;
  const rtext = text.slice(rs, re);
  const before = rtext.slice(0, rel);

  // Innermost open subquery "(SELECT" before the cursor.
  const stack: number[] = [];
  for (let i = 0; i < before.length; i++) {
    const c = before[i];
    if (c === "'") {
      let j = i + 1;
      while (j < before.length && before[j] !== "'") j += before[j] === '\\' ? 2 : 1;
      i = j;
      continue;
    }
    if (c === '(') stack.push(i);
    else if (c === ')') stack.pop();
  }
  let segStart = 0;
  let subquery = false;
  for (let k = stack.length - 1; k >= 0; k--) {
    if (/^\(\s*SELECT\b/i.test(before.slice(stack[k], stack[k] + 20))) { segStart = stack[k] + 1; subquery = true; break; }
  }
  const segBefore = before.slice(segStart);
  // Segment end: matching ")" for subqueries.
  let segEnd = rtext.length;
  if (subquery) {
    let d = 0;
    for (let j = rel; j < rtext.length; j++) {
      if (rtext[j] === '(') d++;
      else if (rtext[j] === ')') { if (d === 0) { segEnd = j; break; } d--; }
    }
  }
  const segText = rtext.slice(segStart, segEnd);

  const fromIdx = findTopLevel(segText, /^FROM\b/i);
  let object: string | null = null;
  if (fromIdx >= 0) {
    const m = /^FROM\s+([A-Za-z_][A-Za-z0-9_]*)/i.exec(segText.slice(fromIdx));
    if (m) object = m[1];
  }
  let outerObject: string | null = null;
  if (subquery) {
    const outerFrom = findTopLevel(rtext, /^FROM\b/i, 0);
    const s0 = findTopLevel(rtext, /^SELECT\b/i);
    const f0 = s0 >= 0 ? findTopLevel(rtext, /^FROM\b/i, s0 + 6) : outerFrom;
    if (f0 >= 0) {
      const m = /^FROM\s+([A-Za-z_][A-Za-z0-9_]*)/i.exec(rtext.slice(f0));
      if (m) outerObject = m[1];
    }
  }

  const { clause, argStart } = currentClause(segBefore);

  // Inside a string: only picklist values are offered.
  if (sc && sc.kind === 'st') {
    const qpos = sc.start - rs - segStart;
    const head = qpos > 0 ? segBefore.slice(0, qpos) : '';
    const pm = /([A-Za-z_][\w.]*)\s*(?:!?=|<>|LIKE|(?:NOT\s+)?IN\s*\(|INCLUDES\s*\(|EXCLUDES\s*\()\s*(?:'[^']*'\s*,\s*)*$/i.exec(head);
    if (!pm) return null;
    const typed = text.slice(sc.start + 1, cursor);
    return { kind: 'soql', clause: 'picklist', prefix: typed, path: [], object, outerObject, subquery, afterOperator: true, valueField: pm[1] };
  }

  // Word being typed, with an optional relationship path before it.
  const wm = /([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*\.)?([A-Za-z_]\w*)?$/.exec(before);
  const chain = wm?.[1] ? wm[1].slice(0, -1).split('.') : [];
  const prefix = wm?.[2] ?? '';

  let kind: SoqlContext['clause'] = 'none';
  if (clause === 'from-object') {
    // Right after FROM we offer objects; once an object name and a space were typed, we offer clause keywords.
    kind = /^\s+[\w.]*$/.test(segBefore.slice(argStart)) ? 'from-object' : 'after-from';
  } else if (clause) kind = clause;
  const head = before.slice(0, before.length - (wm?.[0].length ?? 0));
  const afterOperator = /(?:!=|<>|<=|>=|=|<|>|\bLIKE|\bIN|\bINCLUDES|\bEXCLUDES)\s*\(?\s*$/i.test(head);

  return { kind: 'soql', clause: kind, prefix, path: chain, object, outerObject, subquery, afterOperator };
}

/* ------------------------------ Static lists ------------------------------ */

export const SOQL_CLAUSE_KEYWORDS = ['WHERE', 'ORDER BY', 'GROUP BY', 'HAVING', 'LIMIT', 'OFFSET', 'WITH SECURITY_ENFORCED', 'WITH USER_MODE', 'FOR VIEW', 'FOR UPDATE', 'ALL ROWS'];
export const SOQL_WHERE_KEYWORDS = ['AND', 'OR', 'NOT', 'IN', 'LIKE', 'INCLUDES', 'EXCLUDES', 'NULL', 'TRUE', 'FALSE'];
export const SOQL_ORDER_KEYWORDS = ['ASC', 'DESC', 'NULLS FIRST', 'NULLS LAST', 'LIMIT'];

const M = (label: string, detail = '') => ({ label, detail, kind: 'member' as const });
export const APEX_MEMBERS: Record<string, Suggestion[]> = {
  System: [M('debug(', 'System.debug(Object)'), M('now()', 'Datetime'), M('today()', 'Date'), M('assert(', 'assert(condition, msg)'), M('assertEquals(', 'expected, actual'), M('assertNotEquals('), M('isBatch()'), M('schedule('), M('enqueueJob('), M('abortJob(')],
  Database: [M('query(', 'String -> List<SObject>'), M('insert('), M('update('), M('delete('), M('upsert('), M('getQueryLocator('), M('countQuery('), M('setSavepoint()', 'Savepoint'), M('rollback(', 'rollback(Savepoint)'), M('executeBatch(')],
  Limits: [M('getQueries()'), M('getLimitQueries()'), M('getDmlStatements()'), M('getLimitDmlStatements()'), M('getDmlRows()'), M('getQueryRows()'), M('getCpuTime()'), M('getLimitCpuTime()'), M('getHeapSize()'), M('getLimitHeapSize()'), M('getCallouts()')],
  Math: [M('abs('), M('ceil('), M('floor('), M('max('), M('min('), M('pow('), M('round('), M('random()'), M('sqrt('), M('mod(')],
  String: [M('valueOf('), M('isBlank('), M('isNotBlank('), M('isEmpty('), M('join('), M('format('), M('escapeSingleQuotes('), M('join(')],
  Date: [M('today()'), M('newInstance('), M('valueOf('), M('daysInMonth('), M('isLeapYear(')],
  Datetime: [M('now()'), M('newInstance('), M('valueOf(')],
  JSON: [M('serialize('), M('serializePretty('), M('deserialize('), M('deserializeUntyped(')],
  Schema: [M('getGlobalDescribe()'), M('describeSObjects('), M('SObjectType')],
  Test: [M('startTest()'), M('stopTest()'), M('isRunningTest()'), M('loadData(')],
  Trigger: [M('new'), M('old'), M('newMap'), M('oldMap'), M('isInsert'), M('isUpdate'), M('isDelete'), M('isBefore'), M('isAfter'), M('operationType')],
  UserInfo: [M('getUserId()'), M('getUserName()'), M('getUserEmail()'), M('getName()'), M('getOrganizationId()'), M('getOrganizationName()'), M('getTimeZone()')],
};
const INSTANCE_METHODS: Suggestion[] = ['add(', 'addAll(', 'size()', 'isEmpty()', 'get(', 'put(', 'contains(', 'containsKey(', 'keySet()', 'values()', 'remove(', 'clear()', 'sort()', 'clone()', 'deepClone()', 'toString()', 'length()', 'substring(', 'toLowerCase()', 'toUpperCase()', 'trim()', 'split(', 'replace(', 'startsWith(', 'endsWith(', 'indexOf(', 'format()', 'addDays(', 'addMonths(', 'getSObjectType()'].map((l) => M(l));

export const APEX_SNIPPETS: Suggestion[] = [
  { label: 'System.debug', insert: "System.debug('')", kind: 'snippet', detail: 'log a value', cursorBack: 2 },
  { label: 'soql', insert: 'List<Account> accs = [SELECT Id, Name FROM Account LIMIT 10];', kind: 'snippet', detail: 'inline query' },
  { label: 'for', insert: 'for (Account a : accs) {\n  \n}', kind: 'snippet', detail: 'for-each loop', cursorBack: 2 },
  { label: 'fori', insert: 'for (Integer i = 0; i < 10; i++) {\n  \n}', kind: 'snippet', detail: 'counted loop', cursorBack: 2 },
  { label: 'trycatch', insert: 'try {\n  \n} catch (Exception e) {\n  System.debug(e.getMessage());\n}', kind: 'snippet', detail: 'try / catch', cursorBack: 0 },
  { label: 'savepoint', insert: 'Savepoint sp = Database.setSavepoint();\n// ... DML ...\nDatabase.rollback(sp);', kind: 'snippet', detail: 'safe: rolls changes back' },
  { label: 'map', insert: 'Map<Id, Account> byId = new Map<Id, Account>();', kind: 'snippet', detail: 'Map<Id, SObject>' },
];

export const APEX_COMMON_TYPES = ['String', 'Integer', 'Long', 'Decimal', 'Double', 'Boolean', 'Date', 'Datetime', 'Time', 'Id', 'Blob', 'Object', 'List', 'Set', 'Map', 'SObject',
  'Database', 'System', 'Schema', 'Limits', 'Math', 'JSON', 'Test', 'Trigger', 'Savepoint', 'Exception', 'DmlException', 'QueryException', 'UserInfo', 'Pattern', 'Matcher', 'EncodingUtil', 'Crypto', 'Http', 'HttpRequest', 'HttpResponse'];

/* -------------------------------- Ranking -------------------------------- */

export function score(label: string, prefix: string): number {
  if (!prefix) return 1;
  const l = label.toLowerCase();
  const p = prefix.toLowerCase();
  if (l === p) return 0;
  if (l.startsWith(p)) return 1 + (label.startsWith(prefix) ? 0 : 0.5);
  // Word boundary: camelCase / underscore / dot
  const bounds = label.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().split(/[_.\s]+/);
  if (bounds.some((w) => w.startsWith(p))) return 3;
  const idx = l.indexOf(p);
  if (idx >= 0) return 4 + Math.min(idx, 10) / 10;
  return -1;
}

export function rank<T extends { label: string }>(items: T[], prefix: string, limit = 60): T[] {
  const scored: [T, number][] = [];
  const seen = new Set<string>();
  for (const it of items) {
    const key = it.label;
    if (seen.has(key)) continue;
    const s = score(it.label, prefix);
    if (s >= 0) { scored.push([it, s]); seen.add(key); }
  }
  scored.sort((a, b) => a[1] - b[1] || a[0].label.length - b[0].label.length || a[0].label.localeCompare(b[0].label));
  return scored.slice(0, limit).map(([i]) => i);
}

export function apexKeywordItems(): Suggestion[] {
  return [...APEX_KEYWORDS].filter((k) => !['get', 'set', 'on', 'when'].includes(k)).map((k) => ({ label: k, kind: 'kw' as const }));
}
export function apexTypeItems(): Suggestion[] {
  return APEX_COMMON_TYPES.concat([...APEX_TYPES].filter((t) => !t.includes('.'))).map((t) => ({ label: t, kind: 'class' as const }));
}
export function soqlFunctionItems(): Suggestion[] {
  return SOQL_FUNCTION_LIST.map((f) => ({ label: f, insert: f + '(', kind: 'fn' as const }));
}
export function dateLiteralItems(): Suggestion[] {
  return DATE_LITERAL_LIST.map((l) => ({ label: l, kind: 'lit' as const, detail: 'date literal' }));
}
export function instanceMethodItems(): Suggestion[] { return INSTANCE_METHODS; }
