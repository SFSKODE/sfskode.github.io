// End-to-end test of the Salesforce playground API against the mock org. Run: npm run test:sf
import http from 'node:http';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const MOCK = 4591, SITE = 4592;
const here = path.dirname(fileURLToPath(import.meta.url));
Object.assign(process.env, { SF_CLIENT_ID: 'mock-client', SF_EXTRA_HOSTS: `127.0.0.1:${MOCK}`, SF_LOGIN_SCHEME: 'http', SITE_URL: `http://127.0.0.1:${SITE}` });
const { handleSalesforceApi } = await import('./sf-api.mjs');

const mock = spawn(process.execPath, [path.join(here, 'mock-sf.mjs'), '--port', String(MOCK)], { stdio: 'ignore' });
const site = http.createServer((req, res) => { if (!handleSalesforceApi(req, res)) { res.writeHead(404); res.end('x'); } }).listen(SITE, '127.0.0.1');
const cleanup = () => { mock.kill(); site.close(); };
process.on('exit', cleanup);
await new Promise((r) => setTimeout(r, 700));

const B = `http://127.0.0.1:${SITE}`;
const jar = {};
const cookieHeader = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
const eatCookies = (r) => { for (const c of r.headers.getSetCookie?.() || []) { const [kv] = c.split(';'); const i = kv.indexOf('='); const k = kv.slice(0, i), v = kv.slice(i + 1); if (/Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(c)) delete jar[k]; else jar[k] = v; } };
async function call(p, { method = 'GET', body, headers = {}, raw = false, redirect = 'manual' } = {}) {
  const r = await fetch(B + p, { method, redirect, headers: { Cookie: cookieHeader(), ...(body !== undefined && !raw ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : raw ? body : JSON.stringify(body) });
  eatCookies(r);
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch { /* html */ }
  return { status: r.status, j, t, h: r.headers };
}
let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log('  ok  ', name); } catch (e) { fail++; console.log('  FAIL', name, '\n      ', e.message.split('\n').slice(0, 3).join(' | ')); } };

await t('config is configured and lists 3 environments', async () => {
  const r = await call('/api/sf/config'); assert.equal(r.j.configured, true); assert.equal(r.j.environments.length, 3); assert.match(r.j.redirectUri, /\/api\/sf\/callback$/);
});
await t('not connected before login', async () => { const r = await call('/api/sf/session'); assert.equal(r.j.connected, false); const q = await call('/api/sf/query', { method: 'POST', body: { soql: 'SELECT Id FROM Account' } }); assert.equal(q.status, 401); assert.equal(q.j.error, 'not_connected'); });
await t('login redirects: production, sandbox, custom', async () => {
  const p = await call('/api/sf/login?env=production&popup=1'); assert.equal(p.status, 302); assert.match(p.h.get('location'), /^https:\/\/login\.salesforce\.com\/services\/oauth2\/authorize\?/); assert.match(p.h.get('location'), /code_challenge_method=S256/);
  const s = await call('/api/sf/login?env=sandbox'); assert.match(s.h.get('location'), /^https:\/\/test\.salesforce\.com\//);
  const c = await call('/api/sf/login?env=custom&domain=acme.my.salesforce.com'); assert.match(c.h.get('location'), /^https:\/\/acme\.my\.salesforce\.com\//);
});
await t('rejects unsafe domains and bad env', async () => {
  for (const d of ['evil.example.com', 'login.salesforce.com.evil.com', 'acme.my.salesforce.com@evil.com', 'http://x.my.salesforce.com', '127.0.0.1:9999', '']) { const r = await call(`/api/sf/login?env=custom&domain=${encodeURIComponent(d)}`); assert.equal(r.status, 400, d); }
  assert.equal((await call('/api/sf/login?env=moon')).status, 400);
});
let authUrl;
await t('custom login to the mock host works (PKCE, state)', async () => {
  const r = await call(`/api/sf/login?env=custom&domain=${encodeURIComponent('127.0.0.1:' + MOCK)}&popup=1&returnTo=/playground/`);
  assert.equal(r.status, 302); authUrl = r.h.get('location'); assert.match(authUrl, new RegExp(`^http://127\\.0\\.0\\.1:${MOCK}/services/oauth2/authorize`)); assert.ok(jar.sfp_ls, 'login-binding cookie set');
});
await t('state reuse / forged callback is rejected', async () => {
  const saved = { ...jar }; // a forged callback clears the login-binding cookie; keep it for the real one below
  const r = await call('/api/sf/callback?code=abc&state=forged'); assert.ok(/"ok":false|ok:false|Could not connect/.test(r.t) || r.status >= 400); assert.ok(!jar.sfp_sid);
  Object.assign(jar, saved);
});
await t('mock login + allow + callback creates the session (popup page)', async () => {
  const u = new URL(authUrl);
  const allow = await fetch(`http://127.0.0.1:${MOCK}/services/oauth2/approve`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...Object.fromEntries(u.searchParams), a: 'allow' }) });
  assert.equal(allow.status, 302); const cb = new URL(allow.headers.get('location'));
  const r = await call(cb.pathname + cb.search); assert.equal(r.status, 200); assert.match(r.t, /sf-connected/); assert.ok(jar.sfp_sid, 'session cookie'); assert.ok(!r.t.includes('00D5'), 'no token in page');
  const set = (await fetch(B + '/api/sf/session', { headers: { Cookie: cookieHeader() } })).headers.get('set-cookie'); assert.equal(set, null);
});
await t('session shows user and org, no tokens', async () => {
  const r = await call('/api/sf/session'); assert.equal(r.j.connected, true); assert.equal(r.j.user.username, 'demo@example.com'); assert.equal(r.j.org.isSandbox, true); assert.ok(!/access_token|refresh_token|00D[0-9a-f]{20}/.test(r.t));
});
await t('SOQL: basic, relationship, aggregate, error shape', async () => {
  let r = await call('/api/sf/query', { method: 'POST', body: { soql: "SELECT Id, Name, Account.Name FROM Contact WHERE Title = 'CTO' ORDER BY Name LIMIT 5" } }); assert.equal(r.j.ok, true); assert.equal(r.j.records.length, 5); assert.ok(r.j.records[0].Account.Name); assert.ok(!JSON.stringify(r.j).includes('attributes'));
  r = await call('/api/sf/query', { method: 'POST', body: { soql: 'SELECT Industry, COUNT(Id) n FROM Account GROUP BY Industry' } }); assert.equal(r.j.ok, true); assert.ok(r.j.records.length >= 5);
  r = await call('/api/sf/query', { method: 'POST', body: { soql: 'SELECT COUNT() FROM Account' } }); assert.equal(r.j.totalSize, 20);
  r = await call('/api/sf/query', { method: 'POST', body: { soql: 'SELEKT Id FROM Account' } }); assert.equal(r.j.ok, false); assert.match(r.j.message, /unexpected token|MALFORMED/i);
});
await t('SOQL pagination with query-more', async () => {
  let r = await call('/api/sf/query', { method: 'POST', body: { soql: 'SELECT Id, Name FROM Big__c' } }); assert.equal(r.j.records.length, 2000); assert.equal(r.j.done, false); assert.ok(r.j.nextCursor);
  const m = await call('/api/sf/query-more', { method: 'POST', body: { cursor: r.j.nextCursor } }); assert.equal(m.j.ok, true); assert.equal(m.j.records.length, 500); assert.equal(m.j.done, true);
  const bad = await call('/api/sf/query-more', { method: 'POST', body: { cursor: 'https://evil.example.com/x' } }); assert.equal(bad.status, 400);
});
await t('Apex: success log, compile error, exception', async () => {
  let r = await call('/api/sf/apex', { method: 'POST', body: { code: "System.debug('Hello Trailblazer');\nList<Account> a = [SELECT Id FROM Account];" } }); assert.equal(r.j.ok, true); assert.equal(r.j.success, true); assert.match(r.j.log, /USER_DEBUG\|\[1\]\|DEBUG\|Hello Trailblazer/); assert.match(r.j.log, /SOQL_EXECUTE_BEGIN/);
  r = await call('/api/sf/apex', { method: 'POST', body: { code: 'COMPILE_ERROR' } }); assert.equal(r.j.compiled, false); assert.ok(r.j.compileProblem);
  r = await call('/api/sf/apex', { method: 'POST', body: { code: 'Account a;\nTHROW_NPE' } }); assert.equal(r.j.compiled, true); assert.equal(r.j.success, false); assert.match(r.j.exceptionMessage, /NullPointer/);
});
await t('describe-global and describe (hides non-queryable)', async () => {
  const g = await call('/api/sf/describe-global'); assert.ok(g.j.objects.find((o) => o.name === 'Account')); assert.ok(!g.j.objects.find((o) => o.name === 'AuditTrail__x'));
  const d = await call('/api/sf/describe?name=Contact'); assert.ok(d.j.fields.find((f) => f.name === 'AccountId' && f.referenceTo[0] === 'Account'));
  assert.equal((await call('/api/sf/describe?name=Bad%20Name')).status, 400);
});
await t('limits', async () => { const r = await call('/api/sf/limits'); assert.equal(r.j.apiRequests.max, 15000); });
await t('CSRF: foreign Origin, wrong content type, oversize body', async () => {
  assert.equal((await call('/api/sf/query', { method: 'POST', body: { soql: 'SELECT Id FROM Account' }, headers: { Origin: 'https://evil.example.com' } })).status, 403);
  assert.equal((await call('/api/sf/query', { method: 'POST', raw: true, body: 'soql=x', headers: { 'Content-Type': 'text/plain' } })).status >= 400, true);
  assert.equal((await call('/api/sf/query', { method: 'POST', raw: true, body: '{bad json', headers: { 'Content-Type': 'application/json' } })).status, 400);
  assert.equal((await call('/api/sf/apex', { method: 'POST', body: { code: 'x'.repeat(250 * 1024) } })).status, 413);
});
await t('expired access token is refreshed transparently', async () => {
  await fetch(`http://127.0.0.1:${MOCK}/__expire`, { method: 'POST' });
  const r = await call('/api/sf/query', { method: 'POST', body: { soql: 'SELECT COUNT() FROM Lead' } }); assert.equal(r.j.ok, true); assert.equal(r.j.totalSize, 25);
  await fetch(`http://127.0.0.1:${MOCK}/__expire`, { method: 'POST' });
  const a = await call('/api/sf/apex', { method: 'POST', body: { code: "System.debug('after refresh');" } }); assert.equal(a.j.ok, true); assert.equal(a.j.success, true);
});
await t('unknown route 404, wrong method 405', async () => { assert.equal((await call('/api/sf/nope')).status, 404); assert.equal((await call('/api/sf/query')).status, 405); });
await t('rate limit kicks in', async () => {
  let limited = false; for (let i = 0; i < 120 && !limited; i++) { const r = await call('/api/sf/limits'); if (r.status === 429) { limited = true; assert.equal(r.j.error, 'rate_limited'); } } assert.ok(limited);
});
await t('logout ends the session', async () => {
  await new Promise((r) => setTimeout(r, 100));
  const o = await call('/api/sf/logout', { method: 'POST', body: {} });
  if (o.status === 429) { /* limiter still hot from the previous test: logout is still expected to work after the window */ await new Promise((r) => setTimeout(r, 61000)); }
  const o2 = o.status === 429 ? await call('/api/sf/logout', { method: 'POST', body: {} }) : o;
  assert.equal(o2.j.ok, true); const s = await call('/api/sf/session'); assert.equal(s.j.connected, false);
});
console.log(`\n${pass} passed, ${fail} failed`);
cleanup();
process.exit(fail ? 1 : 0);
