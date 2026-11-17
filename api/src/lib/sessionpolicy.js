// Session and sign-in security rules that platform administrators set per organization.
// Pure functions only (no storage), so they are easy to test.
//
// How enforcement works (see http.js):
// - Maximum session length uses the access token's `auth_time` claim: the time the person last
//   signed in interactively. Silent token refresh does not change it, so it cannot be extended
//   without signing in again. `auth_time` is an optional claim: add it to the API app
//   registration (Token configuration > Add optional claim > Access > auth_time).
// - Idle timeout is tracked on the server per sign-in (user + auth_time).
// - "Require MFA" uses a Conditional Access authentication context. v2.0 access tokens carry no
//   `amr` claim, so the API cannot see MFA directly. The customer creates an authentication
//   context (default c1) and a Conditional Access policy that requires MFA for it; tokens then
//   carry `acrs: ["c1"]`, which the API checks. Without that setup, sign-ins are refused.

export const LIMITS = { maxHours: 720, idleMinutes: 1440 };
export const MFA_MODES = ['default', 'required', 'off'];
export const AUTH_CONTEXT = /^c([1-9]|[1-9][0-9])$/;
export const DEFAULT_PLATFORM_POLICY = Object.freeze({ maxHours: 0, idleMinutes: 0, requireMfa: false, authContext: 'c1' });

const whole = (v, max, label) => {
  if (v === '' || v == null) return '';
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > max) throw new RangeError(`${label} must be a whole number from 0 to ${max}.`);
  return n;
};

// Platform-wide default, stored in SiteContent/global/security.
export function cleanPlatformPolicy(b = {}) {
  const authContext = String(b.authContext || 'c1').trim().toLowerCase();
  if (!AUTH_CONTEXT.test(authContext)) throw new RangeError('The authentication context ID must look like c1 to c99.');
  return {
    maxHours: whole(b.maxHours, LIMITS.maxHours, 'Maximum session length') || 0,
    idleMinutes: whole(b.idleMinutes, LIMITS.idleMinutes, 'Idle timeout') || 0,
    requireMfa: b.requireMfa === true,
    authContext
  };
}

// Per-organization overrides, stored on the Tenants row. Blank means "use the platform default".
export function cleanTenantPolicy(b = {}) {
  const mfa = MFA_MODES.includes(b.mfaMode) ? b.mfaMode : 'default';
  return {
    sessionMaxHours: whole(b.sessionMaxHours, LIMITS.maxHours, 'Maximum session length'),
    sessionIdleMinutes: whole(b.sessionIdleMinutes, LIMITS.idleMinutes, 'Idle timeout'),
    mfaMode: mfa
  };
}

// The rules that apply to one organization.
export function effectivePolicy(tenant, platform = DEFAULT_PLATFORM_POLICY) {
  const p = { ...DEFAULT_PLATFORM_POLICY, ...(platform || {}) };
  const t = tenant || {};
  const pick = (v, d) => (v === '' || v == null || Number.isNaN(Number(v)) ? d : Number(v));
  const mode = MFA_MODES.includes(t.mfaMode) ? t.mfaMode : 'default';
  return {
    maxHours: pick(t.sessionMaxHours, p.maxHours),
    idleMinutes: pick(t.sessionIdleMinutes, p.idleMinutes),
    requireMfa: mode === 'required' ? true : mode === 'off' ? false : !!p.requireMfa,
    authContext: p.authContext || 'c1',
    source: { session: t.sessionMaxHours !== '' && t.sessionMaxHours != null ? 'organization' : 'platform', mfa: mode === 'default' ? 'platform' : 'organization' }
  };
}

export const hasAuthContext = (acrs, id) => Array.isArray(acrs) && acrs.includes(id);

// Decide whether a request may continue. Returns null when it may, or { code, message }.
// claims: { authTime (seconds), acrs }  session: { lastSeen ms } or null  now: ms
export function evaluate(policy, claims, session, now = Date.now()) {
  if (policy.requireMfa && !hasAuthContext(claims.acrs, policy.authContext)) {
    return { code: 'mfa_required', message: 'Your organization requires multi-factor authentication for NexpatchOnline. Please sign in again with MFA.' };
  }
  if (policy.maxHours > 0 && claims.authTime) {
    if (now - claims.authTime * 1000 > policy.maxHours * 3600e3) return { code: 'session_expired', message: `Your session has reached its ${policy.maxHours}-hour limit. Please sign in again.` };
  }
  if (policy.idleMinutes > 0 && session && session.lastSeen) {
    if (now - session.lastSeen > policy.idleMinutes * 60e3) return { code: 'session_idle', message: `You were inactive for more than ${policy.idleMinutes} minutes. Please sign in again.` };
  }
  return null;
}

// The claims challenge the browser sends back to Entra ID to step up to the auth context.
export const mfaClaims = id => JSON.stringify({ access_token: { acrs: { essential: true, value: id } } });

// ISO country code reported by the browser (from Cloudflare's /cdn-cgi/trace). Anything else is dropped.
export const cleanCountry = v => { const c = String(v || '').trim().toUpperCase(); return /^[A-Z]{2}$/.test(c) && c !== 'XX' && c !== 'T1' ? c : ''; };
