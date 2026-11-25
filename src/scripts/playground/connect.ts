// "Connect Salesforce org" dialog: choose environment -> what happens next -> Salesforce login popup -> connected.
import { normalizeDomain, loginUrl, type EnvId } from './domain';
import type { Config, SessionInfo } from './api';
import { getSession, isRemote, API_BASE, TOKEN_KEY, setToken } from './api';
import { installUrl } from './pkg';

interface Ctx { config: Config | null; onConnected: (s: SessionInfo) => void; reduced: boolean }

/** `fresh` is always on: Salesforce then shows its login screen even when this browser is still logged in there, so the visitor can pick any org or user (otherwise it silently re-connects the previous one). */
const loginOpts = (popup: boolean, clientId?: string, hint?: string) => ({ popup, returnTo: '/playground/', fresh: true, ...(clientId ? { clientId } : {}), ...(hint ? { hint } : {}), ...(isRemote ? { base: API_BASE, site: location.origin } : {}) });
type Step = 'choose' | 'connecting' | 'done' | 'error' | 'setup' | 'own' | 'install';

// Orgs this visitor connected before, remembered on this device only. Names and usernames, never tokens or passwords.
const ORGS_KEY = 'sfp_orgs';
interface Saved { env: EnvId; host: string | null; name: string; username: string; sandbox: boolean; own: boolean }
const readOrgs = (): Saved[] => {
  try {
    const a = JSON.parse(localStorage.getItem(ORGS_KEY) || '[]');
    if (!Array.isArray(a)) return [];
    return a.filter((o) => o && ['production', 'sandbox', 'custom'].includes(o.env) && typeof o.username === 'string' && typeof o.name === 'string' && (o.host === null || typeof o.host === 'string') && (o.env !== 'custom' || o.host)).slice(0, 4)
      .map((o) => ({ env: o.env, host: o.host ?? null, name: String(o.name).slice(0, 80), username: String(o.username).slice(0, 120), sandbox: Boolean(o.sandbox), own: Boolean(o.own) }));
  } catch { return []; }
};
const writeOrgs = (list: Saved[]) => { try { localStorage.setItem(ORGS_KEY, JSON.stringify(list.slice(0, 4))); } catch { /* storage blocked: the list just is not remembered */ } };
const sameOrg = (a: Saved, b: Saved) => a.username.toLowerCase() === b.username.toLowerCase() && a.env === b.env && a.host === b.host;
const KEY_RE = /^[A-Za-z0-9._]{20,255}$/;
const OWN_KEY = 'sfp_own_key';
const readOwn = () => { try { return localStorage.getItem(OWN_KEY) || ''; } catch { return ''; } };
/** The shared app is blocked in some orgs (Salesforce only lets an app work in other orgs once it is installed there). */
const looksBlocked = (m: string) => /cross-org|not supported for this external|blocked|not installed|uninstalled|invalid[_ ]client|client identifier|approve/i.test(m);

const ENV_INFO: Record<EnvId, { title: string; sub: string; host: string; icon: string }> = {
  production: { title: 'Production or Developer Edition', sub: 'Your live org or a free Developer Edition org.', host: 'login.salesforce.com', icon: '<path d="M7 18a4 4 0 0 1-.6-7.96A5.5 5.5 0 0 1 17 8.5a4.5 4.5 0 0 1 .5 9z"/>' },
  sandbox: { title: 'Sandbox', sub: 'A copy of production for safe practice. Recommended for real projects.', host: 'test.salesforce.com', icon: '<path d="M4 8l8-4 8 4v8l-8 4-8-4z"/><path d="M4 8l8 4 8-4M12 12v8"/>' },
  custom: { title: 'Custom domain (My Domain)', sub: 'Your company login address, like acme.my.salesforce.com.', host: 'yourcompany.my.salesforce.com', icon: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>' },
};
const svg = (p: string, s = 22) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export function openConnect(dlg: HTMLDialogElement, ctx: Ctx) {
  let step: Step = ctx.config && !ctx.config.configured ? 'setup' : 'choose';
  let saved = readOrgs();
  let hint = '';               // username to pre-fill on the Salesforce login page (only when a remembered org was picked)
  let env: EnvId = 'production';
  let domainRaw = '';
  let domainErr = '';
  let errMsg = '';
  let popup: Window | null = null;
  let timer = 0;
  let dir = 1;
  let result: SessionInfo | null = null;
  let ownKey = readOwn();      // Consumer Key of an app in the visitor's own org
  let useOwn = false;          // true once the visitor chose to connect with it
  let ownErr = '';
  let closedEarly = false;     // the login window was closed before finishing: usually Salesforce showed its own error page
  let opened = false;          // the visitor opened the install page

  const cleanup = () => { window.clearInterval(timer); window.removeEventListener('message', onMessage); window.removeEventListener('storage', onStorage); popup?.close?.(); popup = null; };
  const close = () => { cleanup(); if (dlg.open) dlg.close(); };

  function go(next: Step, d = 1) { dir = d; step = next; draw(true); }

  function header(title: string, sub = '') {
    return `<header class="dlg__head"><div><h2 id="cn-title">${title}</h2>${sub ? `<p>${sub}</p>` : ''}</div><button class="dlg__x" type="button" data-close aria-label="Close">${svg('<path d="M6 6l12 12M18 6 6 18"/>', 20)}</button></header>`;
  }
  const dots = () => {
    const order: Step[] = ['choose', 'connecting', 'done'];
    const i = Math.max(0, order.indexOf(step === 'error' ? 'connecting' : step === 'own' || step === 'install' ? 'choose' : step));
    return `<ol class="dlg__steps" aria-label="Progress">${order.map((s, k) => `<li class="${k < i ? 'is-done' : k === i ? 'is-now' : ''}" ${k === i ? 'aria-current="step"' : ''}><span class="sr-only">${s}</span></li>`).join('')}</ol>`;
  };

  function handshake(state: 'idle' | 'live' | 'ok' | 'bad') {
    return `<svg class="hs hs--${state}" viewBox="0 0 360 120" role="img" aria-label="${state === 'ok' ? 'Connected' : state === 'bad' ? 'Connection failed' : 'Connecting this site to Salesforce'}">
      <defs><linearGradient id="hsg" x1="0" x2="1"><stop offset="0" stop-color="var(--brand)"/><stop offset="1" stop-color="var(--cyan-500, var(--brand))"/></linearGradient></defs>
      <path class="hs__rail" d="M78 60 C 130 20, 230 100, 282 60" />
      <path class="hs__pulse" d="M78 60 C 130 20, 230 100, 282 60" />
      <g class="hs__node hs__node--a"><circle cx="52" cy="60" r="26"/><text x="52" y="66" text-anchor="middle">SK</text></g>
      <g class="hs__node hs__node--b"><circle cx="308" cy="60" r="26"/><path d="M297 68a7 7 0 0 1-.5-14 9 9 0 0 1 17-1 7 7 0 0 1 1 15z" /></g>
      <path class="hs__check" d="M178 56l8 8 16-17" />
      <path class="hs__cross" d="M174 46l24 24M198 46l-24 24" />
    </svg>`;
  }

  function body(): string {
    if (step === 'setup') {
      const uri = esc(ctx.config?.redirectUri ?? '');
      return `${header('Playground is not set up yet', 'The site owner needs to add a Salesforce Connected App once.')}
        <div class="dlg__body"><ol class="dlg__how">
          <li>In Salesforce Setup, create a <b>Connected App</b> (or External Client App) with OAuth enabled.</li>
          <li>Add this callback URL: <span class="dlg__code" data-copy="${uri}">${uri}</span></li>
          <li>Select scopes <b>api</b>, <b>refresh_token</b>, <b>web</b>, tick <b>Require PKCE</b>.</li>
          <li>Put the Consumer Key in the server settings as <code>SF_CLIENT_ID</code> and restart the API.</li>
        </ol><p class="dlg__fine">The full guide is in <code>GO-LIVE-PLAYGROUND.md</code> in the project.</p></div>
        <footer class="dlg__foot"><button class="btn" type="button" data-close>Close</button></footer>`;
    }
    if (step === 'choose') {
      const cards = (Object.keys(ENV_INFO) as EnvId[]).map((id) => {
        const e = ENV_INFO[id];
        return `<label class="envc${env === id ? ' is-on' : ''}"><input type="radio" name="env" value="${id}" ${env === id ? 'checked' : ''}><span class="envc__ic">${svg(e.icon)}</span><span class="envc__t"><b>${e.title}</b><small>${e.sub}</small></span><span class="envc__h">${e.host}</span></label>`;
      }).join('');
      const recent = saved.length ? `<div class="orgs"><h3 class="orgs__h">Your recent orgs</h3><ul class="orgs__l">${saved.map((o, i) => `<li class="orgs__i"><button class="orgc" type="button" data-org="${i}"><span class="orgc__t"><b>${esc(o.name || o.username)}</b><small>${esc(o.username)}</small></span><span class="pill ${o.sandbox ? 'pill--sb' : 'pill--prod'}">${o.sandbox ? 'Sandbox' : 'Production'}</span></button><button class="orgs__x" type="button" data-forget="${i}" aria-label="Remove ${esc(o.username)} from this list" title="Remove from this list">${svg('<path d="M6 6l12 12M18 6 6 18"/>', 16)}</button></li>`).join('')}</ul><h3 class="orgs__h orgs__h--2">Or connect another org</h3></div>` : '';
      return `${header('Connect your Salesforce org', saved.length ? 'Pick an org you used before, or log in to a different one.' : 'Pick the kind of org you want to log in to.')}${dots()}
        <div class="dlg__body">${recent}<div class="envs" role="radiogroup" aria-label="Environment">${cards}</div>
        <div class="dom" ${env === 'custom' ? '' : 'hidden'}>
          <label for="cn-domain">Your My Domain</label>
          <input id="cn-domain" type="text" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="acme.my.salesforce.com" value="${esc(domainRaw)}" aria-describedby="cn-domain-msg" ${domainErr ? 'aria-invalid="true"' : ''}>
          <p id="cn-domain-msg" class="dom__msg${domainErr ? ' is-bad' : ''}" role="alert">${domainErr ? esc(domainErr) : 'Paste the address from your browser, we will clean it up.'}</p>
        </div>
        <p class="dlg__fine">A Salesforce login window opens. You log in there and click <b>Allow</b>; we never see your password. Remembered orgs are stored only in this browser, and the list never holds passwords or tokens.</p>
        ${saved.length ? `<p class="dlg__fine dlg__alt">Login says the app is not installed or blocked? <button class="linkbtn" type="button" data-install>Install the connector</button> or <button class="linkbtn" type="button" data-own>use your own app</button>.</p>`
          : `<div class="dlg__tip"><b>First time with this org?</b><span>Salesforce asks each org to install our small login connector once. It takes about a minute and needs an admin.</span><button class="btn btn--sm" type="button" data-install>Install the connector first</button></div>
          <p class="dlg__fine dlg__alt">Can't install anything in your org? <button class="linkbtn" type="button" data-own>Use your own app instead</button></p>`}</div>
        <footer class="dlg__foot"><button class="btn" type="button" data-close>Cancel</button><button class="btn btn--primary" type="button" data-next>Open Salesforce login</button></footer>`;
    }
    if (step === 'install') {
      const host = env === 'custom' ? esc(domainRaw) : ENV_INFO[env].host;
      const go1 = `<a class="btn ${opened ? '' : 'btn--primary'}" href="${installUrl(env, env === 'custom' ? domainRaw : null)}" target="_blank" rel="noopener noreferrer" data-opened>${opened ? 'Open the install page again' : 'Open the install page'}</a>`;
      return `${header('Install the connector (once)', 'Salesforce lets this site log in to an org only after its small login app is installed there.')}${dots()}
        <div class="dlg__body"><p class="dlg__fine">Installing in: <b>${ENV_INFO[env].title}</b> (${host}) · <button class="linkbtn" type="button" data-back>change</button></p>
        <ol class="dlg__how">
          <li><b>Open the install page</b> with the button below and log in as a <b>System Administrator</b>.</li>
          <li>Choose <b>Install for Admins Only</b> and click <b>Install</b>. If Salesforce asks about third-party access, tick <b>Yes</b> and click <b>Continue</b>. Wait for <i>Installation complete</i>.</li>
          <li>Come back to this tab and click <b>I installed it, connect</b>.</li>
        </ol>
        <p class="dlg__fine">The connector is only a login app: no code, no objects, no data. It can read nothing until you log in and click Allow. You can remove it any time in Setup → Installed Packages.</p>
        <details class="dlg__more"><summary>Salesforce says I am not allowed to use the app?</summary><p>In Setup open <b>External Client App Manager</b> → <b>SF SKODE Connector App</b> → <b>Policies</b> → <b>Edit</b>. Under OAuth Policies set <b>Permitted Users</b> to <b>All users may self-authorize</b> and save. Then try again. If you are not an admin, send this to your admin or use <button class="linkbtn" type="button" data-own>your own app</button>.</p></details></div>
        <footer class="dlg__foot"><button class="btn" type="button" data-back>Back</button>${go1}<button class="btn ${opened ? 'btn--primary' : ''}" type="button" data-after-install>I installed it, connect</button></footer>`;
    }
    if (step === 'own') {
      const uri = esc(ctx.config?.redirectUri ?? '');
      const host = env === 'custom' ? esc(domainRaw || 'your My Domain') : ENV_INFO[env].host;
      return `${header('Connect with your own app', 'Takes about two minutes, once. The app lives in your org, so no one else is involved.')}${dots()}
        <div class="dlg__body"><ol class="dlg__how">
          <li>In your org open <b>Setup</b> → <b>External Client App Manager</b> → <b>New External Client App</b>. Name it anything, add your email.</li>
          <li>Tick <b>Enable OAuth</b>. Callback URL: <span class="dlg__code" data-copy="${uri}">${uri}</span> <small>(click to copy)</small></li>
          <li>Scopes: <b>api</b>, <b>refresh_token</b>, <b>web</b>. Tick <b>Require PKCE</b>, untick both <b>Require Secret</b> boxes. Create it.</li>
          <li>On the app's <b>Policies</b> tab set Permitted Users to <b>All users may self-authorize</b>. Then <b>Settings</b> → <b>OAuth Settings</b> → <b>Consumer Key and Secret</b>, and copy the <b>Consumer Key</b>.</li>
        </ol>
        ${ctx.config && !ctx.config.ownApp ? `<p class="dom__msg is-bad" role="alert"><b>The Playground server is out of date</b> and would ignore your key (you would get the same "Cross-org" error). The site owner needs to redeploy the API with the latest <code>scripts/sf-api.mjs</code>.</p>` : ''}
        <div class="dom"><label for="cn-key">Your Consumer Key</label>
          <input id="cn-key" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="3MVG9…" value="${esc(ownKey)}" aria-describedby="cn-key-msg" ${ownErr ? 'aria-invalid="true"' : ''}>
          <p id="cn-key-msg" class="dom__msg${ownErr ? ' is-bad' : ''}" role="alert">${ownErr ? esc(ownErr) : `It is only used to log you in at <b>${host}</b>. It is not a password.`}</p></div></div>
        <footer class="dlg__foot"><button class="btn" type="button" data-back>Back</button><button class="btn btn--primary" type="button" data-go-own${ctx.config && !ctx.config.ownApp ? ' disabled' : ''}>Open Salesforce login</button></footer>`;
    }
    if (step === 'connecting') {
      return `${header('Waiting for Salesforce…')}${dots()}
        <div class="dlg__body dlg__body--c"><div class="hs-wrap">${handshake('live')}</div>
        <p class="dlg__lead">Log in and click <b>Allow</b> in the Salesforce window.</p>
        <p class="dlg__fine">Don't see it? Your browser may have blocked the pop-up.</p></div>
        <footer class="dlg__foot"><button class="btn" type="button" data-cancel>Cancel</button><button class="btn" type="button" data-other>Sandbox or My Domain?</button><button class="btn" type="button" data-redirect>Log in on this page instead</button></footer>`;
    }
    if (step === 'done' && result) {
      const o = result.org, u = result.user;
      return `${header('You are connected')}${dots()}
        <div class="dlg__body dlg__body--c"><div class="hs-wrap">${handshake('ok')}</div>
        <p class="dlg__lead"><b>${esc(o?.name || 'Salesforce org')}</b> <span class="pill ${o?.isSandbox ? 'pill--sb' : 'pill--prod'}">${o?.isSandbox ? 'Sandbox' : 'Production'}</span></p>
        <p class="dlg__fine">${esc(u?.username || u?.name || '')}${o?.instanceName ? ` · ${esc(o.instanceName)}` : ''}</p></div>
        <footer class="dlg__foot"><button class="btn btn--primary" type="button" data-close>Start practising</button></footer>`;
    }
    return `${header('Could not connect')}${dots()}
      <div class="dlg__body dlg__body--c"><div class="hs-wrap">${handshake('bad')}</div>
      <p class="dlg__lead">${esc(errMsg || 'Something went wrong while connecting.')}</p>
      ${(looksBlocked(errMsg) || closedEarly) && !useOwn
        ? `<p class="dlg__fine">Salesforce lets a site log in to your org only after its login connector is installed there. If Salesforce showed a message like <i>“Cross-org OAuth flows are not supported”</i> or <i>“app not installed”</i>, that is the reason. <b>Install the connector once</b> (about a minute, needs an admin), then connect again. No access is given until you log in and click Allow.</p></div>
      <footer class="dlg__foot"><button class="btn" type="button" data-close>Close</button><button class="btn" type="button" data-own>Use my own app</button><button class="btn" type="button" data-retry>Try again</button><button class="btn btn--primary" type="button" data-install>Install the connector</button></footer>`
        : `<p class="dlg__fine">Check that you picked the right environment (sandbox orgs use a different login) and try again.${useOwn ? ' Also check the callback URL and that the Consumer Key is from the same org.' : ''}</p></div>
      <footer class="dlg__foot"><button class="btn" type="button" data-close>Close</button>${useOwn ? '' : '<button class="btn" type="button" data-own>Use my own app</button>'}<button class="btn btn--primary" type="button" data-retry>Try again</button></footer>`}`;
  }

  function draw(animate: boolean) {
    dlg.innerHTML = `<div class="dlg__card"><div class="dlg__view${animate && !ctx.reduced ? (dir > 0 ? ' in-fwd' : ' in-back') : ''}">${body()}</div></div>`;
    wire();
    if (step === 'choose' && env === 'custom') (dlg.querySelector('#cn-domain') as HTMLInputElement | null)?.focus();
    else (dlg.querySelector('.btn--primary') as HTMLElement | null)?.focus({ preventScroll: true });
  }

  function validateDomain(): string | null {
    const r = normalizeDomain(domainRaw);
    if (r.ok) { domainErr = ''; return r.host; }
    domainErr = r.message + (r.suggestion ? ` Did you mean ${r.suggestion}?` : '');
    return null;
  }

  function wire() {
    dlg.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));
    dlg.querySelectorAll<HTMLInputElement>('input[name=env]').forEach((r) => r.addEventListener('change', () => {
      env = r.value as EnvId; hint = ''; useOwn = false;
      dlg.querySelectorAll('.envc').forEach((c) => c.classList.toggle('is-on', (c.querySelector('input') as HTMLInputElement).checked));
      const dom = dlg.querySelector<HTMLElement>('.dom')!;
      dom.hidden = env !== 'custom';
      if (env === 'custom') dlg.querySelector<HTMLInputElement>('#cn-domain')?.focus();
    }));
    const input = dlg.querySelector<HTMLInputElement>('#cn-domain');
    input?.addEventListener('input', () => { domainRaw = input.value; if (domainErr) { domainErr = ''; const m = dlg.querySelector('#cn-domain-msg')!; m.textContent = 'Paste the address from your browser, we will clean it up.'; m.classList.remove('is-bad'); input.removeAttribute('aria-invalid'); } });
    input?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); next(); } });
    // A button can appear twice on one screen (for example "change" and "Back"), so every handler is attached to ALL matches.
    const on = (sel: string, fn: () => void) => dlg.querySelectorAll(sel).forEach((el) => el.addEventListener('click', fn));
    on('[data-next]', next);
    on('[data-back]', () => { cleanup(); go('choose', -1); });
    dlg.querySelectorAll<HTMLElement>('[data-org]').forEach((b) => b.addEventListener('click', () => pickSaved(Number(b.dataset.org))));
    dlg.querySelectorAll<HTMLElement>('[data-forget]').forEach((b) => b.addEventListener('click', () => {
      saved.splice(Number(b.dataset.forget), 1); writeOrgs(saved); draw(false);
    }));
    dlg.querySelectorAll('[data-install]').forEach((b) => b.addEventListener('click', installFirst));
    on('[data-opened]', () => { window.setTimeout(() => { opened = true; draw(false); }, 60); });
    on('[data-after-install]', () => { hint = ''; useOwn = false; start(); });
    on('[data-own]', () => { cleanup(); go('own'); });
    const keyIn = dlg.querySelector<HTMLInputElement>('#cn-key');
    keyIn?.addEventListener('input', () => {
      ownKey = keyIn.value.trim();
      if (ownErr) { ownErr = ''; keyIn.removeAttribute('aria-invalid'); const m = dlg.querySelector('#cn-key-msg'); if (m) { m.classList.remove('is-bad'); m.textContent = 'It is only used to log you in. It is not a password.'; } }
    });
    keyIn?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); startOwn(); } });
    on('[data-go-own]', startOwn);
    on('[data-cancel]', () => { cleanup(); go('choose', -1); });
    on('[data-other]', () => { cleanup(); go('choose', -1); });
    on('[data-retry]', () => go(useOwn ? 'own' : 'choose', -1));
    on('[data-redirect]', () => {
      cleanup();
      location.href = loginUrl(env, env === 'custom' ? validateDomain() : null, loginOpts(false, useOwn ? ownKey : undefined, hint));
    });
    dlg.querySelectorAll<HTMLElement>('[data-copy]').forEach((el) => el.addEventListener('click', () => { void navigator.clipboard?.writeText(el.dataset.copy || ''); el.classList.add('is-copied'); window.setTimeout(() => el.classList.remove('is-copied'), 1200); }));
  }

  function next() {
    if (env === 'custom') {
      const host = validateDomain();
      if (!host) { draw(false); dlg.querySelector<HTMLInputElement>('#cn-domain')?.focus(); return; }
      domainRaw = host;
    }
    hint = ''; useOwn = false;
    start();
  }

  function installFirst() {
    cleanup();
    if (env === 'custom') {
      const host = validateDomain();
      if (!host) { go('choose', -1); return; }
      domainRaw = host;
    }
    opened = false;
    go('install');
  }

  /** One click on a remembered org: same environment, username pre-filled on the Salesforce login page. */
  function pickSaved(i: number) {
    const o = saved[i];
    if (!o) return;
    env = o.env; domainRaw = o.host ?? ''; hint = o.username;
    useOwn = o.own && KEY_RE.test(ownKey);
    if (o.own && !useOwn) { go('own'); return; }   // it was connected with the visitor's own app and the key is gone: ask for it again
    start();
  }

  function remember(s: SessionInfo) {
    if (!s.user?.username) return;
    const host = env === 'custom' ? (normalizeDomain(domainRaw).ok ? (normalizeDomain(domainRaw) as { host: string }).host : null) : null;
    if (env === 'custom' && !host) return;
    const entry: Saved = { env, host, name: s.org?.name || s.user.username, username: s.user.username, sandbox: Boolean(s.org?.isSandbox), own: useOwn };
    saved = [entry, ...saved.filter((o) => !sameOrg(o, entry))].slice(0, 4);
    writeOrgs(saved);
  }

  // The login window could not reach this tab directly and opened the site with the token instead: it saved it for us.
  function onStorage(ev: StorageEvent) {
    if (ev.key !== TOKEN_KEY || !ev.newValue) return;
    window.clearInterval(timer);
    void finish();
  }

  function onMessage(ev: MessageEvent) {
    if (ev.origin !== (isRemote ? API_BASE : location.origin)) return;
    const d = ev.data as { type?: string; ok?: boolean; message?: string; error?: string; token?: string } | null;
    if (!d || d.type !== 'sf-connected') return;
    if (isRemote && d.ok && typeof d.token === 'string' && /^[A-Za-z0-9._-]{20,3100}$/.test(d.token)) {
      setToken(d.token);
      try { (ev.source as Window | null)?.postMessage({ type: 'sf-ack' }, ev.origin); } catch { /* the login window will fall back by itself */ }
    }
    window.clearInterval(timer);
    if (d.ok) void finish();
    else { errMsg = d.message || d.error || ''; cleanup(); go('error'); }
  }

  async function finish() {
    try {
      const s = await getSession();
      if (!s.connected) throw new Error('The session was not created. Please try again.');
      result = s; remember(s); cleanup(); go('done'); ctx.onConnected(s);
    } catch (e) { errMsg = (e as Error).message; cleanup(); go('error'); }
  }

  function startOwn() {
    const k = (dlg.querySelector<HTMLInputElement>('#cn-key')?.value ?? ownKey).trim();
    if (!KEY_RE.test(k)) { ownKey = k; ownErr = 'That does not look like a Consumer Key. It is a long text of letters and numbers, usually starting with 3MVG.'; draw(false); dlg.querySelector<HTMLInputElement>('#cn-key')?.focus(); return; }
    ownKey = k; useOwn = true;
    try { localStorage.setItem(OWN_KEY, k); } catch { /* storage blocked: fine */ }
    start();
  }

  function start() {
    closedEarly = false;
    const host = env === 'custom' ? validateDomain() : null;
    if (env === 'custom' && !host) { go('choose', -1); return; }
    const w = 520, h = 720;
    const left = Math.max(0, Math.round(window.screenX + (window.outerWidth - w) / 2));
    const top = Math.max(0, Math.round(window.screenY + (window.outerHeight - h) / 2));
    popup = window.open(loginUrl(env, host, loginOpts(true, useOwn ? ownKey : undefined, hint)), 'sf-connect', `popup=yes,width=${w},height=${h},left=${left},top=${top}`);
    if (!popup) { errMsg = 'Your browser blocked the login window. Allow pop-ups for this site, or log in on this page instead.'; go('error'); return; }
    window.addEventListener('message', onMessage);
    window.addEventListener('storage', onStorage);
    go('connecting');
    let closedAt = 0;
    timer = window.setInterval(async () => {
      if (!popup || !popup.closed) { closedAt = 0; return; }
      closedAt ||= Date.now();
      if (Date.now() - closedAt < 1500) return; // give a just-delivered message a moment to arrive
      window.clearInterval(timer);
      try { const s = await getSession(); if (s.connected) return void finish(); } catch { /* fall through */ }
      errMsg = 'The Salesforce window was closed before you finished logging in.'; closedEarly = true;
      cleanup(); go('error');
    }, 500);
  }

  dlg.addEventListener('close', cleanup, { once: true });
  dlg.addEventListener('click', (e) => { if (e.target === dlg) close(); });
  draw(false);
  if (!dlg.open) dlg.showModal();
}
