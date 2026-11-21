// Thin client for /api/sf/*.
//  - Same site (npm run dev, or the site and API served together): an HttpOnly cookie carries the session.
//  - Hosted API (PUBLIC_SF_API_URL is set at build time and points to another origin, e.g. your Render service):
//    the API hands back an opaque session token, kept in localStorage and sent as `Authorization: Bearer`.
//    The token is encrypted by the server, so the browser cannot read what is inside it.
export interface SessionInfo {
  connected: boolean;
  user?: { name: string | null; username: string | null; email: string | null; userId: string | null };
  org?: { id: string | null; name: string | null; isSandbox: boolean | null; instanceUrl: string; loginHost: string; instanceName: string | null };
  apiVersion?: string;
  expiresInSec?: number;
}
export interface Config { configured: boolean; redirectUri: string; origin: string; apiVersion: string; environments: { id: string; label: string; host: string | null }[] }
export interface ApiFail { ok: false; error: string; message: string; status?: number }
export class ApiError extends Error {
  code: string; status: number;
  constructor(code: string, message: string, status: number) { super(message); this.code = code; this.status = status; }
}

const RAW_BASE = String((import.meta as any).env?.PUBLIC_SF_API_URL ?? '').trim().replace(/\/+$/, '');
let baseOrigin = '';
try { baseOrigin = RAW_BASE ? new URL(RAW_BASE).origin : ''; } catch { baseOrigin = ''; }
/** True when the API lives on a different origin than this page. */
export const isRemote = Boolean(baseOrigin) && baseOrigin !== location.origin;
export const API_BASE = isRemote ? baseOrigin : '';
export const TOKEN_KEY = 'sfp_token';

export function getToken(): string | null { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } }
export function setToken(t: string) { try { localStorage.setItem(TOKEN_KEY, t); } catch { /* storage blocked: the session lasts until reload */ memToken = t; } }
export function clearToken() { memToken = null; try { localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ } }
let memToken: string | null = null;
const currentToken = () => getToken() ?? memToken;

/** After a hosted login that had to open this site in the login window, the token arrives as #sf_token=... */
export function takeTokenFromUrl(): { popup: boolean } | null {
  const m = /^#(?:.*&)?sf_token=([^&]+)/.exec(location.hash);
  if (!m) return null;
  let tok = '';
  try { tok = decodeURIComponent(m[1]); } catch { return null; }
  const popup = /(?:^|[#&])sf_popup=1(?:&|$)/.test(location.hash);
  history.replaceState(null, '', location.pathname + location.search);
  if (!/^[A-Za-z0-9._-]{20,3100}$/.test(tok)) return null;
  setToken(tok);
  return { popup };
}

type Listener = () => void;
const expiredListeners = new Set<Listener>();
export const onSessionLost = (fn: Listener) => { expiredListeners.add(fn); return () => expiredListeners.delete(fn); };

async function req<T>(path: string, init?: RequestInit & { json?: unknown; signal?: AbortSignal }): Promise<T> {
  let res: Response;
  try {
    const headers: Record<string, string> = init?.json !== undefined ? { 'Content-Type': 'application/json', Accept: 'application/json' } : { Accept: 'application/json' };
    const tok = isRemote ? currentToken() : null;
    if (tok) headers.Authorization = `Bearer ${tok}`;
    res = await fetch(API_BASE + path, {
      method: init?.json !== undefined ? 'POST' : init?.method ?? 'GET',
      headers,
      body: init?.json !== undefined ? JSON.stringify(init.json) : undefined,
      credentials: isRemote ? 'omit' : 'same-origin',
      signal: init?.signal,
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new ApiError('offline', navigator.onLine ? 'Could not reach the site. Try again in a moment.' : 'You are offline.', 0);
  }
  let body: any = null;
  try { body = await res.json(); } catch { /* not json */ }
  if (!res.ok || (body && body.ok === false)) {
    const code = body?.error || `http_${res.status}`;
    if (code === 'session_expired' || code === 'not_connected') { if (isRemote) clearToken(); expiredListeners.forEach((f) => f()); }
    throw new ApiError(code, body?.message || `Request failed (${res.status}).`, res.status);
  }
  return body as T;
}

export const getConfig = () => req<Config>('/api/sf/config');
export const getSession = async (): Promise<SessionInfo> => {
  // Hosted API without a token: nothing to ask (and a sleeping free host is not woken up for nothing).
  if (isRemote && !currentToken()) return { connected: false };
  const s = await req<SessionInfo>('/api/sf/session');
  if (isRemote && !s.connected) clearToken();
  return s;
};
export const logout = async () => {
  try { return await req<{ ok: true }>('/api/sf/logout', { json: {} }); } finally { if (isRemote) clearToken(); }
};
export interface QueryResult { ok: true; totalSize: number; done: boolean; records: Record<string, unknown>[]; columns: { name: string; type?: string }[]; fields?: string[]; nextCursor?: string; ms: number }
export const runQuery = (soql: string, opts: { all?: boolean; tooling?: boolean } = {}, signal?: AbortSignal) => req<QueryResult>('/api/sf/query', { json: { soql, ...opts }, signal });
export const queryMore = (cursor: string) => req<QueryResult>('/api/sf/query-more', { json: { cursor } });
export interface ApexResult { ok: true; compiled: boolean; success: boolean; line: number; column: number; compileProblem: string | null; exceptionMessage: string | null; exceptionStackTrace: string | null; log: string; logBytes: number; truncated?: boolean; ms: number }
export const runApex = (code: string, logLevel: string, signal?: AbortSignal) => req<ApexResult>('/api/sf/apex', { json: { code, logLevel }, signal });
export interface ObjectInfo { name: string; label: string; labelPlural: string; custom: boolean; queryable: boolean; keyPrefix: string | null }
export const describeGlobal = () => req<{ ok: true; objects: ObjectInfo[] }>('/api/sf/describe-global');
export interface FieldInfo { name: string; label: string; type: string; length: number; custom: boolean; nillable: boolean; referenceTo: string[]; relationshipName: string | null; picklistValues: { value: string; label: string; active: boolean }[]; filterable: boolean; sortable: boolean }
export interface Describe { ok: true; name: string; label: string; labelPlural: string; custom: boolean; keyPrefix: string | null; fields: FieldInfo[]; childRelationships: { childSObject: string; field: string; relationshipName: string }[] }
export const describeObject = (name: string) => req<Describe>(`/api/sf/describe?name=${encodeURIComponent(name)}`);
export const getLimits = () => req<{ ok: true; apiRequests: { max: number | null; remaining: number | null } }>('/api/sf/limits');
