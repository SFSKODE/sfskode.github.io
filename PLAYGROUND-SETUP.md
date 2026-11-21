> **Publishing on GitHub Pages / Cloudflare Pages / your own domain?** Follow `GO-LIVE-PLAYGROUND.md` instead: it covers the hosted API, the Salesforce External Client App, and testing. This file describes the all-in-one setup (site and API on one server, e.g. `npm run dev` or `scripts/server.mjs`).

# Playground setup (connect a Salesforce org)

The Playground (`/playground/`) lets a visitor press **Connect org**, choose Production / Sandbox / Custom domain,
sign in on Salesforce's own login page, and then run SOQL and anonymous Apex, browse the schema, read debug logs and
finish guided challenges.

**Passwords are never typed on this site.** Login happens on Salesforce (OAuth 2.0 Authorization Code + PKCE). Tokens stay
on the server in memory and the browser only holds an HttpOnly session cookie. Sessions expire after 2 hours idle.

> Honest status: this was built and tested against a mock Salesforce org (`npm run mock-sf`, `npm run test:sf`, 18 checks).
> It has not been run against a real org. Expect to do the setup below once and possibly fix a small issue.

## 1. Create the Connected App (once, in any org you own)

Setup → App Manager → **New Connected App** (or *External Client App* in newer orgs).

| Field | Value |
| --- | --- |
| Name / API name | SKODE Playground |
| Contact email | yours |
| Enable OAuth Settings | on |
| Callback URL | `https://YOUR-SITE/api/sf/callback` and, for local work, `http://localhost:4321/api/sf/callback` |
| Selected OAuth scopes | **Manage user data via APIs (api)**, **Perform requests at any time (refresh_token, offline_access)**, **Access the identity URL service (id, profile, email, address, phone)** is optional; `web` is fine to add |
| Require Proof Key for Code Exchange (PKCE) | on |
| Require Secret for Web Server Flow | off (or on, then set `SF_CLIENT_SECRET`) |

Save, then wait about 10 minutes. Open **Manage Consumer Details** and copy the **Consumer Key**.

## 2. Give the site the key

Copy `.env.example` to `.env` next to `package.json` and set:

```
SF_CLIENT_ID=<Consumer Key>
SITE_URL=https://YOUR-SITE          # only when behind ngrok / a proxy
```

Then `npm run dev` (local) or rebuild and restart the server. The file is re-read automatically, so editing `.env` while the
server runs is picked up within a few seconds.

### On the phone (Termux + ngrok)
`scripts/hub` loads `~/.sfhub/config.env`. Either put a `.env` file in the project folder on the phone (simplest, nothing else
to do), or add exported lines to `~/.sfhub/config.env`:

```
export SF_CLIENT_ID=...
export SITE_URL=https://your-name.ngrok-free.app
```
Add `https://your-name.ngrok-free.app/api/sf/callback` as a Callback URL in the Connected App.

## 3. Use it
Open `/playground/` → **Connect org** → pick environment → log in on Salesforce → you return to the Playground, connected.
For a Sandbox choose *Sandbox*; for a My Domain org choose *Custom domain* and enter e.g. `acme.my.salesforce.com`
(only `*.salesforce.com`, `*.force.com` and related Salesforce domains are accepted).

The signed-in user needs **API Enabled**. Running anonymous Apex and creating debug trace flags also needs **Author Apex**.

## Troubleshooting

| Message from Salesforce | Fix |
| --- | --- |
| `redirect_uri_mismatch` | The callback in the Connected App must match exactly, including `http`/`https` and no trailing slash. Check `SITE_URL`. |
| `invalid_client_id` | Wrong Consumer Key, or the app is under ~10 minutes old. |
| `OAUTH_APP_BLOCKED` / "not installed in this org" | See the limitation below. |
| `invalid_grant` / `code_verifier` | Retry; a stale tab reused an old login. |
| Apex or debug logs refused | The user lacks *Author Apex* / *API Enabled*. |
| Playground says it is not configured | `SF_CLIENT_ID` is empty or the server was not restarted after editing the environment. |

## Limitation you should know about
A Connected App lives in the org that created it. Another org's users can usually log in through it only if their admin
allows it (or the app is installed there via a package). For your own orgs and developer editions this works after you
install/allow it; for strangers' orgs, plan to distribute it as a managed package or let users bring their own Consumer Key.

## Security notes
* Only HTTPS Salesforce hosts are accepted (plus `SF_EXTRA_HOSTS` for tests); redirects from Salesforce are never followed blindly.
* `state` and PKCE verifier are single-use; session cookies are HttpOnly, SameSite=Lax, and Secure on https.
* Keep `.env` private. The Consumer Key is not secret, the Consumer Secret is.
