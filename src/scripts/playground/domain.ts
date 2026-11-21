// Pure helpers for the "Custom domain (My Domain)" input. No DOM access, unit-tested with node --test.

export type DomainResult =
  | { ok: true; host: string; note?: string }
  | { ok: false; message: string; suggestion?: string };

/** Hosts Salesforce accepts for OAuth (mirrors the server allow-list). A host:port is only allowed for local test orgs. */
const ALLOWED_SUFFIXES = [
  '.my.salesforce.com',
  '.salesforce.com',
  '.force.com',
  '.salesforce.mil',
  '.cloudforce.com',
  '.salesforce-setup.com',
];

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function normalizeDomain(input: string): DomainResult {
  let v = (input ?? '').trim();
  if (!v) return { ok: false, message: 'Enter your My Domain, for example acme.my.salesforce.com.' };
  if (/\s/.test(v)) {
    // "https://acme.my.salesforce.com/lightning/page/home some other words": keep only the first token.
    v = v.split(/\s+/)[0];
  }
  v = v.replace(/^[a-z][a-z0-9+.-]*:\/\//i, ''); // scheme
  v = v.replace(/^\/\//, '');
  v = v.split(/[/?#]/)[0]; // path, query, hash
  if (v.includes('@')) v = v.slice(v.lastIndexOf('@') + 1); // credentials
  v = v.toLowerCase().replace(/\.+$/, '');
  if (!v) return { ok: false, message: 'Enter your My Domain, for example acme.my.salesforce.com.' };

  // Optional port: only meaningful for local test orgs (localhost / IPv4).
  let port = '';
  const pm = v.match(/^(.*):(\d{1,5})$/);
  if (pm) { v = pm[1]; port = pm[2]; }
  if (v.includes(':')) return { ok: false, message: 'That does not look like a hostname. Use something like acme.my.salesforce.com.' };

  const isLocal = v === 'localhost' || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(v);
  if (isLocal) {
    if (v !== 'localhost' && v.split('.').some((n) => Number(n) > 255)) return { ok: false, message: 'That IP address is not valid.' };
    return { ok: true, host: port ? `${v}:${port}` : v, note: 'Local test org.' };
  }
  if (port) return { ok: false, message: 'Remove the port number. Salesforce domains do not use one.' };

  // The bare word "acme": suggest the full My Domain.
  if (!v.includes('.')) {
    if (!LABEL.test(v)) return { ok: false, message: 'Use only letters, numbers and hyphens, for example acme.my.salesforce.com.' };
    return { ok: false, message: `"${v}" is not a full domain yet. Did you mean ${v}.my.salesforce.com?`, suggestion: `${v}.my.salesforce.com` };
  }

  let note: string | undefined;
  // Lightning and Setup hosts are not login hosts; map them to the My Domain they belong to.
  const lightning = v.match(/^([a-z0-9-]+(?:\.(?:sandbox|develop|scratch|demo))?)\.(?:lightning\.force\.com|my\.salesforce-setup\.com)$/);
  if (lightning) {
    v = `${lightning[1]}.my.salesforce.com`;
    note = `Using ${v} (your login domain).`;
  }
  const vf = v.match(/^([a-z0-9-]+(?:\.(?:sandbox|develop|scratch|demo))?)\.(?:my\.site\.com|vf\.force\.com)$/);
  if (vf) {
    v = `${vf[1]}.my.salesforce.com`;
    note = `Using ${v} (your login domain).`;
  }

  const labels = v.split('.');
  if (labels.some((l) => !LABEL.test(l))) return { ok: false, message: 'Use only letters, numbers, hyphens and dots. Spaces and symbols are not allowed.' };
  if (v.length > 253) return { ok: false, message: 'That domain is too long.' };
  if (!ALLOWED_SUFFIXES.some((s) => v.endsWith(s))) {
    return { ok: false, message: 'That is not a Salesforce domain. It should end in .my.salesforce.com (or .force.com / .salesforce.com).' };
  }
  if (v === 'login.salesforce.com' || v === 'test.salesforce.com') {
    return { ok: false, message: 'Pick Production or Sandbox for the standard login pages. Custom domain is for your own My Domain.' };
  }
  return note ? { ok: true, host: v, note } : { ok: true, host: v };
}

export type EnvId = 'production' | 'sandbox' | 'custom';

/** `base` is the API origin when it differs from this site; `site` is this site's origin, sent so the API knows where to return the login. */
export function loginUrl(env: EnvId, domain: string | null, opts: { popup: boolean; returnTo?: string; fresh?: boolean; base?: string; site?: string }): string {
  const q = new URLSearchParams();
  q.set('env', env);
  if (env === 'custom' && domain) q.set('domain', domain);
  if (opts.popup) q.set('popup', '1');
  q.set('returnTo', opts.returnTo ?? '/playground/');
  if (opts.fresh) q.set('fresh', '1');
  if (opts.base && opts.site) q.set('site', opts.site);
  return `${opts.base ?? ''}/api/sf/login?${q.toString()}`;
}
