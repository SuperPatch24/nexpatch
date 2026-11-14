// Plans, prices and limits: the single source of truth. The public pricing page mirrors these numbers
// (a test fails if the two drift apart). PROPOSED launch prices in USD; billing/metering is not active yet.
export const TRIAL_DAYS = 15;
export const ANNUAL_DISCOUNT = 0.15;          // applies to the platform license only
export const APP_CONTROL_PER_DEVICE = 0.15;   // per device per month, optional add-on

export const TIERS = {
  starter:    { label: 'Starter',  flat: 19,  perDevice: 0,   maxDevices: 25,   annual: false, customApps: 2,  packageRequests: 2 },
  pro:        { label: 'Pro',      flat: 49,  perDevice: 1.0, maxDevices: 150,  annual: true,  customApps: 10, packageRequests: 10 },
  proplus:    { label: 'Pro Plus', flat: 129, perDevice: 1.0, maxDevices: 500, annual: true,  customApps: 40, packageRequests: 40 },
  enterprise: { label: 'Enterprise', custom: true }
};
export const isTier = t => Object.prototype.hasOwnProperty.call(TIERS, t);

const r2 = n => Math.round(n * 100) / 100;

// Monthly-equivalent cost estimate. Starter has no per-device charge and no annual option.
export function estimate({ tier, devices = 0, billing = 'monthly', appControl = false } = {}) {
  if (!isTier(tier)) return { error: 'Unknown plan.' };
  const t = TIERS[tier];
  if (t.custom) return { contact: true };
  const n = Math.max(0, Math.floor(Number(devices) || 0));
  const annual = billing === 'annual';
  if (annual && !t.annual) return { error: `${t.label} is billed monthly only.` };
  const platform = r2(t.flat * (annual ? 1 - ANNUAL_DISCOUNT : 1));
  const usage = r2(t.perDevice * n), appc = appControl ? r2(APP_CONTROL_PER_DEVICE * n) : 0;
  const monthly = r2(platform + usage + appc);
  return { tier, devices: n, billing: annual ? 'annual' : 'monthly', platform, usage, appControl: appc, monthly, overLimit: n > t.maxDevices,
    suggest: n > t.maxDevices ? (['starter', 'pro', 'proplus'].find(k => TIERS[k].maxDevices >= n) || 'enterprise') : null,
    annualLicenseTotal: annual ? r2(t.flat * 12 * (1 - ANNUAL_DISCOUNT)) : null };
}

// What a connected organization may do each month. Trials get Pro limits. A paid organization with no tier recorded
// (marked paid before tiers existed) is not limited. Expired trials fall back to Starter limits.
export function limitsFor(t) {
  const plan = t?.plan || (t?.trialEndsAt ? 'trial' : 'legacy');
  if (plan === 'active') {
    if (!t.tier) return { tier: null, devices: Infinity, customApps: Infinity, packageRequests: Infinity };
    const x = TIERS[t.tier];
    return x?.custom || !x ? { tier: t.tier, devices: Infinity, customApps: Infinity, packageRequests: Infinity } : { tier: t.tier, devices: x.maxDevices, customApps: x.customApps, packageRequests: x.packageRequests };
  }
  const x = plan === 'expired' ? TIERS.starter : TIERS.pro;
  return { tier: plan === 'expired' ? 'starter' : 'pro', devices: x.maxDevices, customApps: x.customApps, packageRequests: x.packageRequests };
}

export const monthStart = (now = new Date()) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
export const countThisMonth = (rows, field = 'createdAt', now = new Date()) => rows.filter(r => String(r[field] || '') >= monthStart(now)).length;

const NOUN = { customApps: 'custom app builds', packageRequests: 'app package requests' };
// Returns an upgrade message when the monthly limit is used up, otherwise ''.
export function limitMessage(kind, limits, used) {
  const max = limits[kind];
  if (!Number.isFinite(max) || used < max) return '';
  return `Your plan includes ${max} ${NOUN[kind]} per month and you have used them all. They reset on the 1st (UTC). Contact NexpatchOnline to upgrade your plan.`;
}
