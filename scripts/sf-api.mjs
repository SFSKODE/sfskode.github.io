// Salesforce playground backend. Dependency-free (node:http compatible handler, global fetch, node:crypto).
//
//   import { handleSalesforceApi } from './sf-api.mjs';
//   if (handleSalesforceApi(req, res, { headers })) return;   // true => the request was handled (async)
//
// Mounted by scripts/server.mjs (production) and by a small Vite plugin in astro.config.mjs (dev).
//
// Security model: OAuth 2.0 Authorization Code + PKCE (S256). Salesforce tokens live only in this process's
// memory (a Map keyed by a random session id); the browser only ever holds the opaque HttpOnly cookie `sfp_sid`.
// Tokens, codes and secrets are never logged.
//
// Two ways to talk to it:
//   1. Same site (default): the site and this API share one origin; the browser holds the HttpOnly cookie `sfp_sid`.
//   2. Hosted API (static site on another origin, e.g. GitHub Pages / Cloudflare Pages): set SF_ALLOWED_ORIGINS to the
//      site origin(s). The login passes `site=<origin>`; the finished session token goes back to that origin only
//      (postMessage with an explicit target origin, or a URL fragment) and is then sent as `Authorization: Bearer`.
//      With SF_SESSION_SECRET set, that token is an encrypted blob, so sessions survive restarts and sleeping hosts.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------
const COOKIE = 'sfp_sid';            // session cookie
const STATE_COOKIE = 'sfp_ls';       // binds a login attempt to the browser that started it (login CSRF defence)
const SESSION_MAX_AGE_SEC = 8 * 3600;
const DEFAULT_IDLE_TTL_SEC = 2 * 3600;
const PENDING_TTL_MS = 10 * 60 * 1000;
const MAX_SESSIONS = 100;
const MAX_PENDING = 300;
const RATE_LIMIT_PER_MIN = 90;
const IP_RATE_LIMIT_PER_MIN = 30;
const MAX_BODY = 200 * 1024;
const MAX_APEX_CODE = 100 * 1024;
const MAX_SOQL = 100 * 1024;
const MAX_LOG_BYTES = 2 * 1024 * 1024;
const MAX_SF_BODY = 16 * 1024 * 1024;
const SF_TIMEOUT_MS = 30_000;
const DEFAULT_API_VERSION = 'v62.0';
const DEFAULT_RETURN_TO = '/playground/';
const SCOPE = 'api refresh_token web id';
const PLACEHOLDER_SITE = 'https://example.com';

const ENVIRONMENTS = [
  { id: 'production', label: 'Production / Developer Edition', host: 'login.salesforce.com' },
  { id: 'sandbox', label: 'Sandbox', host: 'test.salesforce.com' },
  { id: 'custom', label: 'Custom domain (My Domain)', host: null },
];

// Allow-list for user-supplied login domains and for the instance_url Salesforce returns.
// (*.my.salesforce.com, *.sandbox.my.salesforce.com, *.develop.my.salesforce.com are subsets of *.salesforce.com.)
const ALLOWED_SUFFIXES = ['.salesforce.com', '.force.com', '.salesforce.mil', '.cloudforce.com', '.salesforce-setup.com'];
const HOSTNAME_RE = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}[a-z0-9]$/;

const LOG_LEVELS = new Set(['NONE', 'ERROR', 'WARN', 'INFO', 'DEBUG', 'FINE', 'FINER', 'FINEST']);

// ---------------------------------------------------------------------------------------------
// Configuration: process.env first, then project-root .env (never overrides real env vars)
// ---------------------------------------------------------------------------------------------
export function parseDotEnv(text) {
  const out = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if (v.startsWith('"')) {
      const end = v.indexOf('"', 1);
      v = (end > 0 ? v.slice(1, end) : v.slice(1)).replace(/\\n/g, '\n').replace(/\\"/g, '"');
    } else if (v.startsWith("'")) {
      const end = v.indexOf("'", 1);
      v = end > 0 ? v.slice(1, end) : v.slice(1);
    } else {
      v = v.replace(/\s+#.*$/, '').trim();
    }
    out[m[1]] = v;
  }
  return out;
}

let fileEnv = {};
let fileEnvPath = null;
let fileEnvMtime = -1;
let fileEnvChecked = 0;

function refreshFileEnv() {
  const p = process.env.SF_ENV_FILE !== undefined ? process.env.SF_ENV_FILE : path.join(ROOT, '.env');
  const now = Date.now();
  if (p === fileEnvPath && now - fileEnvChecked < 5000) return;
  if (p !== fileEnvPath) { fileEnv = {}; fileEnvMtime = -1; fileEnvPath = p; }
  fileEnvChecked = now;
  if (!p) return;
  try {
    const st = fs.statSync(p);
    if (st.mtimeMs === fileEnvMtime) return;
    fileEnvMtime = st.mtimeMs;
    fileEnv = parseDotEnv(fs.readFileSync(p, 'utf8'));
  } catch {
    fileEnv = {};
    fileEnvMtime = -1;
  }
}

function envVal(name) {
  const v = process.env[name];
  if (v !== undefined) return String(v).trim();
  const f = fileEnv[name];
  return f === undefined ? '' : String(f).trim();
}

/** "https://Example.com/" -> "https://example.com"; anything that is not a plain http(s) origin -> ''. */
function normOrigin(v) {
  try {
    const u = new URL(String(v).trim());
    if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password) return '';
    return u.origin;
  } catch { return ''; }
}

function normalizeVersion(v) {
  const m = /^v?(\d{2,3})(?:\.0)?$/i.exec(String(v || '').trim());
  return m ? `v${m[1]}.0` : DEFAULT_API_VERSION;
}

function getConfig() {
  refreshFileEnv();
  const idle = Number(envVal('SF_IDLE_TTL_SEC'));
  return {
    clientId: envVal('SF_CLIENT_ID'),
    clientSecret: envVal('SF_CLIENT_SECRET'),
    redirectUri: envVal('SF_REDIRECT_URI'),
    apiVersion: normalizeVersion(envVal('SF_API_VERSION')),
    siteUrl: envVal('SITE_URL'),
    apiUrl: envVal('SF_API_URL') || envVal('RENDER_EXTERNAL_URL'),
    allowedOrigins: envVal('SF_ALLOWED_ORIGINS').split(',').map(normOrigin).filter(Boolean),
    sessionSecret: envVal('SF_SESSION_SECRET'),
    extraHosts: envVal('SF_EXTRA_HOSTS').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    loginScheme: envVal('SF_LOGIN_SCHEME').toLowerCase() === 'http' ? 'http' : 'https',
    idleTtlMs: (idle > 0 ? idle : DEFAULT_IDLE_TTL_SEC) * 1000,
  };
}

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------
class ApiError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const rand = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
const sha256b64url = (s) => crypto.createHash('sha256').update(s).digest('base64url');
const firstHeader = (req, name) => String(req.headers[name] || '').split(',')[0].trim();
const now = () => Date.now();

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k && !(k in out)) out[k] = part.slice(i + 1).trim();
  }
  return out;
}

function cookieHeader(name, value, { secure, maxAge, path: p = '/' }) {
  return `${name}=${value}; Path=${p}; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

function publicOrigin(req, cfg, opts) {
  if (typeof opts.origin === 'string' && opts.origin) return opts.origin.replace(/\/+$/, '');
  if (typeof opts.origin === 'function') { const o = opts.origin(req); if (o) return String(o).replace(/\/+$/, ''); }
  if (cfg.apiUrl) { const o = normOrigin(cfg.apiUrl); if (o) return o; }
  if (cfg.siteUrl && cfg.siteUrl.replace(/\/+$/, '') !== PLACEHOLDER_SITE) {
    try { return new URL(cfg.siteUrl).origin; } catch { /* fall through */ }
  }
  let proto = firstHeader(req, 'x-forwarded-proto').toLowerCase();
  if (proto !== 'http' && proto !== 'https') proto = req.socket && req.socket.encrypted ? 'https' : 'http';
  let host = firstHeader(req, 'x-forwarded-host') || String(req.headers.host || '');
  if (!/^[A-Za-z0-9.\-:[\]]{1,260}$/.test(host)) host = 'localhost';
  return `${proto}://${host}`;
}

function clientIp(req) {
  return firstHeader(req, 'x-forwarded-for') || (req.socket && req.socket.remoteAddress) || 'unknown';
}

function safeReturnTo(v) {
  if (typeof v !== 'string' || v.length > 300) return DEFAULT_RETURN_TO;
  if (!v.startsWith('/') || v.startsWith('//') || v.startsWith('/\\') || /[\u0000-\u001f\u007f\\]/.test(v)) return DEFAULT_RETURN_TO;
  return v;
}

function withParam(p, key, value) {
  const u = new URL(p, 'http://local.invalid');
  u.searchParams.set(key, value);
  return u.pathname + u.search + u.hash;
}

const trunc = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n) + '...' : s; };

// ---------------------------------------------------------------------------------------------
// Hosts
// ---------------------------------------------------------------------------------------------
function isSalesforceHostname(h) {
  h = String(h).toLowerCase();
  return HOSTNAME_RE.test(h) && ALLOWED_SUFFIXES.some((s) => h.endsWith(s));
}

/** Returns { host, scheme } for a login host, or throws invalid_domain / invalid_env. */
function resolveLoginHost(env, domain, cfg) {
  if (env === 'production') return { host: 'login.salesforce.com', scheme: 'https' };
  if (env === 'sandbox') return { host: 'test.salesforce.com', scheme: 'https' };
  if (env !== 'custom') throw new ApiError(400, 'invalid_env', 'env must be production, sandbox or custom.');
  let d = String(domain || '').trim().toLowerCase();
  if (!d) throw new ApiError(400, 'invalid_domain', 'Enter your My Domain host name, for example mycompany.my.salesforce.com.');
  if (cfg.extraHosts.includes(d)) return { host: d, scheme: cfg.loginScheme };
  if (d.endsWith('.lightning.force.com')) d = d.replace(/\.lightning\.force\.com$/, '.my.salesforce.com');
  if (!isSalesforceHostname(d)) {
    throw new ApiError(
      400,
      'invalid_domain',
      'That is not an allowed Salesforce domain. Use only the host name (no https://, path or port), for example mycompany.my.salesforce.com.',
    );
  }
  return { host: d, scheme: 'https' };
}

/** Validates the instance_url returned by Salesforce. Returns its origin, or null if not acceptable. */
function validateInstanceUrl(raw, cfg) {
  let u;
  try { u = new URL(String(raw)); } catch { return null; }
  if (u.username || u.password) return null;
  const host = u.host.toLowerCase();
  if (cfg.extraHosts.includes(host)) return u.protocol === `${cfg.loginScheme}:` ? u.origin : null;
  if (u.protocol !== 'https:' || u.port || !isSalesforceHostname(u.hostname)) return null;
  return u.origin;
}

// ---------------------------------------------------------------------------------------------
// State: sessions, pending logins, rate limits
// ---------------------------------------------------------------------------------------------
const sessions = new Map();   // sid -> session
const pending = new Map();    // state -> { verifier, host, scheme, popup, returnTo, redirectUri, createdAt }
const ipHits = new Map();     // ip -> { start, count }
let sweeper = null;

function ensureSweeper() {
  if (sweeper) return;
  sweeper = setInterval(sweep, 60_000);
  if (sweeper.unref) sweeper.unref();
}

function sweep() {
  const t = now();
  const cfg = getConfig();
  for (const [sid, s] of sessions) if (t - s.lastSeen > cfg.idleTtlMs || t > s.expiresAt) sessions.delete(sid);
  for (const [st, p] of pending) if (t - p.createdAt > PENDING_TTL_MS) pending.delete(st);
  for (const [ip, h] of ipHits) if (t - h.start > 60_000) ipHits.delete(ip);
}

function hit(bucket, limit) {
  const t = now();
  if (!bucket.start || t - bucket.start >= 60_000) { bucket.start = t; bucket.count = 0; }
  bucket.count += 1;
  return bucket.count > limit ? Math.max(1, Math.ceil((bucket.start + 60_000 - t) / 1000)) : 0;
}

function limitIp(req) {
  const ip = clientIp(req);
  let b = ipHits.get(ip);
  if (!b) {
    if (ipHits.size >= 1000) ipHits.delete(ipHits.keys().next().value);
    b = { start: 0, count: 0 };
    ipHits.set(ip, b);
  }
  const wait = hit(b, IP_RATE_LIMIT_PER_MIN);
  if (wait) throw new ApiError(429, 'rate_limited', 'Too many requests. Please wait a minute.', { retryAfter: wait });
}

// Sealed sessions: the token itself carries the (encrypted) session, so nothing is lost when a free host restarts.
// AES-256-GCM, key derived from SF_SESSION_SECRET. The browser cannot read or change it.
const SEALED_PREFIX = 'v1.';
// "Bring your own app": a visitor's own Connected / External Client App (Consumer Key), used when the shared app is blocked in their org.
const OWN_CLIENT_RE = /^[A-Za-z0-9._]{20,255}$/;
const SID_RE = /^(?:[A-Za-z0-9_-]{43}|v1\.[A-Za-z0-9_-]{40,3000})$/;
const sealKey = (secret) => crypto.createHash('sha256').update(`sfp-session-v1:${secret}`).digest();

function sealSession(secret, s) {
  const payload = JSON.stringify({ rt: s.refreshToken, iu: s.instanceUrl, lh: s.loginHost, ls: s.loginScheme, c: s.byo ? s.clientId : undefined, u: s.user, o: s.orgId || null, exp: s.expiresAt });
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', sealKey(secret), iv);
  const enc = Buffer.concat([c.update(payload, 'utf8'), c.final()]);
  return SEALED_PREFIX + Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64url');
}

function unsealSession(secret, token) {
  try {
    const raw = Buffer.from(token.slice(SEALED_PREFIX.length), 'base64url');
    if (raw.length < 12 + 16 + 2) return null;
    const d = crypto.createDecipheriv('aes-256-gcm', sealKey(secret), raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    const j = JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8'));
    if (!j || typeof j.rt !== 'string' || typeof j.iu !== 'string' || typeof j.lh !== 'string' || !(j.exp > now())) return null;
    return j;
  } catch { return null; }
}

/** The session id the request carries: `Authorization: Bearer <token>` (hosted API) or the cookie (same site). */
function requestSid(req) {
  const m = /^Bearer\s+([A-Za-z0-9._-]{20,3100})$/.exec(String(req.headers.authorization || ''));
  const sid = m ? m[1] : parseCookies(req)[COOKIE];
  return sid && SID_RE.test(sid) ? sid : null;
}

function lookupSession(req, cfg) {
  const sid = requestSid(req);
  if (!sid) return null;
  let s = sessions.get(sid);
  if (!s && sid.startsWith(SEALED_PREFIX) && cfg.sessionSecret) {
    const j = unsealSession(cfg.sessionSecret, sid);
    const iu = j && validateInstanceUrl(j.iu, cfg);
    if (!iu) return null;
    const t = now();
    s = {
      sid, accessToken: null, refreshToken: j.rt, instanceUrl: iu, loginHost: j.lh, loginScheme: j.ls === 'http' ? 'http' : 'https', clientId: OWN_CLIENT_RE.test(j.c || '') ? j.c : null, byo: OWN_CLIENT_RE.test(j.c || ''),
      user: j.u || { name: null, username: null, email: null, userId: null }, org: null, orgId: j.o || null, orgTried: 0,
      createdAt: t, lastSeen: t, expiresAt: j.exp, rl: { start: 0, count: 0 }, cache: new Map(), refreshing: null,
    };
    if (sessions.size >= MAX_SESSIONS) {
      let oldest = null;
      for (const v of sessions.values()) if (!oldest || v.lastSeen < oldest.lastSeen) oldest = v;
      if (oldest) sessions.delete(oldest.sid);
    }
    sessions.set(sid, s);
  }
  if (!s) return null;
  const t = now();
  if (t - s.lastSeen > cfg.idleTtlMs || t > s.expiresAt) { sessions.delete(sid); return null; }
  s.lastSeen = t;
  return s;
}

function dropSession(s) {
  if (s && s.sid) sessions.delete(s.sid);
}

// ---------------------------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------------------------
function baseHeaders(ctx, extra) {
  const cors = ctx.cors ? { 'Access-Control-Allow-Origin': ctx.cors, Vary: 'Origin', 'Access-Control-Expose-Headers': 'Retry-After' } : {};
  return { ...(ctx.opts.headers || {}), 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', ...cors, ...extra };
}

function send(ctx, status, body, headers = {}) {
  const { res } = ctx;
  if (res.headersSent || res.writableEnded) return;
  const h = baseHeaders(ctx, headers);
  if (ctx.cookies.length) h['Set-Cookie'] = ctx.cookies;
  const buf = Buffer.from(body, 'utf8');
  h['Content-Length'] = buf.length;
  res.writeHead(status, h);
  res.end(ctx.req.method === 'HEAD' ? undefined : buf);
}

function sendJson(ctx, status, obj, headers = {}) {
  send(ctx, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', ...headers });
}

function sendRedirect(ctx, location) {
  const { res } = ctx;
  const h = baseHeaders(ctx, { Location: location, 'Content-Length': 0 });
  if (ctx.cookies.length) h['Set-Cookie'] = ctx.cookies;
  res.writeHead(302, h);
  res.end();
}

function sendError(ctx, err) {
  if (!(err instanceof ApiError)) {
    console.error('[sf-api] unexpected error:', err && err.message ? err.message : String(err));
    err = new ApiError(500, 'server_error', 'Unexpected server error.');
  }
  const body = { ok: false, error: err.code, message: err.message };
  if (err.extra.status !== undefined) body.status = err.extra.status;
  if (err.extra.detail !== undefined) body.detail = err.extra.detail;
  const headers = {};
  if (err.extra.retryAfter) headers['Retry-After'] = String(err.extra.retryAfter);
  sendJson(ctx, err.status, body, headers);
}

const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * Small accessible result page for the OAuth popup. popup === true: post to opener and close.
 * popup === null (unknown login attempt): post only if a opener exists.
 */
function renderResultPage({ ok, error, message, popup, returnTo, site, token }) {
  // Hosted API: `fallback` is where this window goes if it cannot hand the result to the opener (see script below).
  const fallback = site ? (ok ? `${site}${withParam(returnTo, 'connected', '1')}#sf_token=${encodeURIComponent(token || '')}&sf_popup=${popup ? 1 : 0}` : `${site}${withParam(returnTo, 'sf_error', String(error || 'error').slice(0, 64))}`) : null;
  const data = JSON.stringify({ ok, error: error || null, message: message || null, popup, site: site || null, token: site && ok ? token : null, fallback }).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  const back = site ? fallback : ok ? withParam(returnTo, 'connected', '1') : withParam(returnTo, 'sf_error', String(error || 'error').slice(0, 64));
  const title = ok ? 'Connected to Salesforce' : 'Could not connect to Salesforce';
  const text = ok
    ? 'You are connected. This window should close by itself; if it does not, you can close it and return to the playground.'
    : escHtml(message || 'Something went wrong while connecting to Salesforce.');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="referrer" content="no-referrer">
<title>${escHtml(title)}</title>
<style>
:root{color-scheme:light dark;--bg:#fff;--fg:#14171c;--muted:#4a5260;--accent:#0b5cd5;--ok:#0a7a3d;--bad:#b42318}
@media (prefers-color-scheme:dark){:root{--bg:#10141a;--fg:#eef1f5;--muted:#a9b2c0;--accent:#7db1ff;--ok:#5ad08a;--bad:#ff8a80}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;display:grid;place-items:center;min-height:100vh;padding:16px;box-sizing:border-box}
main{max-width:30rem}
h1{font-size:1.4rem;margin:0 0 .5rem;color:var(${ok ? '--ok' : '--bad'})}
p{margin:.5rem 0;color:var(--muted)}
a{color:var(--accent);font-weight:600}
a:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
</style>
</head>
<body>
<main role="main">
<h1 id="t">${escHtml(title)}</h1>
<p id="m" role="${ok ? 'status' : 'alert'}" aria-live="polite">${text}</p>
<p><a id="back" href="${escHtml(back)}">Back to the playground</a></p>
</main>
<script type="application/json" id="sf-data">${data}</script>
<script>
(function () {
  var d = JSON.parse(document.getElementById('sf-data').textContent);
  var msg = d.ok ? { type: 'sf-connected', ok: true } : { type: 'sf-connected', ok: false, error: d.error, message: d.message };
  var delivered = false;
  if (d.site) {
    // Hosted API: talk only to the site that started the login (explicit target origin), wait for its acknowledgement,
    // and fall back to opening the site with the result in the URL fragment if there is no opener (browser isolation).
    var rmsg = d.ok ? { type: 'sf-connected', ok: true, token: d.token } : { type: 'sf-connected', ok: false, error: d.error, message: d.message };
    var gone = false;
    var jump = function () { if (!gone) { gone = true; location.replace(d.fallback); } };
    var op = null; try { op = window.opener; } catch (e) {}
    if (d.popup && op && !op.closed) {
      window.addEventListener('message', function (ev) {
        if (ev.origin === d.site && ev.data && ev.data.type === 'sf-ack') { gone = true; try { window.close(); } catch (e) {} }
      });
      try { op.postMessage(rmsg, d.site); } catch (e) {}
      setTimeout(jump, 1800);
    } else { jump(); }
    return;
  }
  if (d.popup !== false) {
    try {
      if (window.opener && !window.opener.closed) { window.opener.postMessage(msg, window.location.origin); delivered = true; }
    } catch (e) {}
    try {
      // Fallback for browsers that cut window.opener after cross-origin navigation (COOP).
      var bc = new BroadcastChannel('sf-playground'); bc.postMessage(msg); bc.close(); delivered = true;
    } catch (e) {}
  }
  if (delivered && d.popup === true) { setTimeout(function () { try { window.close(); } catch (e) {} }, 150); }
})();
</script>
</body>
</html>
`;
}

function sendResultPage(ctx, status, page) {
  send(ctx, status, renderResultPage(page), {
    'Content-Type': 'text/html; charset=utf-8',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
  });
}

// ---------------------------------------------------------------------------------------------
// Request guards and body parsing
// ---------------------------------------------------------------------------------------------
function guardPost(ctx) {
  const { req } = ctx;
  if (ctx.cors && /^Bearer\s/.test(String(req.headers.authorization || ''))) {
    // Hosted API: an allow-listed site origin sending a bearer token (a forged cross-site form cannot do either).
    if (!/^application\/json\s*(;|$)/i.test(String(req.headers['content-type'] || ''))) throw new ApiError(403, 'bad_origin', 'POST requests must use Content-Type: application/json.');
    return;
  }
  const sfs = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  if (sfs && sfs !== 'same-origin' && sfs !== 'none') throw new ApiError(403, 'bad_origin', 'Cross-site requests are not allowed.');
  const origin = req.headers.origin;
  if (origin !== undefined) {
    let ok = false;
    if (origin === ctx.origin) ok = true;
    else {
      try { ok = new URL(String(origin)).host === String(req.headers.host || '').toLowerCase(); } catch { ok = false; }
    }
    if (!ok) throw new ApiError(403, 'bad_origin', 'Request origin is not allowed.');
  }
  if (!/^application\/json\s*(;|$)/i.test(String(req.headers['content-type'] || ''))) {
    throw new ApiError(403, 'bad_origin', 'POST requests must use Content-Type: application/json.');
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > 4 * MAX_BODY) {
      reject(new ApiError(413, 'too_large', `Request body is too large (max ${MAX_BODY / 1024} KB).`));
      return;
    }
    const chunks = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { tooBig = true; chunks.length = 0; if (size > 4 * MAX_BODY) req.destroy(); return; }
      if (!tooBig) chunks.push(c);
    });
    req.on('error', () => reject(new ApiError(400, 'bad_request', 'Could not read the request body.')));
    req.on('close', () => { if (tooBig) reject(new ApiError(413, 'too_large', `Request body is too large (max ${MAX_BODY / 1024} KB).`)); });
    req.on('end', () => {
      if (tooBig) return reject(new ApiError(413, 'too_large', `Request body is too large (max ${MAX_BODY / 1024} KB).`));
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) return resolve({});
      let v;
      try { v = JSON.parse(text); } catch { return reject(new ApiError(400, 'bad_request', 'Request body is not valid JSON.')); }
      if (!v || typeof v !== 'object' || Array.isArray(v)) return reject(new ApiError(400, 'bad_request', 'Request body must be a JSON object.'));
      resolve(v);
    });
  });
}

function requireSession(ctx) {
  const s = lookupSession(ctx.req, ctx.cfg);
  if (!s) throw new ApiError(401, 'not_connected', 'Not connected to Salesforce. Please log in.');
  const wait = hit(s.rl, RATE_LIMIT_PER_MIN);
  if (wait) throw new ApiError(429, 'rate_limited', 'Too many requests. Slow down a little.', { retryAfter: wait });
  return s;
}

// ---------------------------------------------------------------------------------------------
// Salesforce HTTP layer
// ---------------------------------------------------------------------------------------------
async function fetchLimited(url, init, { limit = MAX_SF_BODY, timeoutMs = SF_TIMEOUT_MS } = {}) {
  let res;
  try {
    res = await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    const why = e && e.name === 'TimeoutError' ? 'the request timed out' : (e && e.cause && e.cause.code) || 'connection failed';
    throw new ApiError(502, 'network_error', `Could not reach Salesforce (${why}).`);
  }
  const chunks = [];
  let size = 0;
  try {
    if (res.body) {
      for await (const chunk of res.body) {
        size += chunk.length;
        if (size > limit) {
          try { await res.body.cancel(); } catch { /* ignore */ }
          throw new ApiError(413, 'too_large', 'Salesforce returned more data than this playground can display. Add a LIMIT or select fewer fields.');
        }
        chunks.push(chunk);
      }
    }
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError(502, 'network_error', 'The connection to Salesforce was interrupted.');
  }
  return { status: res.status, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') };
}

function stripTags(s) {
  return String(s).replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Turns a failed Salesforce HTTP result into an ApiError with Salesforce's own text. */
function sfErrorFrom(r) {
  let j = null;
  try { j = JSON.parse(r.text); } catch { /* not JSON */ }
  let message = '';
  let detail;
  if (Array.isArray(j)) {
    message = j.map((e) => (e && (e.message || e.errorCode)) || '').filter(Boolean).join('\n');
    detail = j.slice(0, 20);
  } else if (j && typeof j === 'object') {
    message = j.error_description || j.message || j.error || '';
    detail = { error: j.error, error_description: j.error_description };
  } else {
    const soapFault = /<faultstring>([\s\S]*?)<\/faultstring>/i.exec(r.text);
    message = soapFault ? xmlUnescape(soapFault[1]) : stripTags(r.text).slice(0, 300);
  }
  if (!message) message = `Salesforce returned HTTP ${r.status}.`;
  const status = r.status >= 400 && r.status < 500 && r.status !== 401 ? r.status : 502;
  return new ApiError(status, 'salesforce_error', trunc(message, 2000), { status: r.status, detail });
}

function isInvalidSession(r) {
  return r.status === 401 || (r.status === 500 && /INVALID_SESSION_ID/.test(r.text.slice(0, 4000)));
}

async function refreshAccessToken(s, cfg) {
  if (!s.refreshToken) return false;
  if (s.refreshing) return s.refreshing;
  s.refreshing = (async () => {
    try {
      const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: s.refreshToken, client_id: s.clientId || cfg.clientId });
      if (cfg.clientSecret && !s.byo) body.set('client_secret', cfg.clientSecret);
      const r = await fetchLimited(`${s.loginScheme}://${s.loginHost}/services/oauth2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body,
      }, { limit: 1024 * 1024, timeoutMs: 15_000 });
      if (r.status !== 200) return false;
      const j = JSON.parse(r.text);
      if (!j.access_token) return false;
      if (j.instance_url) { const iu = validateInstanceUrl(j.instance_url, cfg); if (iu) s.instanceUrl = iu; }
      s.accessToken = j.access_token;
      return true;
    } catch {
      return false;
    } finally {
      s.refreshing = null;
    }
  })();
  return s.refreshing;
}

/**
 * Calls Salesforce as the session's user. `build(session)` returns { url, init, opts }.
 * On an invalid-session answer it refreshes the access token once and retries once.
 */
async function sfCall(ctx, s, build) {
  if (!s.accessToken && s.refreshToken) await refreshAccessToken(s, ctx.cfg);   // restored from a sealed token
  for (let attempt = 0; attempt < 2; attempt++) {
    const { url, init = {}, opts } = build(s);
    const headers = { Accept: 'application/json', ...(init.headers || {}), Authorization: `Bearer ${s.accessToken}` };
    const r = await fetchLimited(url, { ...init, headers }, opts);
    if (!isInvalidSession(r)) return r;
    if (attempt === 0 && (await refreshAccessToken(s, ctx.cfg))) continue;
    dropSession(s);
    ctx.cookies.push(cookieHeader(COOKIE, '', { secure: ctx.secure, maxAge: 0 }));
    throw new ApiError(401, 'session_expired', 'Your Salesforce session expired. Please log in again.');
  }
  throw new ApiError(401, 'session_expired', 'Your Salesforce session expired. Please log in again.');
}

async function sfRest(ctx, s, restPath, init) {
  const r = await sfCall(ctx, s, (sess) => ({ url: sess.instanceUrl + restPath, init }));
  if (r.status < 200 || r.status >= 300) throw sfErrorFrom(r);
  let json;
  try { json = JSON.parse(r.text); } catch { throw new ApiError(502, 'salesforce_error', 'Salesforce returned an unreadable response.', { status: r.status }); }
  return json;
}

// ---------------------------------------------------------------------------------------------
// SOQL result shaping
// ---------------------------------------------------------------------------------------------
function stripAttributes(v) {
  if (Array.isArray(v)) { for (const x of v) stripAttributes(x); return v; }
  if (v && typeof v === 'object') {
    if ('attributes' in v) delete v.attributes;
    for (const k of Object.keys(v)) { const x = v[k]; if (x && typeof x === 'object') stripAttributes(x); }
  }
  return v;
}

/** Parses the SELECT list into the keys each record will carry (null if it cannot be done reliably). */
export function parseSelectFields(soql) {
  const s = String(soql);
  const sel = /^\s*SELECT\s+/i.exec(s);
  if (!sel) return null;
  const items = [];
  let depth = 0;
  let quote = false;
  let cur = '';
  let i = sel[0].length;
  let closed = false;
  for (; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      cur += c;
      if (c === '\\') { cur += s[++i] || ''; } else if (c === "'") quote = false;
      continue;
    }
    if (c === "'") { quote = true; cur += c; continue; }
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (depth === 0 && c === ',') { items.push(cur); cur = ''; continue; }
    if (depth === 0 && /\s/.test(c) && /^\s+FROM\b/i.test(s.slice(i, i + 6)) ) { closed = true; break; }
    cur += c;
  }
  if (!closed) return null;
  items.push(cur);
  const out = [];
  let expr = 0;
  for (let raw of items) {
    raw = raw.trim();
    if (!raw) return null;
    if (/^(TYPEOF|FIELDS\s*\()/i.test(raw)) return null;
    if (raw.startsWith('(')) {
      const m = /\bFROM\s+([A-Za-z_][\w]*)/i.exec(raw);
      if (!m) return null;
      out.push(m[1]);
      continue;
    }
    const fn = /^([A-Za-z_]\w*)\s*\(([\s\S]*)\)\s*([A-Za-z_]\w*)?$/.exec(raw);
    if (fn) {
      const name = fn[1].toLowerCase();
      if (fn[3]) out.push(fn[3]);
      else if (name === 'tolabel' || name === 'convertcurrency' || name === 'format') {
        const inner = fn[2].trim();
        if (!/^[\w.]+$/.test(inner)) return null;
        out.push(inner);
      } else out.push(`expr${expr++}`);
      continue;
    }
    const plain = /^([\w.]+)(?:\s+([A-Za-z_]\w*))?$/.exec(raw);
    if (!plain) return null;
    out.push(plain[2] || plain[1]);
  }
  return out;
}

function typeOfValue(v) {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'object') return Array.isArray(v.records) ? 'subquery' : 'object';
  return typeof v;
}

function shapeQueryResult(json, soql, started) {
  const records = Array.isArray(json.records) ? stripAttributes(json.records) : [];
  const fields = soql ? parseSelectFields(soql) : null;
  const keys = records.length ? Object.keys(records[0]) : fields || [];
  const first = records[0] || {};
  const out = {
    ok: true,
    totalSize: typeof json.totalSize === 'number' ? json.totalSize : records.length,
    done: json.done !== false,
    records,
    columns: keys.map((name) => ({ name, type: records.length ? typeOfValue(first[name]) : undefined })),
  };
  if (fields) out.fields = fields;
  if (json.nextRecordsUrl) out.nextCursor = String(json.nextRecordsUrl);
  out.ms = Date.now() - started;
  return out;
}

const CURSOR_RE = /^\/services\/data\/v\d{2,3}\.\d\/(?:tooling\/)?query(?:All)?\/[A-Za-z0-9_-]{4,64}$/;

// ---------------------------------------------------------------------------------------------
// XML helpers for the Apex SOAP API
// ---------------------------------------------------------------------------------------------
function xmlEscape(s) {
  return String(s)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, ' ')
    .replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}

function xmlUnescape(s) {
  return String(s).replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|quot|apos|amp);/g, (_, e) => {
    switch (e) {
      case 'lt': return '<';
      case 'gt': return '>';
      case 'quot': return '"';
      case 'apos': return "'";
      case 'amp': return '&';
      default: {
        const cp = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        try { return String.fromCodePoint(cp); } catch { return ''; }
      }
    }
  });
}

/** First element named `tag` (any namespace prefix). undefined: absent. null: empty/nil. string: unescaped text. */
export function xmlText(xml, tag) {
  const re = new RegExp(`<(?:[\\w.-]+:)?${tag}(\\s[^>]*)?(?:/>|>([\\s\\S]*?)</(?:[\\w.-]+:)?${tag}\\s*>)`);
  const m = re.exec(xml);
  if (!m) return undefined;
  if (m[2] === undefined || /xsi:nil\s*=\s*["']true["']/.test(m[1] || '')) return null;
  return xmlUnescape(m[2]);
}

function buildExecuteAnonymous(code, sessionId, level) {
  const cats = [['Apex_code', level], ['Db', 'INFO'], ['System', 'INFO'], ['Workflow', 'INFO'], ['Validation', 'INFO'], ['Callout', 'INFO'], ['Apex_profiling', 'INFO'], ['Visualforce', 'INFO']];
  const catXml = cats.map(([c, l]) => `<apex:categories><apex:category>${c}</apex:category><apex:level>${l}</apex:level></apex:categories>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:apex="http://soap.sforce.com/2006/08/apex">
<soapenv:Header>
<apex:DebuggingHeader>${catXml}</apex:DebuggingHeader>
<apex:SessionHeader><apex:sessionId>${xmlEscape(sessionId)}</apex:sessionId></apex:SessionHeader>
</soapenv:Header>
<soapenv:Body><apex:executeAnonymous><apex:String>${xmlEscape(code)}</apex:String></apex:executeAnonymous></soapenv:Body>
</soapenv:Envelope>`;
}

// ---------------------------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------------------------
function configured(cfg) { return Boolean(cfg.clientId); }

function redirectUriFor(cfg, origin) { return cfg.redirectUri || `${origin}/api/sf/callback`; }

async function epConfig(ctx) {
  const { cfg, origin } = ctx;
  sendJson(ctx, 200, {
    configured: configured(cfg),
    ownApp: true,
    redirectUri: redirectUriFor(cfg, origin),
    origin,
    apiVersion: cfg.apiVersion,
    environments: ENVIRONMENTS,
  });
}

async function epLogin(ctx) {
  const { cfg, url, req } = ctx;
  try {
    limitIp(req);
    const ownRaw = url.searchParams.get('client_id');
    if (ownRaw && !OWN_CLIENT_RE.test(ownRaw)) throw new ApiError(400, 'bad_client_id', 'That Consumer Key does not look right. Copy it again from your Salesforce app (it is a long text of letters and numbers).');
    const byo = Boolean(ownRaw);
    if (!byo && !configured(cfg)) throw new ApiError(400, 'not_configured', 'Salesforce login is not configured on this site yet (SF_CLIENT_ID is missing).');
    const env = url.searchParams.get('env') || 'production';
    const { host, scheme } = resolveLoginHost(env, url.searchParams.get('domain'), cfg);
    const popup = url.searchParams.get('popup') === '1';
    const fresh = url.searchParams.get('fresh') === '1';
    const hintRaw = url.searchParams.get('login_hint') || '';
    const hint = /^[A-Za-z0-9._%+'-]{1,64}@[A-Za-z0-9.-]{1,120}$/.test(hintRaw) ? hintRaw : '';   // only pre-fills the username box; ignored when malformed
    const returnTo = safeReturnTo(url.searchParams.get('returnTo'));
    let site = '';
    const siteRaw = url.searchParams.get('site');
    if (siteRaw) {
      const o = normOrigin(siteRaw);
      if (o !== ctx.origin) {
        if (!o || !cfg.allowedOrigins.includes(o)) throw new ApiError(400, 'bad_site', 'This website is not on the list of sites allowed to use this Salesforce login.');
        site = o;
      }
    }

    if (pending.size >= MAX_PENDING) pending.delete(pending.keys().next().value);
    const state = rand(24);
    const verifier = rand(48);
    const redirectUri = redirectUriFor(cfg, ctx.origin);
    pending.set(state, { verifier, host, scheme, popup, returnTo, redirectUri, site, clientId: byo ? ownRaw : cfg.clientId, byo, createdAt: now() });

    const q = new URLSearchParams({
      response_type: 'code',
      client_id: byo ? ownRaw : cfg.clientId,
      redirect_uri: redirectUri,
      scope: SCOPE,
      state,
      code_challenge: sha256b64url(verifier),
      code_challenge_method: 'S256',
    });
    if (fresh) q.set('prompt', 'login');
    if (hint) q.set('login_hint', hint);
    ctx.cookies.push(cookieHeader(STATE_COOKIE, state, { secure: ctx.secure, maxAge: 600, path: '/api/sf/' }));
    sendRedirect(ctx, `${scheme}://${host}/services/oauth2/authorize?${q.toString().replace(/\+/g, '%20')}`);
  } catch (err) {
    // A browser navigation (popup) deserves a readable page rather than raw JSON.
    const wantsHtml = /text\/html/.test(String(req.headers.accept || '')) && String(req.headers['sec-fetch-mode'] || '') === 'navigate';
    if (wantsHtml && err instanceof ApiError) {
      sendResultPage(ctx, err.status, { ok: false, error: err.code, message: err.message, popup: null, returnTo: safeReturnTo(url.searchParams.get('returnTo')) });
      return;
    }
    throw err;
  }
}

async function loadIdentity(s, tokenJson) {
  const idMatch = /\/id\/(00[A-Za-z0-9]{13,16})\/(005[A-Za-z0-9]{12,15})/.exec(String(tokenJson.id || ''));
  const ids = idMatch ? { orgId: idMatch[1], userId: idMatch[2] } : {};
  const auth = { Authorization: `Bearer ${s.accessToken}`, Accept: 'application/json' };
  const small = { limit: 256 * 1024, timeoutMs: 10_000 };
  try {
    const r = await fetchLimited(`${s.instanceUrl}/services/oauth2/userinfo`, { headers: auth }, small);
    if (r.status === 200) {
      const j = JSON.parse(r.text);
      return { name: j.name || null, username: j.preferred_username || j.username || null, email: j.email || null, userId: j.user_id || ids.userId || null, orgId: j.organization_id || ids.orgId || null };
    }
  } catch { /* try the next source */ }
  if (idMatch) {
    try {
      const r = await fetchLimited(`${s.loginScheme}://${s.loginHost}/id/${ids.orgId}/${ids.userId}`, { headers: auth }, small);
      if (r.status === 200) {
        const j = JSON.parse(r.text);
        return { name: j.display_name || null, username: j.username || null, email: j.email || null, userId: j.user_id || ids.userId, orgId: j.organization_id || ids.orgId };
      }
    } catch { /* fall through */ }
  }
  return { name: null, username: null, email: null, userId: ids.userId || null, orgId: ids.orgId || null };
}

async function epCallback(ctx) {
  const { cfg, url, req } = ctx;
  limitIp(req);
  const state = url.searchParams.get('state') || '';
  const p = state ? pending.get(state) : undefined;
  if (p) pending.delete(state);   // single use, whatever happens next
  const lsCookie = parseCookies(req)[STATE_COOKIE];
  ctx.cookies.push(cookieHeader(STATE_COOKIE, '', { secure: ctx.secure, maxAge: 0, path: '/api/sf/' }));

  const fail = (error, message) => {
    error = String(error || 'error').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 64) || 'error';
    message = trunc(message || 'Login failed.', 400);
    if (p && p.popup === false) {
      sendRedirect(ctx, (p.site || '') + withParam(p.returnTo, 'sf_error', error));
    } else {
      sendResultPage(ctx, 200, { ok: false, error, message, popup: p ? true : null, returnTo: p ? p.returnTo : DEFAULT_RETURN_TO, site: p ? p.site : '' });
    }
  };

  if (!p || now() - p.createdAt > PENDING_TTL_MS) return fail('invalid_state', 'This login attempt has expired or was already used. Please start again.');
  const err = url.searchParams.get('error');
  if (err) return fail(err, url.searchParams.get('error_description') || 'Salesforce did not authorize the login.');
  if (!lsCookie || lsCookie !== state) return fail('state_mismatch', 'This login was not started in this browser. Please start again.');
  const code = url.searchParams.get('code') || '';
  if (!code || code.length > 2048) return fail('invalid_request', 'Salesforce did not return an authorization code.');
  if (!p.byo && !configured(cfg)) return fail('not_configured', 'Salesforce login is not configured on this site.');

  let tokenJson;
  try {
    const body = new URLSearchParams({ grant_type: 'authorization_code', code, client_id: p.clientId, redirect_uri: p.redirectUri, code_verifier: p.verifier });
    if (cfg.clientSecret && !p.byo) body.set('client_secret', cfg.clientSecret);
    const r = await fetchLimited(`${p.scheme}://${p.host}/services/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body,
    }, { limit: 1024 * 1024, timeoutMs: 20_000 });
    let j = null;
    try { j = JSON.parse(r.text); } catch { /* ignore */ }
    if (r.status !== 200 || !j || !j.access_token) {
      return fail((j && j.error) || 'token_exchange_failed', (j && (j.error_description || j.error)) || `Salesforce rejected the login (HTTP ${r.status}).`);
    }
    tokenJson = j;
  } catch (e) {
    return fail(e instanceof ApiError ? e.code : 'token_exchange_failed', e instanceof ApiError ? e.message : 'Could not complete the login with Salesforce.');
  }

  const instanceUrl = validateInstanceUrl(tokenJson.instance_url, cfg);
  if (!instanceUrl) return fail('invalid_instance', 'Salesforce returned an instance URL that is not on the allow-list, so the connection was refused.');

  const t = now();
  const s = {
    sid: rand(32),
    accessToken: tokenJson.access_token,
    refreshToken: tokenJson.refresh_token || null,
    clientId: p.clientId,
    byo: Boolean(p.byo),
    instanceUrl,
    loginHost: p.host,
    loginScheme: p.scheme,
    user: null,
    org: null,
    orgTried: 0,
    createdAt: t,
    lastSeen: t,
    expiresAt: t + SESSION_MAX_AGE_SEC * 1000,
    rl: { start: 0, count: 0 },
    cache: new Map(),
    refreshing: null,
  };
  const identity = await loadIdentity(s, tokenJson);
  s.user = { name: identity.name, username: identity.username, email: identity.email, userId: identity.userId };
  s.orgId = identity.orgId;
  if (p.site && cfg.sessionSecret && s.refreshToken) s.sid = sealSession(cfg.sessionSecret, s);   // restart-proof token

  const old = parseCookies(req)[COOKIE];
  if (old && !p.site) sessions.delete(old);                      // never reuse a session id across logins
  if (sessions.size >= MAX_SESSIONS) {
    let oldest = null;
    for (const v of sessions.values()) if (!oldest || v.lastSeen < oldest.lastSeen) oldest = v;
    if (oldest) sessions.delete(oldest.sid);
  }
  sessions.set(s.sid, s);
  if (p.site) {
    // Hosted API: the token goes to the site (never in a cookie, which other-site pages could not use anyway).
    if (p.popup) sendResultPage(ctx, 200, { ok: true, popup: true, returnTo: p.returnTo, site: p.site, token: s.sid });
    else sendRedirect(ctx, `${p.site}${withParam(p.returnTo, 'connected', '1')}#sf_token=${encodeURIComponent(s.sid)}&sf_popup=0`);
    return;
  }
  ctx.cookies.push(cookieHeader(COOKIE, s.sid, { secure: ctx.secure, maxAge: SESSION_MAX_AGE_SEC }));

  if (p.popup) sendResultPage(ctx, 200, { ok: true, popup: true, returnTo: p.returnTo });
  else sendRedirect(ctx, withParam(p.returnTo, 'connected', '1'));
}

async function epSession(ctx) {
  const s = lookupSession(ctx.req, ctx.cfg);
  if (!s) return sendJson(ctx, 200, { connected: false });
  const wait = hit(s.rl, RATE_LIMIT_PER_MIN);
  if (wait) throw new ApiError(429, 'rate_limited', 'Too many requests. Slow down a little.', { retryAfter: wait });

  if (!s.org && now() - s.orgTried > 30_000) {
    s.orgTried = now();
    try {
      const j = await sfRest(ctx, s, `/services/data/${ctx.cfg.apiVersion}/query?q=${encodeURIComponent('SELECT Id, Name, IsSandbox, InstanceName FROM Organization')}`);
      const o = (j.records || [])[0];
      if (o) s.org = { id: o.Id || s.orgId || null, name: o.Name || null, isSandbox: Boolean(o.IsSandbox), instanceName: o.InstanceName || null };
    } catch (e) {
      if (e instanceof ApiError && e.code === 'session_expired') return sendJson(ctx, 200, { connected: false, reason: 'session_expired' });
      /* other failures: the Organization object may be hidden from this user; carry on */
    }
  }
  const host = new URL(s.instanceUrl).hostname;
  const t = now();
  const remaining = Math.max(0, Math.min(s.expiresAt - t, s.lastSeen + ctx.cfg.idleTtlMs - t));
  sendJson(ctx, 200, {
    connected: true,
    user: { name: s.user.name, username: s.user.username, email: s.user.email, userId: s.user.userId },
    org: {
      id: (s.org && s.org.id) || s.orgId || null,
      name: (s.org && s.org.name) || null,
      isSandbox: s.org ? s.org.isSandbox : /\.sandbox\./.test(host) || s.loginHost === 'test.salesforce.com',
      instanceUrl: s.instanceUrl,
      loginHost: s.loginHost,
      instanceName: (s.org && s.org.instanceName) || host.split('.')[0],
    },
    apiVersion: ctx.cfg.apiVersion,
    expiresInSec: Math.floor(remaining / 1000),
  });
}

async function epLogout(ctx) {
  const s = lookupSession(ctx.req, ctx.cfg);
  ctx.cookies.push(cookieHeader(COOKIE, '', { secure: ctx.secure, maxAge: 0 }));
  if (s) {
    dropSession(s);
    const token = s.refreshToken || s.accessToken;
    try {
      await fetchLimited(`${s.loginScheme}://${s.loginHost}/services/oauth2/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token }),
      }, { limit: 64 * 1024, timeoutMs: 5000 });
    } catch { /* best effort: the local session is gone either way */ }
  }
  sendJson(ctx, 200, { ok: true });
}

async function epQuery(ctx) {
  const s = requireSession(ctx);
  const body = await readJson(ctx.req);
  const soql = typeof body.soql === 'string' ? body.soql.trim() : '';
  if (!soql) throw new ApiError(400, 'bad_request', 'soql is required.');
  if (soql.length > MAX_SOQL) throw new ApiError(413, 'too_large', 'SOQL is too long.');
  const started = now();
  const kind = body.tooling ? 'tooling/query' : body.all ? 'queryAll' : 'query';
  const json = await sfRest(ctx, s, `/services/data/${ctx.cfg.apiVersion}/${kind}?q=${encodeURIComponent(soql)}`);
  sendJson(ctx, 200, shapeQueryResult(json, soql, started));
}

async function epQueryMore(ctx) {
  const s = requireSession(ctx);
  const body = await readJson(ctx.req);
  const cursor = typeof body.cursor === 'string' ? body.cursor : '';
  if (!cursor.startsWith('/services/data/') || !CURSOR_RE.test(cursor)) throw new ApiError(400, 'bad_request', 'Invalid cursor.');
  const started = now();
  const json = await sfRest(ctx, s, cursor);
  sendJson(ctx, 200, shapeQueryResult(json, null, started));
}

async function epApex(ctx) {
  const s = requireSession(ctx);
  const body = await readJson(ctx.req);
  const code = typeof body.code === 'string' ? body.code : '';
  if (!code.trim()) throw new ApiError(400, 'bad_request', 'code is required.');
  if (Buffer.byteLength(code) > MAX_APEX_CODE) throw new ApiError(413, 'too_large', `Apex code is too large (max ${MAX_APEX_CODE / 1024} KB).`);
  const level = String(body.logLevel || 'DEBUG').toUpperCase();
  if (!LOG_LEVELS.has(level)) throw new ApiError(400, 'bad_request', `logLevel must be one of ${[...LOG_LEVELS].join(', ')}.`);
  const started = now();
  const soapUrl = `/services/Soap/s/${ctx.cfg.apiVersion.replace(/^v/, '')}`;
  const r = await sfCall(ctx, s, (sess) => ({
    url: sess.instanceUrl + soapUrl,
    init: { method: 'POST', headers: { 'Content-Type': 'text/xml; charset=UTF-8', SOAPAction: '""', Accept: 'text/xml' }, body: buildExecuteAnonymous(code, sess.accessToken, level) },
  }));
  const fault = /<(?:[\w.-]+:)?Fault[\s>]/.test(r.text.slice(0, 20000));
  if (fault || r.status !== 200) {
    const fs_ = xmlText(r.text, 'faultstring');
    const fc = xmlText(r.text, 'faultcode');
    if (typeof fs_ === 'string') throw new ApiError(r.status >= 400 && r.status < 500 && r.status !== 401 ? r.status : 502, 'salesforce_error', trunc(fs_, 2000), { status: r.status, detail: fc ? { faultcode: fc } : undefined });
    throw sfErrorFrom(r);
  }
  const result = xmlText(r.text, 'result');
  if (typeof result !== 'string') throw new ApiError(502, 'salesforce_error', 'Salesforce returned an unexpected Apex response.', { status: r.status });
  const str = (tag) => { const v = xmlText(result, tag); return typeof v === 'string' ? v : null; };
  const num = (tag) => { const n = parseInt(str(tag) ?? '', 10); return Number.isFinite(n) ? n : -1; };
  let log = xmlText(r.text, 'debugLog');
  log = typeof log === 'string' ? log : '';
  const logBytes = Buffer.byteLength(log);
  let truncated = false;
  if (logBytes > MAX_LOG_BYTES) {
    truncated = true;
    log = Buffer.from(log, 'utf8').subarray(0, MAX_LOG_BYTES).toString('utf8').replace(/�+$/, '');
  }
  sendJson(ctx, 200, {
    ok: true,
    compiled: str('compiled') === 'true',
    success: str('success') === 'true',
    line: num('line'),
    column: num('column'),
    compileProblem: str('compileProblem'),
    exceptionMessage: str('exceptionMessage'),
    exceptionStackTrace: str('exceptionStackTrace'),
    log,
    logBytes,
    truncated,
    ms: now() - started,
  });
}

function cached(s, key, ttlMs, fn) {
  const hitEntry = s.cache.get(key);
  if (hitEntry && now() - hitEntry.t < ttlMs) return Promise.resolve(hitEntry.v);
  return fn().then((v) => {
    if (s.cache.size >= 25) s.cache.delete(s.cache.keys().next().value);
    s.cache.set(key, { t: now(), v });
    return v;
  });
}

async function epDescribeGlobal(ctx) {
  const s = requireSession(ctx);
  const v = await cached(s, 'global', 5 * 60_000, async () => {
    const j = await sfRest(ctx, s, `/services/data/${ctx.cfg.apiVersion}/sobjects`);
    return (j.sobjects || [])
      .filter((o) => o && o.queryable)
      .map((o) => ({ name: o.name, label: o.label, labelPlural: o.labelPlural, custom: Boolean(o.custom), queryable: true, keyPrefix: o.keyPrefix || null }))
      .sort((a, b) => String(a.label).localeCompare(String(b.label)) || String(a.name).localeCompare(String(b.name)));
  });
  sendJson(ctx, 200, { ok: true, objects: v });
}

async function epDescribe(ctx) {
  const s = requireSession(ctx);
  const name = ctx.url.searchParams.get('name') || '';
  if (!/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(name)) throw new ApiError(400, 'bad_request', 'name must be a valid object API name.');
  const v = await cached(s, `d:${name.toLowerCase()}`, 5 * 60_000, async () => {
    const j = await sfRest(ctx, s, `/services/data/${ctx.cfg.apiVersion}/sobjects/${name}/describe`);
    return {
      ok: true,
      name: j.name,
      label: j.label,
      labelPlural: j.labelPlural,
      custom: Boolean(j.custom),
      keyPrefix: j.keyPrefix || null,
      fields: (j.fields || []).map((f) => ({
        name: f.name,
        label: f.label,
        type: f.type,
        length: f.length,
        custom: Boolean(f.custom),
        nillable: Boolean(f.nillable),
        referenceTo: Array.isArray(f.referenceTo) ? f.referenceTo : [],
        relationshipName: f.relationshipName || null,
        picklistValues: (f.picklistValues || []).slice(0, 50).map((p) => ({ value: p.value, label: p.label, active: p.active !== false })),
        filterable: Boolean(f.filterable),
        sortable: Boolean(f.sortable),
      })),
      childRelationships: (j.childRelationships || [])
        .filter((c) => c.relationshipName)
        .slice(0, 100)
        .map((c) => ({ childSObject: c.childSObject, field: c.field, relationshipName: c.relationshipName })),
    };
  });
  sendJson(ctx, 200, v);
}

async function epLimits(ctx) {
  const s = requireSession(ctx);
  const j = await sfRest(ctx, s, `/services/data/${ctx.cfg.apiVersion}/limits`);
  const pick = (k) => (j && j[k] && typeof j[k] === 'object' ? { max: j[k].Max ?? null, remaining: j[k].Remaining ?? null } : { max: null, remaining: null });
  sendJson(ctx, 200, { ok: true, apiRequests: pick('DailyApiRequests'), dataStorageMB: pick('DataStorageMB'), fileStorageMB: pick('FileStorageMB') });
}

// ---------------------------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------------------------
const ROUTES = {
  '/api/sf/config': { GET: epConfig },
  '/api/sf/login': { GET: epLogin },
  '/api/sf/callback': { GET: epCallback },
  '/api/sf/session': { GET: epSession },
  '/api/sf/logout': { POST: epLogout },
  '/api/sf/query': { POST: epQuery },
  '/api/sf/query-more': { POST: epQueryMore },
  '/api/sf/apex': { POST: epApex },
  '/api/sf/describe-global': { GET: epDescribeGlobal },
  '/api/sf/describe': { GET: epDescribe },
  '/api/sf/limits': { GET: epLimits },
};

async function route(req, res, url, opts) {
  const cfg = getConfig();
  const origin = publicOrigin(req, cfg, opts);
  const reqOrigin = req.headers.origin ? normOrigin(req.headers.origin) : '';
  const cors = reqOrigin && reqOrigin !== origin && cfg.allowedOrigins.includes(reqOrigin) ? reqOrigin : '';
  const ctx = { req, res, url, cfg, opts, origin, cors, secure: origin.startsWith('https:'), cookies: [] };
  try {
    const p = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;
    const entry = ROUTES[p];
    if (!entry) throw new ApiError(404, 'not_found', 'Unknown endpoint.');
    if (req.method === 'OPTIONS') {   // CORS preflight from an allow-listed site
      if (!cors) throw new ApiError(403, 'bad_origin', 'This site is not allowed to call the Salesforce API.');
      res.writeHead(204, baseHeaders(ctx, { 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Max-Age': '600', 'Content-Length': 0 }));
      res.end();
      return;
    }
    const fn = entry[req.method];
    if (!fn) {
      const e = new ApiError(405, 'method_not_allowed', `Use ${Object.keys(entry).join(', ')} for this endpoint.`);
      ctx.res.setHeader('Allow', Object.keys(entry).join(', '));
      throw e;
    }
    if (req.method === 'POST') guardPost(ctx);
    await fn(ctx);
  } catch (err) {
    sendError(ctx, err);
  }
}

export function handleSalesforceApi(req, res, opts = {}) {
  let url;
  try { url = new URL(req.url, 'http://local.invalid'); } catch { return false; }
  if (url.pathname !== '/api/sf' && !url.pathname.startsWith('/api/sf/')) return false;
  ensureSweeper();
  route(req, res, url, opts).catch((err) => {
    console.error('[sf-api] fatal:', err && err.message ? err.message : String(err));
    try { if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' }); res.end('{"ok":false,"error":"server_error","message":"Unexpected server error."}'); } catch { /* socket gone */ }
  });
  return true;
}

export default handleSalesforceApi;
