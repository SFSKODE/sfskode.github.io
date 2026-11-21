// Salesforce API only. Use this when the website itself is hosted somewhere static (GitHub Pages, Cloudflare Pages, ...)
// and only the Playground's login/proxy needs a small server: Render, Railway, Koyeb, a VPS, or your phone behind a tunnel.
//
//   node scripts/api-server.mjs
//
// Environment (see .env.example): SF_CLIENT_ID, SF_ALLOWED_ORIGINS, SF_SESSION_SECRET, SF_REDIRECT_URI (+ optional SF_API_URL).
// Hosts that set PORT (Render, Railway, Koyeb...) work without changes.
import http from 'node:http';
import { handleSalesforceApi } from './sf-api.mjs';

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';

const server = http.createServer((req, res) => {
  if (handleSalesforceApi(req, res)) return;
  const path = String(req.url || '/').split('?')[0];
  const plain = { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
  if (path === '/healthz' || path === '/') {
    res.writeHead(200, plain);
    res.end(req.method === 'HEAD' ? undefined : 'SF SKODE Salesforce API is running.\n');
    return;
  }
  res.writeHead(404, plain);
  res.end('Not found\n');
});

server.requestTimeout = 60_000;
server.headersTimeout = 20_000;
server.listen(PORT, HOST, () => console.log(`${new Date().toISOString()} Salesforce API listening on http://${HOST}:${PORT}`));
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => server.close(() => process.exit(0)));
