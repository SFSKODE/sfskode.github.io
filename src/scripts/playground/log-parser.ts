// Parser for Salesforce debug logs. Pure functions (no DOM), unit-tested with node --test.

export type LogKind = 'debug' | 'error' | 'soql' | 'dml' | 'limits' | 'code' | 'method' | 'flow' | 'sys';

export interface LogEntry {
  idx: number;
  time: string; // HH:MM:SS.mmm
  ns: number; // nanoseconds since the log started its clock
  event: string;
  rest: string; // everything after EVENT| (may contain newlines)
  fields: string[];
  kind: LogKind;
  raw: string;
}

export interface LogNode {
  entry: LogEntry;
  end?: LogEntry;
  children: LogNode[];
  depth: number;
  durMs: number | null;
  line: number | null; // [n] source line
  open: boolean;
}

export interface LimitRow { label: string; used: number; max: number }

export interface ParsedLog {
  header: string;
  entries: LogEntry[];
  roots: LogNode[];
  nodes: LogNode[]; // flat, in order
  totalMs: number;
  counts: { soql: number; dml: number; debug: number; errors: number; entries: number };
  soqlRows: number;
  limits: LimitRow[];
  cpuMs: number | null;
  heapBytes: number | null;
  heapMax: number | null;
  cpuMax: number | null;
  timeline: { kind: 'soql' | 'dml' | 'code'; startMs: number; endMs: number; label: string }[];
}

const START = /^(\d{1,2}:\d{2}:\d{2}(?:\.\d+)?) \((\d+)\)\|([A-Z][A-Z0-9_]*)(?:\|([\s\S]*))?$/;

export function kindOf(event: string): LogKind {
  if (event === 'USER_DEBUG') return 'debug';
  if (event === 'EXCEPTION_THROWN' || event === 'FATAL_ERROR' || /(^|_)ERROR$|^VALIDATION_FAIL$|^FLOW_ELEMENT_ERROR$|^CALLOUT_ERROR$/.test(event) || event === 'FLOW_START_INTERVIEW_ERROR') return 'error';
  if (event.startsWith('SOQL_') || event === 'SOSL_EXECUTE_BEGIN' || event === 'SOSL_EXECUTE_END') return 'soql';
  if (event.startsWith('DML_')) return 'dml';
  if (/LIMIT/.test(event) || event === 'TESTING_LIMITS') return 'limits';
  if (event.startsWith('CODE_UNIT_') || event.startsWith('EXECUTION_')) return 'code';
  if (event.startsWith('METHOD_') || event.startsWith('CONSTRUCTOR_') || event.startsWith('SYSTEM_METHOD_') || event.startsWith('SYSTEM_CONSTRUCTOR_')) return 'method';
  if (event.startsWith('FLOW_') || event.startsWith('WF_')) return 'flow';
  return 'sys';
}

const OPEN = /^(.*?)_(BEGIN|STARTED|ENTRY)$/;
const CLOSE = /^(.*?)_(END|FINISHED|EXIT)$/;

export function parseLog(text: string): ParsedLog {
  const lines = (text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const entries: LogEntry[] = [];
  let header = '';
  let cur: LogEntry | null = null;
  const finish = () => {
    if (!cur) return;
    cur.raw = cur.raw.replace(/\n+$/, '');
    cur.rest = cur.rest.replace(/\n+$/, '');
    cur.fields = cur.rest.split('|');
    entries.push(cur);
    cur = null;
  };
  for (const line of lines) {
    const m = START.exec(line);
    if (m) {
      finish();
      cur = {
        idx: entries.length,
        time: m[1],
        ns: Number(m[2]),
        event: m[3],
        rest: m[4] ?? '',
        fields: [],
        kind: kindOf(m[3]),
        raw: line,
      };
    } else if (cur) {
      cur.rest += '\n' + line;
      cur.raw += '\n' + line;
    } else if (!header && line.trim()) {
      header = line.trim();
    }
  }
  finish();

  // Build the nesting tree.
  const roots: LogNode[] = [];
  const nodes: LogNode[] = [];
  const stack: { base: string; node: LogNode }[] = [];
  const lineOf = (e: LogEntry) => {
    const m = /^\[(\d+)\]/.exec(e.fields[0] ?? '');
    return m ? Number(m[1]) : null;
  };
  for (const e of entries) {
    const close = CLOSE.exec(e.event);
    if (close && stack.length) {
      let at = -1;
      for (let i = stack.length - 1; i >= 0; i--) if (stack[i].base === close[1]) { at = i; break; }
      if (at >= 0) {
        const top = stack[at].node;
        top.end = e;
        top.durMs = (e.ns - top.entry.ns) / 1e6;
        stack.length = at;
        continue; // END entries fold into their BEGIN node
      }
    }
    const parent = stack.length ? stack[stack.length - 1].node : null;
    const node: LogNode = { entry: e, children: [], depth: stack.length, durMs: null, line: lineOf(e), open: false };
    (parent ? parent.children : roots).push(node);
    nodes.push(node);
    const open = OPEN.exec(e.event);
    if (open) stack.push({ base: open[1], node });
  }

  // Counts and limits.
  const counts = { soql: 0, dml: 0, debug: 0, errors: 0, entries: entries.length };
  let soqlRows = 0;
  for (const e of entries) {
    if (e.event === 'SOQL_EXECUTE_BEGIN') counts.soql++;
    else if (e.event === 'DML_BEGIN') counts.dml++;
    else if (e.event === 'USER_DEBUG') counts.debug++;
    else if (e.kind === 'error') counts.errors++;
    if (e.event === 'SOQL_EXECUTE_END') {
      const m = /Rows:(\d+)/.exec(e.rest);
      if (m) soqlRows += Number(m[1]);
    }
  }

  let limits: LimitRow[] = [];
  let lastBlock = -1;
  entries.forEach((e, i) => { if (e.event === 'CUMULATIVE_LIMIT_USAGE') lastBlock = i; });
  if (lastBlock >= 0) {
    for (let i = lastBlock + 1; i < entries.length && entries[i].event !== 'CUMULATIVE_LIMIT_USAGE_END'; i++) {
      const e = entries[i];
      if (e.event !== 'LIMIT_USAGE_FOR_NS') continue;
      if (limits.length && !/\(default\)/.test(e.rest)) continue;
      const rows: LimitRow[] = [];
      for (const l of e.rest.split('\n')) {
        const m = /^\s*(.+?):\s*(\d+) out of (\d+)/.exec(l);
        if (m) rows.push({ label: m[1], used: Number(m[2]), max: Number(m[3]) });
      }
      if (/\(default\)/.test(e.rest) || !limits.length) limits = rows;
      if (/\(default\)/.test(e.rest)) break;
    }
  }
  const find = (re: RegExp) => limits.find((l) => re.test(l.label));
  const cpu = find(/cpu/i);
  const heap = find(/heap/i);

  const first = entries[0]?.ns ?? 0;
  const last = entries[entries.length - 1]?.ns ?? 0;
  const totalMs = Math.max(0, (last - first) / 1e6);

  const timeline: ParsedLog['timeline'] = [];
  for (const n of nodes) {
    if ((n.entry.kind === 'soql' || n.entry.kind === 'dml') && n.end) {
      timeline.push({
        kind: n.entry.kind,
        startMs: (n.entry.ns - first) / 1e6,
        endMs: (n.end.ns - first) / 1e6,
        label: n.entry.kind === 'soql' ? (n.entry.fields[2]?.replace(/^Aggregations:\d+\|?/, '') || n.entry.fields.slice(1).join(' ')) : n.entry.fields.slice(1).join(' '),
      });
    }
  }

  return {
    header,
    entries,
    roots,
    nodes,
    totalMs,
    counts,
    soqlRows,
    limits,
    cpuMs: cpu ? cpu.used : null,
    cpuMax: cpu ? cpu.max : null,
    heapBytes: heap ? heap.used : null,
    heapMax: heap ? heap.max : null,
    timeline,
  };
}

export type LogFilter = 'all' | 'debug' | 'errors' | 'soql' | 'dml' | 'limits';

export function matchesFilter(e: LogEntry, f: LogFilter): boolean {
  switch (f) {
    case 'all': return true;
    case 'debug': return e.event === 'USER_DEBUG';
    case 'errors': return e.kind === 'error';
    case 'soql': return e.kind === 'soql';
    case 'dml': return e.kind === 'dml';
    case 'limits': return e.kind === 'limits';
  }
}

/** The human text shown for an entry (without the source-line marker). */
export function entryText(e: LogEntry, node?: LogNode): string {
  const f = e.fields;
  switch (e.event) {
    case 'USER_DEBUG': return f.slice(2).join('|'); // [line]|LEVEL|message
    case 'SOQL_EXECUTE_BEGIN': return f.slice(2).join('|').replace(/^Aggregations:\d+\|?/, '');
    case 'DML_BEGIN': return f.slice(1).join(' ').replace(/Op:/, '').replace(/\s*Type:/, ' ').replace(/\s*Rows:/, ' · rows ');
    default: break;
  }
  void node;
  return f.join(' | ').replace(/^\[(\d+|EXTERNAL)\]( \| )?/, (m, a) => (a === 'EXTERNAL' ? '' : m));
}

export function userDebugLevel(e: LogEntry): string {
  return e.fields[1] ?? 'DEBUG';
}

export function formatMs(ms: number): string {
  if (ms < 1) return `${(ms * 1000).toFixed(0)} µs`;
  if (ms < 1000) return `${ms < 10 ? ms.toFixed(1) : Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}
