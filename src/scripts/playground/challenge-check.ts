// Evaluates a challenge's checks against what the learner wrote and what the org returned. Pure: no DOM.
import type { Challenge, Check } from '../../data/challenges';

export interface Outcome {
  ran: boolean; // the request reached the org and got an answer
  ok: boolean; // SOQL: query succeeded. Apex: compiled and finished without an exception
  columns: string[];
  rows: Record<string, unknown>[]; // flattened rows (Account.Name style keys)
  log: string;
}
export interface CheckResult { label: string; pass: boolean; hint?: string }

/** Remove comments so a commented-out answer never counts. */
export function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1').replace(/(^|\s)--.*$/gm, '$1');
}

export function runCheck(c: Check, code: string, o: Outcome | null): CheckResult {
  const clean = stripComments(code);
  switch (c.type) {
    case 'matches': return { label: c.label, pass: new RegExp(c.re, c.flags ?? 'i').test(clean) };
    case 'runs': return o && o.ran ? { label: c.label, pass: o.ok } : { label: c.label, pass: false, hint: 'Run it first (Ctrl+Enter).' };
    case 'columns': {
      if (!o || !o.ran || !o.ok) return { label: c.label, pass: false, hint: 'Run a query that succeeds first.' };
      const have = new Set(o.columns.map((x) => x.toLowerCase()));
      const missing = c.names.filter((n) => !have.has(n.toLowerCase()));
      return { label: c.label, pass: missing.length === 0, hint: missing.length ? `Missing: ${missing.join(', ')}` : undefined };
    }
    case 'maxRows': return o && o.ran && o.ok ? { label: c.label, pass: o.rows.length <= c.n, hint: o.rows.length > c.n ? `Got ${o.rows.length} rows` : undefined } : { label: c.label, pass: false, hint: 'Run a query that succeeds first.' };
    case 'sorted': {
      if (!o || !o.ran || !o.ok) return { label: c.label, pass: false, hint: 'Run a query that succeeds first.' };
      const vals = o.rows.map((r) => r[c.field]).filter((v) => v !== null && v !== undefined) as (number | string)[];
      let good = true;
      for (let i = 1; i < vals.length; i++) if (c.dir === 'asc' ? vals[i - 1] > vals[i] : vals[i - 1] < vals[i]) good = false;
      return { label: c.label, pass: good };
    }
    case 'log': return o && o.ran ? { label: c.label, pass: o.log.includes(c.contains) } : { label: c.label, pass: false, hint: 'Run your code first.' };
  }
}

export function evaluate(ch: Challenge, code: string, o: Outcome | null): { results: CheckResult[]; passed: boolean } {
  const results = ch.checks.map((c) => runCheck(c, code, o));
  return { results, passed: results.every((r) => r.pass) };
}
