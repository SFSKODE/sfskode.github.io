// Checks that your hosted Playground API is reachable and configured correctly.
//   npm run check:api -- https://your-api.onrender.com https://sanjay-kumar-b.github.io
// (second argument = the website origin that should be allowed; default is your GitHub Pages address)
const [apiArg, siteArg] = process.argv.slice(2);
if (!apiArg) { console.log('Usage: npm run check:api -- <API URL> [site origin]\nExample: npm run check:api -- https://sf-skode-api.onrender.com https://sanjay-kumar-b.github.io'); process.exit(2); }
const api = apiArg.replace(/\/+$/, '');
const site = (siteArg || 'https://sanjay-kumar-b.github.io').replace(/\/+$/, '');
let bad = 0;
const ok = (m) => console.log('  OK   ' + m);
const no = (m, hint) => { bad++; console.log('  FAIL ' + m + (hint ? '\n       -> ' + hint : '')); };
async function get(path, init = {}) { const r = await fetch(api + path, { redirect: 'manual', signal: AbortSignal.timeout(90_000), ...init }); return r; }

console.log(`Checking ${api} for site ${site}\n(a free host that was asleep can take up to a minute to answer the first request)\n`);
try {
  const h = await get('/healthz');
  h.status === 200 ? ok('server is running') : no(`/healthz answered HTTP ${h.status}`, 'Is the service deployed and is the Start Command "node scripts/api-server.mjs"?');
} catch (e) { no('cannot reach the server: ' + e.message, 'Check the URL, and that the deploy finished.'); process.exit(1); }

try {
  const r = await get('/api/sf/config', { headers: { Origin: site } });
  const j = await r.json().catch(() => null);
  if (!j) no('/api/sf/config did not return JSON');
  else {
    j.configured ? ok('SF_CLIENT_ID is set') : no('SF_CLIENT_ID is not set', 'Add the Consumer Key of your Salesforce app as SF_CLIENT_ID and redeploy.');
    r.headers.get('access-control-allow-origin') === site ? ok(`${site} is allowed (SF_ALLOWED_ORIGINS)`) : no(`${site} is NOT allowed`, 'Add it to SF_ALLOWED_ORIGINS (exact origin, https, no path, no trailing slash) and redeploy.');
    /^https:\/\//.test(j.redirectUri) ? ok('callback URL = ' + j.redirectUri) : no('callback URL is not https: ' + j.redirectUri, 'Set SF_REDIRECT_URI to https://<your API host>/api/sf/callback.');
    console.log('       -> This exact callback URL must be listed in your Salesforce app.');
  }
  const p = await get('/api/sf/query', { method: 'OPTIONS', headers: { Origin: site, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' } });
  p.status === 204 ? ok('browser pre-flight (CORS) passes') : no(`pre-flight answered HTTP ${p.status}`, 'Same fix as above: SF_ALLOWED_ORIGINS.');
  const l = await get(`/api/sf/login?env=production&popup=1&site=${encodeURIComponent(site)}`);
  const loc = l.headers.get('location') || '';
  l.status === 302 && loc.startsWith('https://login.salesforce.com/services/oauth2/authorize') ? ok('login starts at login.salesforce.com') : no(`login did not redirect to Salesforce (HTTP ${l.status})`, 'See the message above; most often SF_CLIENT_ID or SF_ALLOWED_ORIGINS.');
  const cid = new URL(loc || 'https://x.invalid').searchParams.get('client_id');
  if (cid) console.log(`       -> Consumer Key in use starts with: ${cid.slice(0, 8)}...`);
} catch (e) { no('request failed: ' + e.message); }
console.log(bad ? `\n${bad} problem(s). Fix them, redeploy, and run this again.` : '\nAll good. Now test the real login on your website.');
process.exit(bad ? 1 : 0);
