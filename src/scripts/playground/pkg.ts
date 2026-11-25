// The SF SKODE Connector package (an External Client App packaged with 2GP, see connector/README.md).
// Salesforce lets a site log in to another org only after this app is installed there, so visitors install it once.
import type { EnvId } from './domain';

/** Subscriber Package Version Id (starts with 04t). Override with the PUBLIC_SF_PACKAGE_ID build variable after you release a new version. */
const DEFAULT_ID = '04tdL000000sDZlQAM';
const ID_RE = /^04t[A-Za-z0-9]{12,15}$/;
const raw = String((import.meta as any).env?.PUBLIC_SF_PACKAGE_ID ?? '').trim();
const fromUrl = /[?&]p0=(04t[A-Za-z0-9]{12,15})/.exec(String((import.meta as any).env?.PUBLIC_SF_PACKAGE_URL ?? ''))?.[1];   // the old variable still works
export const PKG_ID = ID_RE.test(raw) ? raw : fromUrl ?? DEFAULT_ID;

/** Salesforce install page for the visitor's kind of org. `host` is the My Domain host for env "custom". */
export function installUrl(env: EnvId, host?: string | null): string {
  const h = env === 'sandbox' ? 'test.salesforce.com' : env === 'custom' && host ? host : 'login.salesforce.com';
  return `https://${h}/packaging/installPackage.apexp?p0=${PKG_ID}`;
}
