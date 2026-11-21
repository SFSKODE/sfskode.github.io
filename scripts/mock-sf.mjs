// A tiny fake Salesforce org for testing the playground without a real org.
//   node scripts/mock-sf.mjs --port 4500
// It plays the login host AND the org instance. Point the site at it with:
//   SF_CLIENT_ID=mock SF_EXTRA_HOSTS=127.0.0.1:4500 SF_LOGIN_SCHEME=http
// then choose "Custom domain" and enter 127.0.0.1:4500.
import http from 'node:http';
import crypto from 'node:crypto';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : d; };
const PORT = Number(arg('port', process.env.MOCK_SF_PORT || 4500));
const BASE = `http://127.0.0.1:${PORT}`;
const ORG_ID = '00D5g000008MOCKAA2';
const USER_ID = '0055g00000MOCKUAAA';
const V = 'v62.0';

/* ------------------------------ data ------------------------------ */
const pick = (a, i) => a[i % a.length];
const sid = (p, n) => `${p}5g${String(n).padStart(10, "0")}AAA`;
const date = (d) => new Date(Date.UTC(2026, 0, 1) + d * 864e5).toISOString().slice(0, 10);
const INDUSTRIES = ['Technology', 'Banking', 'Healthcare', 'Retail', 'Energy', 'Education'];
const CITIES = ['Hyderabad', 'Bengaluru', 'Pune', 'Chennai', 'Mumbai', 'Delhi'];
const NAMES = ['Aarav', 'Diya', 'Kabir', 'Meera', 'Rohan', 'Isha', 'Vikram', 'Anaya'];
const SURN = ['Sharma', 'Reddy', 'Iyer', 'Patel', 'Nair', 'Gupta', 'Khan', 'Das'];
const data = { Account: [], Contact: [], Opportunity: [], Lead: [], Case: [], User: [], Organization: [], Invoice__c: [], Big__c: [] };
for (let i = 0; i < 20; i++) data.Account.push({ Id: sid('001', i + 1), Name: `${pick(['Acme', 'Globex', 'Initech', 'Umbrella', 'Hooli', 'Stark'], i)} ${pick(['Labs', 'Corp', 'Systems', 'Group'], i * 3)} ${i + 1}`, Industry: pick(INDUSTRIES, i), Type: i % 3 ? 'Customer' : 'Prospect', Rating: pick(['Hot', 'Warm', 'Cold'], i), BillingCity: pick(CITIES, i), AnnualRevenue: 250000 * (i + 1), NumberOfEmployees: 10 * (i + 3), IsActive__c: i % 4 !== 0, CreatedDate: `${date(i * 7)}T09:30:00.000+0000` });
for (let i = 0; i < 40; i++) { const f = pick(NAMES, i), l = pick(SURN, i * 2 + 1); data.Contact.push({ Id: sid('003', i + 1), FirstName: f, LastName: l, Name: `${f} ${l}`, Email: `${f}.${l}${i}@example.com`.toLowerCase(), Title: pick(['CTO', 'Developer', 'Admin', 'Manager'], i), AccountId: data.Account[i % 20].Id }); }
for (let i = 0; i < 30; i++) data.Opportunity.push({ Id: sid('006', i + 1), Name: `${data.Account[i % 20].Name} - Deal ${i + 1}`, StageName: pick(['Prospecting', 'Qualification', 'Proposal', 'Closed Won', 'Closed Lost'], i), Amount: 12000 + i * 3500, CloseDate: date(30 + i * 4), IsWon: i % 5 === 3, AccountId: data.Account[i % 20].Id });
for (let i = 0; i < 25; i++) { const f = pick(NAMES, i + 3), l = pick(SURN, i); data.Lead.push({ Id: sid('00Q', i + 1), FirstName: f, LastName: l, Name: `${f} ${l}`, Company: `${pick(['Zen', 'Nova', 'Apex', 'Orbit'], i)} ${i + 1} Pvt Ltd`, Status: pick(['Open', 'Working', 'Qualified', 'Unqualified'], i), LeadSource: pick(['Web', 'Referral', 'Event', 'Partner'], i), Email: `lead${i}@example.com` }); }
for (let i = 0; i < 15; i++) data.Case.push({ Id: sid('500', i + 1), CaseNumber: String(1000 + i), Subject: pick(['Login failure', 'Report is slow', 'Need API access', 'Data export request'], i), Status: pick(['New', 'Working', 'Escalated', 'Closed'], i), Priority: pick(['Low', 'Medium', 'High'], i), AccountId: data.Account[i % 20].Id });
for (let i = 0; i < 3; i++) data.User.push({ Id: i ? sid('005', i + 1) : USER_ID, Name: ['Demo Admin', 'Sales Rep', 'Support Agent'][i], Username: `${['demo', 'sales', 'support'][i]}@example.com`, IsActive: true });
data.Organization.push({ Id: ORG_ID, Name: 'Mock Org (SF SKODE test)', IsSandbox: true, InstanceName: 'MOCK1' });
for (let i = 0; i < 8; i++) data.Invoice__c.push({ Id: sid('a01', i + 1), Name: `INV-${String(i + 1).padStart(4, '0')}`, Amount__c: 1500 + i * 420, Status__c: pick(['Draft', 'Sent', 'Paid'], i), Due_Date__c: date(20 + i * 9), Account__c: data.Account[i].Id });
for (let i = 0; i < 2500; i++) data.Big__c.push({ Id: sid('a02', i + 1), Name: `Row ${i + 1}`, Value__c: i % 97 });
const REL = { Account: { Account: ['AccountId', 'Account'] }, Contact: { Account: ['AccountId', 'Account'] }, Opportunity: { Account: ['AccountId', 'Account'] }, Case: { Account: ['AccountId', 'Account'] }, Invoice__c: { Account__r: ['Account__c', 'Account'] } };
const CHILD = { Account: [['Contact', 'AccountId', 'Contacts'], ['Opportunity', 'AccountId', 'Opportunities'], ['Case', 'AccountId', 'Cases']] };

/* ------------------------------ SOQL engine (subset) ------------------------------ */
class SoqlError extends Error {}
const getField = (rec, path, obj) => {
  const parts = path.split('.');
  let cur = rec, o = obj;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (i < parts.length - 1) {
      const rel = REL[o]?.[p];
      if (!rel) throw new SoqlError(`No such relationship '${p}' on entity '${o}'`);
      cur = data[rel[1]].find((r) => r.Id === cur[rel[0]]) || null; o = rel[1];
      if (!cur) return null;
    } else {
      const k = Object.keys(cur).find((x) => x.toLowerCase() === p.toLowerCase());
      if (!k) throw new SoqlError(`No such column '${p}' on entity '${o}'`);
      return cur[k];
    }
  }
};
function lit(t) {
  t = t.trim();
  if (/^'.*'$/.test(t)) return t.slice(1, -1).replace(/\\'/g, "'");
  if (/^(true|false)$/i.test(t)) return t.toLowerCase() === 'true';
  if (/^null$/i.test(t)) return null;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t;
  throw new SoqlError(`unexpected token: '${t}'`);
}
function cond(rec, obj, src) {
  src = src.trim();
  while (src.startsWith('(') && src.endsWith(')') && depthOk(src.slice(1, -1))) src = src.slice(1, -1).trim();
  const split = (word) => { const out = []; let d = 0, q = false, last = 0; for (let i = 0; i < src.length; i++) { const c = src[i]; if (c === "'" && src[i - 1] !== '\\') q = !q; if (q) continue; if (c === '(') d++; if (c === ')') d--; if (d === 0 && src.slice(i, i + word.length + 2).toUpperCase() === ` ${word} ` && src[i] === ' ') { out.push(src.slice(last, i)); last = i + word.length + 2; i = last - 1; } } out.push(src.slice(last)); return out; };
  const ors = split('OR'); if (ors.length > 1) return ors.some((p) => cond(rec, obj, p));
  const ands = split('AND'); if (ands.length > 1) return ands.every((p) => cond(rec, obj, p));
  if (/^NOT\s/i.test(src)) return !cond(rec, obj, src.slice(4));
  const m = /^([\w.]+)\s*(!=|<>|<=|>=|=|<|>|\bNOT\s+IN\b|\bIN\b|\bNOT\s+LIKE\b|\bLIKE\b)\s*([\s\S]+)$/i.exec(src);
  if (!m) throw new SoqlError(`unexpected token: '${src.split(/\s+/)[0]}'`);
  const left = getField(rec, m[1], obj); const op = m[2].toUpperCase().replace(/\s+/g, ' '); const rhs = m[3].trim();
  if (op === 'IN' || op === 'NOT IN') { const list = rhs.replace(/^\(|\)$/g, '').split(',').map(lit); const r = list.some((x) => x === left); return op === 'IN' ? r : !r; }
  const v = lit(rhs);
  if (op === 'LIKE' || op === 'NOT LIKE') { const re = new RegExp('^' + String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.') + '$', 'i'); const r = re.test(String(left ?? '')); return op === 'LIKE' ? r : !r; }
  if (op === '=') return left === v || (left != null && v != null && String(left) === String(v) && typeof left !== 'object');
  if (op === '!=' || op === '<>') return left !== v;
  if (left == null || v == null) return false;
  return op === '<' ? left < v : op === '>' ? left > v : op === '<=' ? left <= v : left >= v;
}
function depthOk(s) { let d = 0; for (const c of s) { if (c === '(') d++; if (c === ')') { d--; if (d < 0) return false; } } return d === 0; }
function splitTop(s) { const out = []; let d = 0, q = false, last = 0; for (let i = 0; i < s.length; i++) { const c = s[i]; if (c === "'") q = !q; if (q) continue; if (c === '(') d++; if (c === ')') d--; if (c === ',' && d === 0) { out.push(s.slice(last, i).trim()); last = i + 1; } } out.push(s.slice(last).trim()); return out.filter(Boolean); }

function runSoql(soql, tooling) {
  const q = soql.trim().replace(/\s+/g, ' ').replace(/;$/, '');
  const m = /^SELECT (.+?) FROM (\w+)(?: (?:AS )?(?!WHERE\b|GROUP\b|ORDER\b|LIMIT\b|OFFSET\b)\w+)?(?: WHERE (.+?))?(?: GROUP BY (.+?))?(?: HAVING (.+?))?(?: ORDER BY (.+?))?(?: LIMIT (\d+))?(?: OFFSET (\d+))?$/i.exec(q);
  if (!m) { const bad = /^SELECT/i.test(q) ? (/ FROM /i.test(q) ? q.split(' ').find((w) => /^[^\w.,()'%=<>!*-]+$/.test(w)) || 'query' : 'FROM clause') : q.split(' ')[0]; throw new SoqlError(`unexpected token: '${bad}'`); }
  const [, selRaw, obj0, where, groupBy, , orderBy, limit, offset] = m;
  const obj = Object.keys(data).find((k) => k.toLowerCase() === obj0.toLowerCase());
  if (!obj) throw new SoqlError(`sObject type '${obj0}' is not supported.`);
  const sel = splitTop(selRaw);
  let rows = data[obj].filter((r) => (where ? cond(r, obj, where) : true));
  const aggRe = /^(COUNT|SUM|AVG|MIN|MAX|COUNT_DISTINCT)\((.*?)\)(?:\s+(\w+))?$/i;
  const hasAgg = sel.some((s) => aggRe.test(s));
  let out;
  if (hasAgg || groupBy) {
    const keys = groupBy ? groupBy.split(',').map((x) => x.trim()) : [];
    const groups = new Map();
    for (const r of rows) { const k = keys.map((x) => String(getField(r, x, obj))).join('|'); (groups.get(k) || groups.set(k, []).get(k)).push(r); }
    if (!keys.length && !groups.size) groups.set('', []);
    out = [...groups.values()].map((g) => { const rec = { attributes: { type: 'AggregateResult' } }; let n = 0; for (const s of sel) { const a = aggRe.exec(s); if (!a) { rec[s] = g[0] ? getField(g[0], s, obj) : null; continue; } const fn = a[1].toUpperCase(); const vals = a[2] ? g.map((r) => getField(r, a[2], obj)).filter((v) => v != null) : g; const key = a[3] || `expr${n++}`; rec[key] = fn === 'COUNT' ? (a[2] ? vals.length : g.length) : fn === 'COUNT_DISTINCT' ? new Set(vals).size : fn === 'SUM' ? vals.reduce((x, y) => x + y, 0) : fn === 'AVG' ? (vals.length ? vals.reduce((x, y) => x + y, 0) / vals.length : null) : fn === 'MIN' ? vals.reduce((x, y) => (y < x ? y : x), vals[0] ?? null) : vals.reduce((x, y) => (y > x ? y : x), vals[0] ?? null); } return rec; });
    if (sel.length === 1 && /^COUNT\(\)$/i.test(sel[0])) return { totalSize: rows.length, done: true, records: [] };
  } else {
    if (orderBy) { const parts = orderBy.split(',').map((x) => /^([\w.]+)(?:\s+(ASC|DESC))?(?:\s+NULLS\s+\w+)?$/i.exec(x.trim())); if (parts.some((p) => !p)) throw new SoqlError('unexpected token in ORDER BY'); rows = [...rows].sort((a, b) => { for (const [, f, d] of parts) { const x = getField(a, f, obj), y = getField(b, f, obj); if (x === y) continue; if (x == null) return -1; if (y == null) return 1; return (x < y ? -1 : 1) * (/desc/i.test(d || '') ? -1 : 1); } return 0; }); }
    out = rows.map((r) => {
      const rec = { attributes: { type: obj, url: `/services/data/${V}/sobjects/${obj}/${r.Id}` } };
      for (const s of sel) {
        if (s === '*') throw new SoqlError("The SOQL FIELDS function must be used with LIMIT; use FIELDS(ALL) with LIMIT 200 or list fields");
        const sub = /^\(\s*SELECT (.+?) FROM (\w+)\s*\)$/i.exec(s);
        if (sub) { const c = (CHILD[obj] || []).find((x) => x[2].toLowerCase() === sub[2].toLowerCase()); if (!c) throw new SoqlError(`Didn't understand relationship '${sub[2]}'`); const kids = data[c[0]].filter((k) => k[c[1]] === r.Id); rec[c[2]] = { totalSize: kids.length, done: true, records: kids.map((k) => { const o2 = { attributes: { type: c[0] } }; for (const f of splitTop(sub[1])) o2[f] = getField(k, f, c[0]); return o2; }) }; continue; }
        const val = getField(r, s, obj);
        if (s.includes('.')) { const [rel, ...rest] = s.split('.'); const parent = rec[rel] || (rec[rel] = { attributes: { type: REL[obj][rel][1] } }); let c = parent; for (let i = 0; i < rest.length - 1; i++) c = c[rest[i]] ||= {}; c[rest[rest.length - 1]] = val; } else { const k = Object.keys(r).find((x) => x.toLowerCase() === s.toLowerCase()); rec[k] = val; }
      }
      return rec;
    });
  }
  const total = out.length;
  const o = offset ? Number(offset) : 0;
  out = out.slice(o, limit ? o + Number(limit) : undefined);
  return { totalSize: total, done: true, records: out };
}
const pages = new Map();
function page(res, soql, tooling) {
  const r = runSoql(soql, tooling);
  if (r.records.length <= 2000) return r;
  const id = crypto.randomBytes(8).toString('hex');
  pages.set(id, r.records.slice(2000));
  return { totalSize: r.totalSize, done: false, nextRecordsUrl: `/services/data/${V}/query/01g${id}-2000`, records: r.records.slice(0, 2000) };
}

/* ------------------------------ describe ------------------------------ */
const typeOf = (k, v) => (k === 'Id' || k.endsWith('Id') ? 'id' : typeof v === 'number' ? 'double' : typeof v === 'boolean' ? 'boolean' : /^\d{4}-\d{2}-\d{2}T/.test(v) ? 'datetime' : /^\d{4}-\d{2}-\d{2}$/.test(v) ? 'date' : /Email/.test(k) ? 'email' : 'string');
function describe(name) {
  const obj = Object.keys(data).find((k) => k.toLowerCase() === name.toLowerCase());
  if (!obj) return null;
  const sample = data[obj][0] || {};
  const rels = REL[obj] || {};
  const fields = Object.keys(sample).map((k) => {
    const ref = Object.entries(rels).find(([, v]) => v[0] === k);
    const t = ref ? 'reference' : typeOf(k, sample[k]);
    const picks = { Industry: INDUSTRIES, Rating: ['Hot', 'Warm', 'Cold'], StageName: ['Prospecting', 'Qualification', 'Proposal', 'Closed Won', 'Closed Lost'], Status: ['Open', 'Working', 'Qualified', 'Unqualified'], Priority: ['Low', 'Medium', 'High'] }[k];
    return { name: k, label: k.replace(/__c$/, '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' '), type: picks ? 'picklist' : t, length: t === 'string' ? 255 : 0, custom: k.endsWith('__c'), nillable: k !== 'Id', referenceTo: ref ? [ref[1][1]] : [], relationshipName: ref ? ref[0] : null, picklistValues: (picks || []).map((v) => ({ value: v, label: v, active: true })), filterable: true, sortable: true };
  });
  return { name: obj, label: obj.replace(/__c$/, '').replace(/_/g, ' '), labelPlural: obj.replace(/__c$/, '').replace(/_/g, ' ') + 's', custom: obj.endsWith('__c'), keyPrefix: String(data[obj][0]?.Id || '').slice(0, 3) || null, fields, childRelationships: (CHILD[obj] || []).map(([c, f, rn]) => ({ childSObject: c, field: f, relationshipName: rn })) };
}

/* ------------------------------ Apex (fake) ------------------------------ */
const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const unxml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
function fakeApex(code) {
  const res = { compiled: true, success: true, line: -1, column: -1, compileProblem: null, exceptionMessage: null, exceptionStackTrace: null };
  const bal = (a, b) => (code.split(a).length - 1) === (code.split(b).length - 1);
  if (/COMPILE_ERROR/.test(code) || !bal('(', ')') || !bal('{', '}')) { res.compiled = false; res.success = false; res.line = 1; res.column = 1; res.compileProblem = /COMPILE_ERROR/.test(code) ? 'Variable does not exist: COMPILE_ERROR' : 'unexpected token: <EOF>'; return { res, log: '' }; }
  let t = 0; const ts = () => { t += 3; return `12:00:00.${String(t).padStart(3, '0')} (${t * 1000000})`; };
  const L = [`66.0 APEX_CODE,DEBUG;DB,INFO;SYSTEM,INFO`, `${ts()}|EXECUTION_STARTED`, `${ts()}|CODE_UNIT_STARTED|[EXTERNAL]|execute_anonymous_apex`];
  let ln = 0, dml = 0, soql = 0, thrown = false;
  for (const line of code.split('\n')) {
    ln++;
    for (const d of line.matchAll(/System\.debug\(\s*(?:LoggingLevel\.\w+\s*,\s*)?'((?:[^'\\]|\\.)*)'(?:\s*\+\s*([^;)]*))?\s*\)/g)) L.push(`${ts()}|USER_DEBUG|[${ln}]|DEBUG|${d[1]}${d[2] ? '[value]' : ''}`);
    for (const d of line.matchAll(/System\.debug\(\s*([A-Za-z_][\w.]*)\s*\)/g)) L.push(`${ts()}|USER_DEBUG|[${ln}]|DEBUG|${d[1]}`);
    for (const q of line.matchAll(/\[\s*(SELECT[^\]]+)\]/gi)) { soql++; L.push(`${ts()}|SOQL_EXECUTE_BEGIN|[${ln}]|Aggregations:0|${q[1].trim()}`); let n = 0; try { n = Math.min(runSoql(q[1].replace(/:\w+/g, "'x'")).totalSize, 50000); } catch { /* ignore */ } L.push(`${ts()}|SOQL_EXECUTE_END|[${ln}]|Rows:${n}`); }
    if (/\b(insert|update|delete|upsert)\s+\w+/i.test(line)) { dml++; L.push(`${ts()}|DML_BEGIN|[${ln}]|Op:Insert|Type:Account|Rows:1`, `${ts()}|DML_END|[${ln}]`); }
    if (/THROW_NPE/.test(line) && !thrown) { thrown = true; res.success = false; res.line = ln; res.column = 1; res.exceptionMessage = 'System.NullPointerException: Attempt to de-reference a null object'; res.exceptionStackTrace = `AnonymousBlock: line ${ln}, column 1`; L.push(`${ts()}|EXCEPTION_THROWN|[${ln}]|System.NullPointerException: Attempt to de-reference a null object`, `${ts()}|FATAL_ERROR|System.NullPointerException: Attempt to de-reference a null object`); break; }
  }
  L.push(`${ts()}|CUMULATIVE_LIMIT_USAGE`, `${ts()}|LIMIT_USAGE_FOR_NS|(default)|`, `  Number of SOQL queries: ${soql} out of 100`, `  Number of DML statements: ${dml} out of 150`, `  Maximum CPU time: ${3 + ln} out of 10000`, `  Maximum heap size: 0 out of 6000000`, `${ts()}|CUMULATIVE_LIMIT_USAGE_END`, `${ts()}|CODE_UNIT_FINISHED|execute_anonymous_apex`, `${ts()}|EXECUTION_FINISHED`);
  return { res, log: L.join('\n') };
}

/* ------------------------------ http ------------------------------ */
const codes = new Map(); const tokens = new Map(); const refresh = new Map();
const readBody = (req) => new Promise((ok) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => ok(b)); });
const json = (res, status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
const sfErr = (res, status, message, errorCode) => json(res, status, [{ message, errorCode }]);
const html = (res, body) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(`<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Mock Salesforce Login</title><style>body{font:16px system-ui;background:#eaf5fe;display:grid;place-items:center;min-height:100vh;margin:0}main{background:#fff;padding:32px;border-radius:12px;box-shadow:0 8px 30px #0003;width:min(380px,92vw)}h1{font-size:20px;margin:0 0 6px;color:#032d60}p{color:#444}input,button{width:100%;padding:11px;margin:6px 0;font:inherit;box-sizing:border-box}button{background:#0176d3;color:#fff;border:0;border-radius:6px;cursor:pointer}</style><main>${body}</main>`); };
function authed(req, res) {
  const t = /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1];
  if (!t || !tokens.has(t)) { sfErr(res, 401, 'Session expired or invalid', 'INVALID_SESSION_ID'); return null; }
  return t;
}
const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, BASE);
    const p = u.pathname;
    if (p === '/services/oauth2/authorize') {
      const q = Object.fromEntries(u.searchParams);
      if (q.response_type !== 'code' || !q.client_id || !q.redirect_uri || !q.code_challenge) return html(res, '<h1>Error</h1><p>invalid_request: missing parameters (PKCE required)</p>');
      const hidden = Object.entries(q).map(([k, v]) => `<input type=hidden name="${xml(k)}" value="${xml(v)}">`).join('');
      if (u.searchParams.get('step') === 'allow') {
        return html(res, `<h1>Allow Access?</h1><p><b>${xml(q.client_id)}</b> is requesting access to your Mock Org.</p><form method=post action="/services/oauth2/approve">${hidden}<button name=a value=allow>Allow</button><button name=a value=deny style="background:#666">Deny</button></form>`);
      }
      return html(res, `<h1>Log in to Mock Salesforce</h1><p>Mock org: ${xml(ORG_ID)}</p><form method=get action="/services/oauth2/authorize">${hidden}<input type=hidden name=step value=allow><input name=u value="demo@example.com" aria-label=Username><input name=pw type=password value="demo" aria-label=Password><button id=Login>Log In</button></form>`);
    }
    if (p === '/services/oauth2/approve' && req.method === 'POST') {
      const b = new URLSearchParams(await readBody(req));
      const ru = new URL(b.get('redirect_uri'));
      if (b.get('a') !== 'allow') { ru.searchParams.set('error', 'access_denied'); ru.searchParams.set('error_description', 'end-user denied authorization'); } else { const code = crypto.randomBytes(12).toString('hex'); codes.set(code, { challenge: b.get('code_challenge'), redirect: b.get('redirect_uri'), client: b.get('client_id'), t: Date.now() }); ru.searchParams.set('code', code); }
      if (b.get('state')) ru.searchParams.set('state', b.get('state'));
      res.writeHead(302, { Location: ru.toString() }); return res.end();
    }
    if (p === '/services/oauth2/token' && req.method === 'POST') {
      const b = new URLSearchParams(await readBody(req));
      const bad = (e, d) => json(res, 400, { error: e, error_description: d });
      const issue = () => { const at = '00D' + crypto.randomBytes(20).toString('hex'), rt = '5Aep' + crypto.randomBytes(20).toString('hex'); tokens.set(at, Date.now()); refresh.set(rt, 1); return { access_token: at, refresh_token: rt, instance_url: BASE, id: `${BASE}/id/${ORG_ID}/${USER_ID}`, token_type: 'Bearer', issued_at: String(Date.now()), signature: 'mock', scope: 'api refresh_token web id' }; };
      if (b.get('grant_type') === 'authorization_code') {
        const c = codes.get(b.get('code')); codes.delete(b.get('code'));
        if (!c || Date.now() - c.t > 600000) return bad('invalid_grant', 'authentication failure');
        if (c.redirect !== b.get('redirect_uri')) return bad('redirect_uri_mismatch', 'redirect_uri must match configuration');
        const h = crypto.createHash('sha256').update(b.get('code_verifier') || '').digest('base64url');
        if (h !== c.challenge) return bad('invalid_grant', 'code verifier invalid');
        return json(res, 200, issue());
      }
      if (b.get('grant_type') === 'refresh_token') { if (!refresh.has(b.get('refresh_token'))) return bad('invalid_grant', 'expired access/refresh token'); const o = issue(); delete o.refresh_token; return json(res, 200, o); }
      return bad('unsupported_grant_type', 'grant type not supported');
    }
    if (p === '/services/oauth2/revoke') { const b = new URLSearchParams(await readBody(req)); tokens.delete(b.get('token')); refresh.delete(b.get('token')); res.writeHead(200); return res.end(); }
    if (p === '/services/oauth2/userinfo') { if (!authed(req, res)) return; return json(res, 200, { sub: `${BASE}/id/${ORG_ID}/${USER_ID}`, user_id: USER_ID, organization_id: ORG_ID, preferred_username: 'demo@example.com', name: 'Demo Admin', email: 'demo@example.com' }); }
    if (p === '/__expire' && req.method === 'POST') { tokens.clear(); return json(res, 200, { ok: true }); } // test helper: invalidate every access token
    if (p.startsWith('/services/Soap/s/') && req.method === 'POST') {
      const body = await readBody(req);
      const sidTok = /<(?:\w+:)?sessionId>([^<]+)</.exec(body)?.[1];
      if (!tokens.has(sidTok)) { res.writeHead(500, { 'Content-Type': 'text/xml' }); return res.end('<?xml version="1.0"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body><soapenv:Fault><faultcode>sf:INVALID_SESSION_ID</faultcode><faultstring>INVALID_SESSION_ID: Invalid Session ID found in SessionHeader</faultstring></soapenv:Fault></soapenv:Body></soapenv:Envelope>'); }
      const code = unxml(/<(?:\w+:)?String>([\s\S]*?)<\/(?:\w+:)?String>/.exec(body)?.[1] || '');
      const { res: r, log } = fakeApex(code);
      const out = `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns="http://soap.sforce.com/2006/08/apex"><soapenv:Header><DebuggingInfo><debugLog>${xml(log)}</debugLog></DebuggingInfo></soapenv:Header><soapenv:Body><executeAnonymousResponse><result><column>${r.column}</column><compileProblem${r.compileProblem ? '>' + xml(r.compileProblem) + '</compileProblem>' : ' xsi:nil="true" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"/>'}<compiled>${r.compiled}</compiled><exceptionMessage${r.exceptionMessage ? '>' + xml(r.exceptionMessage) + '</exceptionMessage>' : ' xsi:nil="true" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"/>'}<exceptionStackTrace${r.exceptionStackTrace ? '>' + xml(r.exceptionStackTrace) + '</exceptionStackTrace>' : ' xsi:nil="true" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"/>'}<line>${r.line}</line><success>${r.success}</success></result></executeAnonymousResponse></soapenv:Body></soapenv:Envelope>`;
      res.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' }); return res.end(out);
    }
    if (p.startsWith('/services/data/')) {
      if (!authed(req, res)) return;
      const rest = p.replace(/^\/services\/data\/v[\d.]+/, '');
      if (rest === '/limits') return json(res, 200, { DailyApiRequests: { Max: 15000, Remaining: 14980 }, DataStorageMB: { Max: 5, Remaining: 4 }, FileStorageMB: { Max: 20, Remaining: 19 } });
      if (rest === '/sobjects') return json(res, 200, { sobjects: Object.keys(data).map((n) => ({ name: n, label: n.replace(/__c$/, '').replace(/_/g, ' '), labelPlural: n.replace(/__c$/, '').replace(/_/g, ' ') + 's', custom: n.endsWith('__c'), queryable: true, keyPrefix: String(data[n][0]?.Id || '').slice(0, 3) })).concat([{ name: 'AuditTrail__x', label: 'Hidden', labelPlural: 'Hidden', custom: true, queryable: false, keyPrefix: null }]) });
      const d = /^\/sobjects\/(\w+)\/describe$/.exec(rest);
      if (d) { const r = describe(d[1]); return r ? json(res, 200, r) : sfErr(res, 404, 'The requested resource does not exist', 'NOT_FOUND'); }
      const more = /^\/query\/01g([0-9a-f]{16})-2000$/.exec(rest);
      if (more) { const all = pages.get(more[1]); if (!all) return sfErr(res, 404, 'Query cursor expired', 'NOT_FOUND'); const next = all.slice(2000); return json(res, 200, next.length ? { totalSize: 2500, done: false, nextRecordsUrl: `/services/data/${V}/query/01g${more[1]}-4000`, records: all.slice(0, 2000) } : { totalSize: 2500, done: true, records: all }); }
      const more2 = /^\/query\/01g([0-9a-f]{16})-(\d+)$/.exec(rest);
      if (more2) { const all = pages.get(more2[1]); return all ? json(res, 200, { totalSize: 2500, done: true, records: all.slice(2000) }) : sfErr(res, 404, 'Query cursor expired', 'NOT_FOUND'); }
      if (/^\/(tooling\/)?query(All)?$/.test(rest)) {
        const soql = u.searchParams.get('q') || '';
        try { return json(res, 200, page(res, soql, rest.includes('tooling'))); } catch (e) { if (e instanceof SoqlError) return sfErr(res, 400, `\n${soql.split('\n')[0]}\n^\nERROR at Row:1:Column:1\n${e.message}`, 'MALFORMED_QUERY'); throw e; }
      }
    }
    sfErr(res, 404, 'The requested resource does not exist', 'NOT_FOUND');
  } catch (e) { console.error('[mock-sf]', e); try { sfErr(res, 500, String(e.message), 'UNKNOWN_EXCEPTION'); } catch { /* gone */ } }
});
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Mock Salesforce on ${BASE}`);
  console.log(`Run the site with:  SF_CLIENT_ID=mock SF_EXTRA_HOSTS=127.0.0.1:${PORT} SF_LOGIN_SCHEME=http npm run dev`);
  console.log(`Then Connect -> Custom domain -> 127.0.0.1:${PORT}  (login: any, click Log In, then Allow)`);
});
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => server.close(() => process.exit(0)));
