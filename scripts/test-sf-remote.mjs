// Hosted-API mode: a static site on ANOTHER origin uses the API with bearer tokens. Run: npm run test:sf-remote
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const MOCK = 4595, API = 4596, SITE = 'https://sanjay-kumar-b.github.io', EVIL = 'https://evil.example';
const here = path.dirname(fileURLToPath(import.meta.url));
const env = { ...process.env, SF_CLIENT_ID: 'mock-client', SF_EXTRA_HOSTS: `127.0.0.1:${MOCK}`, SF_LOGIN_SCHEME: 'http', SF_API_URL: `http://127.0.0.1:${API}`, SF_ALLOWED_ORIGINS: `${SITE}/, https://skode.pages.dev`, SF_SESSION_SECRET: 'x'.repeat(40), PORT: String(API), HOST: '127.0.0.1' };
const mock = spawn(process.execPath, [path.join(here, 'mock-sf.mjs'), '--port', String(MOCK)], { stdio: 'ignore' });
let api = null;
const startApi = async () => { api = spawn(process.execPath, [path.join(here, 'api-server.mjs')], { env, stdio: 'ignore' }); await new Promise((r) => setTimeout(r, 600)); };
const stopApi = async () => { api.kill(); await new Promise((r) => setTimeout(r, 300)); };
const cleanup = () => { mock.kill(); api?.kill(); };
process.on('exit', cleanup);
await new Promise((r) => setTimeout(r, 700));
await startApi();

const B = `http://127.0.0.1:${API}`;
let stateCookie = '';
async function call(p, { method = 'GET', body, token, origin = SITE, headers = {}, cookie = '' } = {}) {
  const r = await fetch(B + p, { method, redirect: 'manual', headers: { ...(origin ? { Origin: origin } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch { /* html */ }
  return { status: r.status, j, text, h: r.headers };
}
let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log('  ok  ', name); } catch (e) { fail++; console.log('  FAIL', name, '\n      ', e.message.split('\n').slice(0, 3).join(' | ')); } };

// Runs the whole login against the mock org the way a browser would, returning the API's callback response.
async function login(query) {
  const r = await call(`/api/sf/login?env=custom&domain=${encodeURIComponent('127.0.0.1:' + MOCK)}&returnTo=/playground/&${query}`, { origin: '' });
  assert.equal(r.status, 302, 'login redirect');
  const ls = (r.h.getSetCookie?.() || []).map((c) => c.split(';')[0]).find((c) => c.startsWith('sfp_ls='));
  assert.ok(ls, 'login-binding cookie');
  const u = new URL(r.h.get('location'));
  const allow = await fetch(`http://127.0.0.1:${MOCK}/services/oauth2/approve`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...Object.fromEntries(u.searchParams), a: 'allow' }) });
  const cb = new URL(allow.headers.get('location'));
  return call(cb.pathname + cb.search, { origin: '', cookie: ls });
}
const pageData = (html) => JSON.parse(/<script type="application\/json" id="sf-data">([\s\S]*?)<\/script>/.exec(html)[1]);

await t('CORS preflight: allowed site passes, other sites do not', async () => {
  const ok = await call('/api/sf/query', { method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' } });
  assert.equal(ok.status, 204); assert.equal(ok.h.get('access-control-allow-origin'), SITE); assert.match(ok.h.get('access-control-allow-headers'), /Authorization/i);
  assert.equal((await call('/api/sf/query', { method: 'OPTIONS', origin: EVIL })).status, 403);
  assert.equal((await call('/api/sf/query', { method: 'OPTIONS', origin: '' })).status, 403);
});
await t('config readable by the site; not by others', async () => {
  const a = await call('/api/sf/config'); assert.equal(a.j.configured, true); assert.equal(a.h.get('access-control-allow-origin'), SITE); assert.equal(a.j.redirectUri, `http://127.0.0.1:${API}/api/sf/callback`);
  assert.equal((await call('/api/sf/config', { origin: EVIL })).h.get('access-control-allow-origin'), null);
});
await t('login refuses sites that are not on the allow-list', async () => {
  for (const s of [EVIL, 'https://sanjay-kumar-b.github.io.evil.example', 'javascript:alert(1)', 'http://sanjay-kumar-b.github.io']) {
    const r = await call(`/api/sf/login?env=production&popup=1&site=${encodeURIComponent(s)}`, { origin: '' }); assert.equal(r.status, 400, s);
  }
});
let token = '';
await t('popup login: the token goes only to the allow-listed site, with a fragment fallback', async () => {
  const r = await login(`popup=1&site=${encodeURIComponent(SITE)}`);
  assert.equal(r.status, 200); const d = pageData(r.text);
  assert.equal(d.ok, true); assert.equal(d.site, SITE); assert.match(d.token, /^v1\./); assert.ok(d.token.length < 1500);
  assert.ok(d.fallback.startsWith(`${SITE}/playground/?connected=1#sf_token=`)); assert.match(d.fallback, /sf_popup=1$/);
  assert.ok(!(r.h.getSetCookie?.() || []).some((c) => c.startsWith('sfp_sid=') && !/Max-Age=0/.test(c)), 'no session cookie in hosted mode');
  token = d.token;
});
await t('bearer token: session, SOQL and Apex work cross-origin', async () => {
  const s = await call('/api/sf/session', { token }); assert.equal(s.j.connected, true); assert.equal(s.j.user.username, 'demo@example.com'); assert.equal(s.h.get('access-control-allow-origin'), SITE); assert.ok(!/access_token|refresh_token|5Aep|00D[0-9a-f]{20}/.test(s.text));
  const q = await call('/api/sf/query', { method: 'POST', token, body: { soql: 'SELECT COUNT() FROM Account' } }); assert.equal(q.j.totalSize, 20);
  const a = await call('/api/sf/apex', { method: 'POST', token, body: { code: "System.debug('hosted');" } }); assert.equal(a.j.success, true); assert.match(a.j.log, /hosted/);
  assert.equal((await call('/api/sf/describe?name=Contact', { token })).j.name, 'Contact');
});
await t('no token or wrong token means not connected', async () => {
  assert.equal((await call('/api/sf/session')).j.connected, false);
  assert.ok([401, 403].includes((await call('/api/sf/query', { method: 'POST', body: { soql: 'SELECT Id FROM Account' } })).status), 'a POST without a token is refused');
  const bad = token.slice(0, -4) + (token.endsWith('AAAA') ? 'BBBB' : 'AAAA'); assert.equal((await call('/api/sf/session', { token: bad })).j.connected, false);
  assert.equal((await call('/api/sf/session', { token: 'v1.' + 'A'.repeat(100) })).j.connected, false);
});
await t('a stolen token used from a foreign site is not readable and POST is refused', async () => {
  const s = await call('/api/sf/session', { token, origin: EVIL }); assert.equal(s.h.get('access-control-allow-origin'), null);
  assert.equal((await call('/api/sf/query', { method: 'POST', token, origin: EVIL, body: { soql: 'SELECT Id FROM Account' } })).status, 403);
});
await t('token survives an API restart (sealed session)', async () => {
  await stopApi(); await startApi();
  const s = await call('/api/sf/session', { token }); assert.equal(s.j.connected, true);
  await fetch(`http://127.0.0.1:${MOCK}/__expire`, { method: 'POST' });
  const q = await call('/api/sf/query', { method: 'POST', token, body: { soql: 'SELECT COUNT() FROM Lead' } }); assert.equal(q.j.totalSize, 25);
});
await t('redirect mode sends the token back in the URL fragment', async () => {
  const r = await login(`popup=0&site=${encodeURIComponent('https://skode.pages.dev')}`);
  assert.equal(r.status, 302); const loc = r.h.get('location');
  assert.ok(loc.startsWith('https://skode.pages.dev/playground/?connected=1#sf_token=v1.')); assert.ok(loc.endsWith('&sf_popup=0'));
});
await t('Salesforce error is reported to the site, not swallowed', async () => {
  const r = await call(`/api/sf/login?env=custom&domain=${encodeURIComponent('127.0.0.1:' + MOCK)}&popup=1&site=${encodeURIComponent(SITE)}`, { origin: '' });
  const ls = (r.h.getSetCookie?.() || []).map((c) => c.split(';')[0]).find((c) => c.startsWith('sfp_ls='));
  const st = new URL(r.h.get('location')).searchParams.get('state');
  const cb = await call(`/api/sf/callback?error=access_denied&error_description=user+denied&state=${st}`, { origin: '', cookie: ls });
  const d = pageData(cb.text); assert.equal(d.ok, false); assert.equal(d.error, 'access_denied'); assert.equal(d.site, SITE); assert.ok(d.fallback.includes('sf_error=access_denied')); assert.equal(d.token, null);
});
await t('another browser cannot finish a login it did not start (state cookie)', async () => {
  const r = await call(`/api/sf/login?env=custom&domain=${encodeURIComponent('127.0.0.1:' + MOCK)}&popup=1&site=${encodeURIComponent(SITE)}`, { origin: '' });
  const st = new URL(r.h.get('location')).searchParams.get('state');
  const cb = await call(`/api/sf/callback?code=abc&state=${st}`, { origin: '' });
  const d = pageData(cb.text); assert.equal(d.ok, false); assert.equal(d.error, 'state_mismatch');
});
await t('bring your own app: a visitor\'s own Consumer Key works, also after a restart and a token refresh', async () => {
  const own = '3MVG9OwnAppKeyFromVisitorOrg.12345';
  const bad = await call(`/api/sf/login?env=production&popup=1&client_id=${encodeURIComponent('short key!')}&site=${encodeURIComponent(SITE)}`, { origin: '' });
  assert.equal(bad.status, 400);
  const r = await call(`/api/sf/login?env=custom&domain=${encodeURIComponent('127.0.0.1:' + MOCK)}&returnTo=/playground/&popup=1&client_id=${own}&site=${encodeURIComponent(SITE)}`, { origin: '' });
  assert.equal(r.status, 302); assert.equal(new URL(r.h.get('location')).searchParams.get('client_id'), own);
  const ls = (r.h.getSetCookie?.() || []).map((c) => c.split(';')[0]).find((c) => c.startsWith('sfp_ls='));
  const u = new URL(r.h.get('location'));
  const allow = await fetch(`http://127.0.0.1:${MOCK}/services/oauth2/approve`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...Object.fromEntries(u.searchParams), a: 'allow' }) });
  const cb = new URL(allow.headers.get('location'));
  const page = await call(cb.pathname + cb.search, { origin: '', cookie: ls });
  const d = pageData(page.text); assert.equal(d.ok, true); const tk = d.token;
  assert.equal((await call('/api/sf/session', { token: tk })).j.connected, true);
  await stopApi(); await startApi();
  await fetch(`http://127.0.0.1:${MOCK}/__expire`, { method: 'POST' });
  const q = await call('/api/sf/query', { method: 'POST', token: tk, body: { soql: 'SELECT COUNT() FROM Account' } }); assert.equal(q.j.totalSize, 20);
  await call('/api/sf/logout', { method: 'POST', token: tk, body: {} });
});
await t('logout with the token revokes it for good', async () => {
  const o = await call('/api/sf/logout', { method: 'POST', token, body: {} }); assert.equal(o.j.ok, true);
  const s = await call('/api/sf/session', { token }); assert.equal(s.j.connected, false);
  await stopApi(); await startApi();
  assert.equal((await call('/api/sf/session', { token })).j.connected, false);
});
console.log(`\n${pass} passed, ${fail} failed`);
cleanup();
process.exit(fail ? 1 : 0);
