// Storage side of session controls, sign-in history and daily usage counters.
// Sessions:   PartitionKey = tenant ID, RowKey = <user oid>_<auth_time>, { lastSeen, startedAt, country, mfa }
// SignIns:    PartitionKey = UTC day (YYYY-MM-DD), RowKey = newest first, { tenantId, userId, country, mfa, authTime }
// UsageDaily: PartitionKey = UTC day, RowKey = tenant ID, { requests }
import { getRow, putRow, listRows } from './store.js';
import { accessTenant } from './access.js';
import { DEFAULT_PLATFORM_POLICY, effectivePolicy, evaluate, mfaClaims, cleanCountry } from './sessionpolicy.js';
import { HttpError } from './http.js';

const day = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 10);
const TOUCH_EVERY = 2 * 60e3; // write lastSeen at most every 2 minutes per sign-in

let platformCache = { at: 0, v: null };
export function clearPlatformPolicyCache() { platformCache = { at: 0, v: null }; }
export async function platformPolicy() {
  if (platformCache.v && Date.now() - platformCache.at < 60e3) return platformCache.v;
  let v = DEFAULT_PLATFORM_POLICY;
  try {
    const r = await getRow('SiteContent', 'global', 'security');
    if (r) v = { maxHours: Number(r.maxHours) || 0, idleMinutes: Number(r.idleMinutes) || 0, requireMfa: r.requireMfa === true, authContext: r.authContext || 'c1' };
  } catch { /* storage hiccup: keep defaults rather than lock everyone out */ }
  platformCache = { at: Date.now(), v };
  return v;
}

export async function policyFor(tenantId) {
  const [tenant, platform] = await Promise.all([accessTenant(tenantId), platformPolicy()]);
  return effectivePolicy(tenant, platform);
}

const sessionCache = new Map(); // key -> { lastSeen, wroteAt }
const sessionKey = user => `${user.userId}_${user.authTime}`;

// Called for every signed-in API request. Throws a 401 with a machine-readable code when the
// organization's rules say the person must sign in again.
export async function enforceSession(user) {
  const policy = await policyFor(user.tenantId);
  const active = policy.requireMfa || policy.maxHours > 0 || policy.idleMinutes > 0;
  if (!active) return policy;
  const now = Date.now();
  let session = null;
  if (policy.idleMinutes > 0 && user.authTime) {
    const key = sessionKey(user), cacheKey = user.tenantId + ':' + key;
    session = sessionCache.get(cacheKey);
    if (!session) {
      const row = await getRow('Sessions', user.tenantId, key).catch(() => null);
      session = row ? { lastSeen: Date.parse(row.lastSeen) || now, wroteAt: now } : { lastSeen: now, wroteAt: 0 };
    }
    const verdict = evaluate(policy, user, session, now);
    if (verdict) throw challenge(verdict, policy);
    session.lastSeen = now;
    if (now - session.wroteAt > TOUCH_EVERY) {
      session.wroteAt = now;
      putRow('Sessions', user.tenantId, key, { lastSeen: new Date(now).toISOString(), userId: user.userId, authTime: user.authTime }).catch(() => {});
    }
    sessionCache.set(cacheKey, session);
    if (sessionCache.size > 20000) sessionCache.delete(sessionCache.keys().next().value);
    return policy;
  }
  const verdict = evaluate(policy, user, null, now);
  if (verdict) throw challenge(verdict, policy);
  return policy;
}

function challenge(verdict, policy) {
  const e = new HttpError(401, verdict.message, verdict.code);
  if (verdict.code === 'mfa_required') e.claims = mfaClaims(policy.authContext);
  return e;
}

// Record one interactive sign-in. The browser calls this once after it returns from Microsoft.
export async function recordSignIn(user, country) {
  const now = Date.now();
  const policy = await policyFor(user.tenantId).catch(() => DEFAULT_PLATFORM_POLICY);
  const rk = String(9999999999999 - now).padStart(13, '0') + '_' + Math.random().toString(36).slice(2, 8);
  const row = { tenantId: user.tenantId, userId: user.userId, country: cleanCountry(country), mfa: user.acrs.includes(policy.authContext || 'c1'),
    authTime: user.authTime || '', at: new Date(now).toISOString() };
  await putRow('SignIns', day(now), rk, row, 'Replace');
  if (user.authTime) await putRow('Sessions', user.tenantId, sessionKey(user), { lastSeen: row.at, startedAt: new Date(user.authTime * 1000).toISOString(), userId: user.userId, authTime: user.authTime, country: row.country, mfa: row.mfa }).catch(() => {});
  return row;
}

export async function signInsForDays(days) {
  const out = [];
  for (let i = 0; i < days; i++) for (const r of await listRows('SignIns', day(Date.now() - i * 864e5), 5000)) out.push(r);
  return out;
}

// Per-instance request counters, flushed about once a minute. Counts are approximate when
// several Function instances flush at the same moment, which is fine for a usage chart.
const pending = new Map();
let flushTimer = null;
export function countRequest(tenantId) {
  if (!tenantId) return;
  const k = day() + '|' + tenantId;
  pending.set(k, (pending.get(k) || 0) + 1);
  if (!flushTimer) flushTimer = setTimeout(flushUsage, 60e3);
}
export async function flushUsage() {
  flushTimer = null;
  const items = [...pending.entries()]; pending.clear();
  for (const [k, n] of items) {
    const [d, tid] = k.split('|');
    try { const r = await getRow('UsageDaily', d, tid); await putRow('UsageDaily', d, tid, { requests: (Number(r?.requests) || 0) + n }); } catch { /* best effort */ }
  }
}
export async function usageForDays(days) {
  const out = [];
  for (let i = 0; i < days; i++) { const d = day(Date.now() - i * 864e5); for (const r of await listRows('UsageDaily', d, 5000)) out.push({ day: d, tenantId: r.rowKey, requests: Number(r.requests) || 0 }); }
  return out;
}
export const utcDay = day;
