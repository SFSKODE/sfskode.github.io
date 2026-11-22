# Make the Playground work on your public website (step by step)

Your website lives on GitHub Pages (`https://sfskode.github.io`), and later on Cloudflare Pages and your own domain.
Those hosts only serve files. The Playground also needs a **small server** that talks to Salesforce for the visitor.
So you will have three pieces:

| Piece | What it is | Where it lives |
|---|---|---|
| **Website** | the pages you already publish | GitHub Pages (later Cloudflare Pages, your own domain) |
| **API** | `scripts/api-server.mjs`, ~free, no database | Render.com free web service (Part 2) |
| **Salesforce app** | one "External Client App" that you create once | your own Salesforce org (Part 1) |

**What a visitor does:** open the Playground → click **Connect Salesforce org** → a small window opens on
`login.salesforce.com` → log in and click **Allow** → the window closes by itself and the Playground shows their org.
Orgs other than yours may first see a Salesforce message that the shared app is not supported there; the dialog then
offers **Use my own app** (a one-time, two-minute step in their own org; see "Who can connect?").
All the setup below is done once, by you.

One API serves every copy of your website (GitHub Pages, Cloudflare Pages, your own domain). You only add each
website address to one list (Part 5).

---

## Part 0. Before you start (5 minutes)

1. Your GitHub repository must contain the **whole project** (the folder with `package.json`, `src/`, `scripts/`), not only the built `dist/` folder.
   Open your repo on github.com. If you only see `index.html`, `_astro/` and similar, you have pushed only the built site; push the project instead (Part 3, step 1).
2. Your repo must **not** contain a file called `.env`. (The `.gitignore` in this project stops that.)
3. Put your real cover images and `author.jpg` into `src/assets/covers` / `src/assets/` **in the repo**, because GitHub will build the site from them.
4. Pick the name you will use for the API, for example `sf-skode-api`. Render will make the address `https://sf-skode-api.onrender.com`. (If the name is taken Render adds letters; use the real address it shows you.)

---

## Part 1. Create the Salesforce app (once)

Salesforce is retiring "Connected Apps" for new apps (since Spring '26 new orgs cannot create them), so use an **External Client App**.
You can do this in any Salesforce org you own, for example a free Developer Edition: <https://developer.salesforce.com/signup>.

1. Log in to that org. Click the gear icon → **Setup**.
2. In **Quick Find** type `External Client App Manager` (older orgs: **App Manager**) and open it.
3. Click **New External Client App**.
4. **Basic Information**
   - External Client App Name: `SF SKODE Playground`
   - API Name: leave the suggestion
   - Contact Email: your email
   - Distribution State: **Local** for now (see "Who can connect?" below).
5. Open **API (Enable OAuth Settings)** and tick **Enable OAuth Settings**.
6. **Callback URL:** type exactly `https://YOUR-API-NAME.onrender.com/api/sf/callback`
   (you will know the real address after Part 2; you can come back and edit it. It must match **character for character**, `https`, no trailing slash.)
7. **Available OAuth Scopes**: add these three (use the arrow to move them to "Selected"):
   - *Manage user data via APIs (api)*
   - *Perform requests at any time (refresh_token, offline_access)*
   - *Manage user data via Web browsers (web)* (and *Access the identity URL service (id, profile, email, address, phone)* if it is offered)
8. **Security** section:
   - tick **Require Proof Key for Code Exchange (PKCE) extension for Supported Authorization Flows**
   - **untick** *Require Secret for Web Server Flow* and *Require Secret for Refresh Token Flow*
     (PKCE protects the login; with no secret there is nothing secret to leak. If you keep them ticked, also set `SF_CLIENT_SECRET` on the API.)
9. Click **Create**.
10. Open the app you just made → **Settings** tab → expand **OAuth Settings** → click **Consumer Key and Secret** (Salesforce emails you a verification code the first time) → copy the **Consumer Key**. This is your `SF_CLIENT_ID`.
11. Policies: open the **Policies** tab → **OAuth Policies** → set **Permitted Users** to *All users may self-authorize*, then **Save**.
    (If you pick "Admin approved users are pre-authorized", only people your org's admin assigns can log in. That is not what you want for a public site.)

If you ever see *"Local" apps work only in the org that owns them*: that is the next section.

### Who can connect? (tested)

- **You, and anyone in the org that owns the app:** works.
- **Any other org:** with a *Local* External Client App Salesforce answers
  **"Cross-org OAuth flows are not supported for this external client app"** (this was tested on a real second org).
  An app is only allowed in other orgs once it is *installed* there; the proper route is a packaged External Client App
  (2GP managed package, Distribution State **Packaged**, built from a Dev Hub org with the Salesforce CLI). That is a larger
  Salesforce-side project (Dev Hub, namespace, package versions, install links) and is optional; see
  [Salesforce Trailhead](https://trailhead.salesforce.com/content/learn/modules/external-client-app-basics/package-and-distribute-external-client-apps).
  Also note that since September 2025 Salesforce blocks apps not installed in an org for most users
  ([Salesforce Admins](https://admin.salesforce.com/blog/2025/get-ready-for-changes-to-connected-app-usage-restrictions)).
- **What the Playground does about it (already built):** when the shared app is blocked, the connect dialog shows
  **Use my own app**. The visitor creates a small External Client App **in their own org** (2 minutes, steps are shown
  in the dialog, callback URL = your API's `/api/sf/callback`), pastes its Consumer Key, and logs in through the same
  window. Because the app belongs to their own org, Salesforce allows it everywhere (Developer Edition, sandbox, company org
  where they may create apps). Their Consumer Key is not a secret and is remembered only in their own browser.
  Orgs where the user may not create apps need their admin to do those 2 minutes.
- Tell visitors on the Playground page: *"Use a free Developer Edition org (developer.salesforce.com/signup) or a sandbox."*
  Code run in the Playground executes for real, so a practice org is also the safest way to learn.

---

## Part 2. Put the API online (Render, free)

1. Create a free account at <https://render.com> (sign in with GitHub).
2. **New +** → **Web Service**.
3. Connect your GitHub repository (the one with the full project) → **Connect**.
4. Fill the form:
   - Name: `sf-skode-api`
   - Region: the one nearest your visitors (Singapore for India)
   - Branch: `main`
   - Root Directory: leave empty
   - Language / Runtime: **Node**
   - Build Command: `echo "nothing to build"`
   - Start Command: `node scripts/api-server.mjs`
   - Instance Type: **Free**
5. Open **Environment Variables** → add these (name → value):
   - `SF_CLIENT_ID` → the Consumer Key from Part 1 step 10
   - `SF_ALLOWED_ORIGINS` → `https://sfskode.github.io`
   - `SF_SESSION_SECRET` → a long random text, 40+ characters. Make one: <https://www.random.org/strings/> or run `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Never share it.
   - `SF_REDIRECT_URI` → `https://sf-skode-api.onrender.com/api/sf/callback` (use your real Render address)
   - `NODE_VERSION` → `22`
6. **Create Web Service**. Wait until the log says `Salesforce API listening` and the status is **Live**.
7. Open `https://sf-skode-api.onrender.com/healthz` in a browser. You should see `SF SKODE Salesforce API is running.`
8. Go back to Salesforce (Part 1, step 6) and make sure the Callback URL is exactly the `SF_REDIRECT_URI` above.
9. Check it from your computer (in the project folder):
   ```
   npm run check:api -- https://sf-skode-api.onrender.com https://sfskode.github.io
   ```
   Every line must say `OK`. Each `FAIL` line tells you what to fix.

**About the free plan:** Render puts a free service to sleep after about 15 minutes without visits. The first visitor after that waits up to about a minute while it wakes. Opening the Playground page wakes it in the background, and because login tokens are encrypted and carried by the browser, nobody is logged out by a restart. If the wait ever bothers you, a paid instance (a few dollars a month) removes it, or any other Node host works the same (Railway, Koyeb, a VPS): start command `node scripts/api-server.mjs`, same environment variables.

---

## Part 3. Publish the website with the API address

The website needs to know the API address when it is **built**.

1. Put the whole project in your GitHub repo (first time only). The safe way, which never erases anything you cannot get back:
   ```
   git clone https://github.com/sfskode/sfskode.github.io.git repo-copy
   ```
   - Open `repo-copy`, delete everything in it **except the hidden `.git` folder** (this removes the old built files).
   - Copy the project into it: everything from the project folder **except** `node_modules`, `dist`, `.astro` and `.env`. Make sure `package.json` sits directly in `repo-copy`, and `.gitignore`, `.github/` and `src/assets/covers/` (with your covers) are included.
   - Then:
   ```
   cd repo-copy
   git add -A
   git commit -m "SF SKODE glass redesign and Playground API"
   git push
   ```
   Check on github.com that `.env` is **not** in the repo and that `src/assets/covers/` has your covers. (Git keeps the old version in history, so nothing is lost.)
2. Repo → **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. Repo → **Settings → Secrets and variables → Actions → Variables tab → New repository variable**:
   - Name `PUBLIC_SF_API_URL`, value `https://sf-skode-api.onrender.com` (no trailing slash)
   - Name `SITE_URL`, value `https://sfskode.github.io`
4. Repo → **Actions** tab → *Deploy site to GitHub Pages* → **Run workflow** (it also runs on every push). Wait for the green tick.
5. Open `https://sfskode.github.io/playground/`.

(Publishing a locally built `dist/` instead? Build with the variable set: Windows `set PUBLIC_SF_API_URL=https://sf-skode-api.onrender.com` then `npm run build`; Mac/Linux `PUBLIC_SF_API_URL=... npm run build`. Then publish `dist/`.)

---

## Part 4. Test it like a visitor

1. Open `https://sfskode.github.io/playground/` in a normal browser window.
2. Click **Connect Salesforce org**. A small window opens at **login.salesforce.com**. (If nothing opens, allow pop-ups for the site; the dialog also offers "Log in on this page instead".)
3. Log in, click **Allow**.
4. The window closes; the Playground shows your org name and a green dot. Run `SELECT Id, Name FROM Account LIMIT 5`.
5. Reload the page: you are still connected. Click **Disconnect**: the connection ends and the token is revoked at Salesforce.

Sandbox or a company login domain: in the dialog click **Sandbox or My Domain?**.

---

## Part 5. Cloudflare Pages, your own domain, other hosts

For **every** extra address the website will have:

1. Build the site with `PUBLIC_SF_API_URL` set to the same API address.
   - Cloudflare Pages: **Workers & Pages → Create → Pages → Connect to Git** → pick the repo → Framework preset **Astro** (or build command `npm run build`, output `dist`) → **Environment variables**: `NODE_VERSION=22`, `PUBLIC_SF_API_URL=https://sf-skode-api.onrender.com`, `SITE_URL=https://your-project.pages.dev`.
2. Add that website's exact origin to `SF_ALLOWED_ORIGINS` on Render, comma separated, then let Render redeploy:
   ```
   https://sfskode.github.io,https://your-project.pages.dev,https://www.yourdomain.com
   ```
   Rules: `https://`, the host only, no path, no trailing slash. `www.yourdomain.com` and `yourdomain.com` are different, add both if you use both. Preview deployments (`abc123.your-project.pages.dev`) are *not* allowed on purpose: a wildcard would let strangers' sites ask your visitors to log in.
3. **Nothing changes in Salesforce.** The callback URL stays on the API address.
4. When you buy your own domain: point it at GitHub Pages (Settings → Pages → Custom domain) or Cloudflare Pages, change `SITE_URL`, add the new origin to `SF_ALLOWED_ORIGINS`. Optionally also give the API its own address (`api.yourdomain.com`) in Render → Custom Domains; then update `PUBLIC_SF_API_URL`, `SF_REDIRECT_URI` and the Salesforce Callback URL together.
5. Run `npm run check:api -- <API URL> <new site origin>` after each change.

---

## Troubleshooting

| What you see | Cause and fix |
|---|---|
| Connect opens a window with *"This website is not on the list of sites allowed…"* | Your website address is missing from `SF_ALLOWED_ORIGINS` (or has a path / trailing slash). Fix and redeploy the API. |
| Salesforce page says `redirect_uri_mismatch` | The Callback URL in the Salesforce app is not exactly `SF_REDIRECT_URI`. |
| Salesforce says `invalid_client_id` / `client identifier invalid` | Wrong Consumer Key, or the app is not available to that user's org (see "Who can connect?"). |
| *Cross-org OAuth flows are not supported for this external client app* / app blocked / not installed | Expected for orgs other than the one that owns your app. The dialog offers **Use my own app** (visitor creates the app in their own org), or package your app (see "Who can connect?"). |
| Window shows `Could not connect: not_configured` | `SF_CLIENT_ID` is missing on the API. |
| Login works but the page says *"Could not reach the playground service"* | API asleep or down; wait a minute and reload. Check `/healthz`. Make sure `PUBLIC_SF_API_URL` was set when the site was built. |
| The login window stays open on a "Connected" page | Your browser blocked the hand-over; click **Back to the playground** on that page. It always works as a fallback. |
| Pop-up blocked | Allow pop-ups for the site, or use **Log in on this page instead**. |
| *invalid_grant* / session ended after a long time | The Salesforce refresh token was revoked or the 8-hour session limit passed. Connect again. |
| Works on `github.io` but not on a new address | Add the new address to `SF_ALLOWED_ORIGINS`. |

## Security notes (why this is safe to publish)

- The site never sees Salesforce passwords. Login happens on Salesforce's own page.
- The browser keeps one **encrypted token** it cannot read. The Salesforce refresh token is inside it, readable only by your API (the key is `SF_SESSION_SECRET`). Like any login session, whoever holds that token can use the Playground as that user until it expires (8 hours) or the user clicks Disconnect, so the token is kept in the browser's local storage only and never put in a URL after the first hand-over.
- The login result is delivered only to the website address that started it, and that address must be in your allow-list.
- Disconnect revokes the Salesforce refresh token. Sessions end after 8 hours at most.
- Keep `SF_SESSION_SECRET` private. Changing it logs everyone out.
- Code that visitors run executes in **their own org**, with their own permissions. Your server only forwards it.
