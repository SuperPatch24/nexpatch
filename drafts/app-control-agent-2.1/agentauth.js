// Per-device credentials for the App Control agent.
// A short-lived enrollment key lets a device that exists in the organization's Intune inventory register once and receive its own
// token. After that, only the token works. Admins can revoke one device without touching the others.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const GUID = /^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/;
export const ENROLL_KEY_DAYS = 30;
export const LIMITS = { callsPerHour: 900, eventsPerHour: 5000, enrollsPerHour: 5, tenantEnrollsPerHour: 300 };

export const sha = v => createHash('sha256').update(String(v)).digest();
export const newSecret = () => randomBytes(32).toString('base64url');
export const hashSecret = v => sha(v).toString('hex');

export function secretMatches(expectedHex, given) {
  if (!expectedHex || !given) return false;
  const a = Buffer.from(String(expectedHex), 'hex'), b = sha(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const keyExpiry = (from = new Date()) => new Date(from.getTime() + ENROLL_KEY_DAYS * 86400000).toISOString();
export const keyExpired = (t, now = new Date()) => !t.acKeyExpiresAt || Date.parse(t.acKeyExpiresAt) <= now.getTime();

// Fixed one-hour windows kept on the row itself. Returns { ok, retryAfter, patch }.
export function rateCheck(row, now, events, kind = 'ingest', limits = LIMITS) {
  const startKey = kind === 'enroll' ? 'enrollWindowStart' : 'winStart', countKey = kind === 'enroll' ? 'enrollCount' : 'winCalls', evKey = 'winEvents';
  const start = Date.parse(row[startKey] || '') || 0;
  const fresh = now.getTime() - start >= 3600000;
  const calls = (fresh ? 0 : Number(row[countKey] || 0)) + 1;
  const evs = kind === 'enroll' ? 0 : (fresh ? 0 : Number(row[evKey] || 0)) + events;
  const maxCalls = kind === 'enroll' ? limits.enrollsPerHour : limits.callsPerHour;
  const winStart = fresh ? now.toISOString() : row[startKey];
  if (calls > maxCalls || evs > limits.eventsPerHour) {
    return { ok: false, retryAfter: Math.max(60, Math.ceil((Date.parse(winStart) + 3600000 - now.getTime()) / 1000)), patch: null };
  }
  return { ok: true, retryAfter: 0, patch: { [startKey]: winStart, [countKey]: calls, ...(kind === 'enroll' ? {} : { [evKey]: evs }) } };
}

export const agentSignerWarning = ev => (ev.deviceCount || 0) <= 1;
