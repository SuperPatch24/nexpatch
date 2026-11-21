// Per-organization settings the platform operator controls (multi-tenant administration).
// Everything here is optional: an organization with no settings behaves exactly as before.

export const ACCESS = ['active', 'suspended', 'revoked'];
export const FEATURES = {
  apps:       'Apps and patching',
  packaging:  'Packaging and publishing',
  appControl: 'App Control',
  nightlySync: 'Nightly inventory sync',
  deviceReports: 'Device reports',
  automation: 'Automation'
};

// Which keys are whole products a company is granted (the rest are functions inside them), in the order the Admin Center shows them.
export const PRODUCT_FEATURES = ['apps', 'appControl', 'automation', 'deviceReports'];
export const featureMap = t => Object.fromEntries(Object.keys(FEATURES).map(k => [k, featureOn(t, k)]));
// Turns a { key: true|false } request into stored fields. Only keys that are named change; unknown keys are ignored.
export function featureFields(requested = {}) {
  const f = {};
  for (const k of Object.keys(FEATURES)) if (requested && typeof requested[k] === 'boolean') f['feat_' + k] = requested[k] ? 'on' : 'off';
  return f;
}

// Access status: active (normal), suspended (can sign in and read, nothing can be changed), revoked (no access at all).
export const accessOf = t => (ACCESS.includes(t?.accessStatus) ? t.accessStatus : 'active');

export function accessMessage(t) {
  const s = accessOf(t);
  if (s === 'revoked') return 'Access to NexpatchOnline for your organization has ended' + (t.accessReason ? ' (' + t.accessReason + ')' : '') + '. Contact NexpatchOnline to renew your subscription.';
  if (s === 'suspended') return 'Your organization is suspended' + (t.accessReason ? ' (' + t.accessReason + ')' : '') + ', so changes are turned off. You can still view your data. Contact NexpatchOnline to restore access.';
  return '';
}

// Features are on unless the operator switched them off.
export const featureOn = (t, key) => t?.['feat_' + key] !== 'off' && t?.['feat_' + key] !== false;
export function featureMessage(key) { return `${FEATURES[key] || 'This feature'} is turned off for your organization. Contact NexpatchOnline to enable it.`; }

// Optional per-organization limit overrides. Blank/absent means "use the plan's limit".
export function overrideNumber(v) { if (v === '' || v == null) return null; const n = Math.floor(Number(v)); return Number.isFinite(n) && n >= 0 && n <= 1e6 ? n : null; }

// Email domains allowed for invitations ("contoso.com, fabrikam.com"). Empty = any domain.
export function parseDomains(text) {
  return [...new Set(String(text || '').toLowerCase().split(/[\s,;]+/).map(s => s.replace(/^@/, '')).filter(d => /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(d)))].slice(0, 20);
}
export function emailDomainAllowed(email, allowedText) {
  const list = parseDomains(allowedText); if (!list.length) return true;
  return list.includes(String(email || '').toLowerCase().split('@')[1] || '');
}

// Highest role granted by the groups a person belongs to. grants: [{groupId, role}], memberIds: Set of group ids.
export function highestGrantedRole(grants, memberIds, roleOrder = ['viewer', 'admin']) {
  const roles = grants.filter(g => memberIds.has(g.groupId)).map(g => g.role).filter(r => roleOrder.includes(r));
  return roles.sort((a, b) => roleOrder.indexOf(b) - roleOrder.indexOf(a))[0] || null;
}
