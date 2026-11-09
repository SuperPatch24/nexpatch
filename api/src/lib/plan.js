// Free trial and subscription status per organization.
export const TRIAL_DAYS = 30;

export function planStatus(t) {
  if (!t) return { plan: 'none', active: false, daysLeft: 0, trialEndsAt: null };
  const plan = t.plan || (t.trialEndsAt ? 'trial' : 'legacy');
  if (plan === 'active') return { plan, active: true, daysLeft: null, trialEndsAt: t.trialEndsAt || null };
  if (plan === 'expired') return { plan, active: false, daysLeft: 0, trialEndsAt: t.trialEndsAt || null };
  if (plan === 'legacy') return { plan: 'trial', active: true, daysLeft: TRIAL_DAYS, trialEndsAt: null }; // connected before trials existed
  const left = Math.ceil((Date.parse(t.trialEndsAt) - Date.now()) / 864e5);
  return { plan: left > 0 ? 'trial' : 'expired', active: left > 0, daysLeft: Math.max(0, left), trialEndsAt: t.trialEndsAt };
}

export function trialFields(existing) {
  if (existing && (existing.trialEndsAt || existing.plan)) return {};
  return { plan: 'trial', trialStartedAt: new Date().toISOString(), trialEndsAt: new Date(Date.now() + TRIAL_DAYS * 864e5).toISOString() };
}
