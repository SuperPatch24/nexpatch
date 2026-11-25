// Stripe billing: pure helpers (no network, no storage) so every decision can be tested.
// The calls to Stripe themselves are in functions/billing.js, using plain HTTPS (no SDK needed).
import { createHmac, timingSafeEqual } from 'node:crypto';
import { TIERS, ANNUAL_DISCOUNT, APP_CONTROL_PER_DEVICE, estimate, isTier } from './plans.js';

export const STRIPE_API_VERSION = '2024-06-20';
export const SIGNATURE_TOLERANCE_SECONDS = 300;

export const billingConfigured = (env = process.env) => !!(String(env.STRIPE_SECRET_KEY || '').startsWith('sk_') || String(env.STRIPE_SECRET_KEY || '').startsWith('rk_')) && !!env.STRIPE_WEBHOOK_SECRET;
export const stripeMode = (env = process.env) => (String(env.STRIPE_SECRET_KEY || '').includes('_test_') ? 'test' : 'live');

// Stripe wants application/x-www-form-urlencoded with bracketed keys: a[b][0][c]=v
export function stripeForm(obj) {
  const out = [];
  const walk = (prefix, v) => {
    if (v === undefined || v === null) return;
    if (Array.isArray(v)) v.forEach((x, i) => walk(`${prefix}[${i}]`, x));
    else if (typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(`${prefix}[${k}]`, x);
    else out.push(encodeURIComponent(prefix) + '=' + encodeURIComponent(String(v)));
  };
  for (const [k, v] of Object.entries(obj || {})) walk(k, v);
  return out.join('&');
}

const cents = n => Math.round(n * 100);

// The lines of a subscription. Everything shares one billing interval, because Stripe does not allow a monthly and a
// yearly price on one subscription. Annual: the platform license is discounted (as on the pricing page) and the
// per-device prices are charged for 12 months at once.
export function subscriptionLines({ tier, billing = 'monthly', appControl = false, devices = 0 } = {}) {
  if (!isTier(tier) || TIERS[tier].custom) return { error: 'This plan is by quote. Contact NexpatchOnline sales.' };
  const t = TIERS[tier];
  const annual = billing === 'annual';
  if (annual && !t.annual) return { error: `${t.label} is billed monthly only.` };
  const interval = annual ? 'year' : 'month';
  const mult = annual ? 12 : 1;
  const n = Math.max(1, Math.floor(Number(devices) || 0));
  const line = (kind, name, unit, quantity) => ({ quantity, price_data: { currency: 'usd', unit_amount: unit, recurring: { interval }, product_data: { name, metadata: { kind } } } });
  const lines = [line('license', `NexpatchOnline ${t.label} platform license (${annual ? 'annual' : 'monthly'})`, annual ? cents(t.flat * 12 * (1 - ANNUAL_DISCOUNT)) : cents(t.flat), 1)];
  if (t.perDevice > 0) lines.push(line('devices', `NexpatchOnline per-device usage (${annual ? 'per year' : 'per month'})`, cents(t.perDevice * mult), n));
  if (appControl) lines.push(line('appcontrol', `NexpatchOnline App Control, per device (${annual ? 'per year' : 'per month'})`, cents(APP_CONTROL_PER_DEVICE * mult), n));
  return { lines, interval, devices: n };
}

// Parameters for a hosted Stripe Checkout page.
export function checkoutParams({ tenantId, email = '', customerId = '', tier, billing, appControl = false, devices = 0, siteUrl = 'https://nexpatchonline.com', automaticTax = false } = {}) {
  const s = subscriptionLines({ tier, billing, appControl, devices });
  if (s.error) return s;
  const meta = { tenantId: String(tenantId), tier, billing: billing === 'annual' ? 'annual' : 'monthly', appControl: appControl ? 'true' : 'false' };
  const base = String(siteUrl).replace(/\/+$/, '');
  const p = {
    mode: 'subscription',
    line_items: s.lines,
    client_reference_id: String(tenantId),
    success_url: `${base}/?billing=success#organization`,
    cancel_url: `${base}/?billing=cancelled#organization`,
    allow_promotion_codes: 'true',
    metadata: meta,
    subscription_data: { metadata: meta }
  };
  if (customerId) p.customer = customerId; else if (email) p.customer_email = email;
  if (automaticTax) { p.automatic_tax = { enabled: 'true' }; p.billing_address_collection = 'required'; if (customerId) p.customer_update = { address: 'auto', name: 'auto' }; }
  return { params: p, monthly: estimate({ tier, devices: s.devices, billing, appControl }).monthly, devices: s.devices };
}

// Stripe signs the raw request body: header "t=timestamp,v1=signature[,v1=...]".
export function verifySignature(rawBody, header, secret, { now = Date.now(), tolerance = SIGNATURE_TOLERANCE_SECONDS } = {}) {
  if (!rawBody || !header || !secret) return false;
  const parts = String(header).split(',').map(x => x.trim().split('='));
  const t = parts.find(p => p[0] === 't')?.[1];
  const sigs = parts.filter(p => p[0] === 'v1').map(p => p[1]).filter(Boolean);
  if (!t || !sigs.length || !/^\d+$/.test(t)) return false;
  if (Math.abs(now / 1000 - Number(t)) > tolerance) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  const a = Buffer.from(expected);
  return sigs.some(s => { const b = Buffer.from(s); return b.length === a.length && timingSafeEqual(a, b); });
}

// The end of the paid period. Newer Stripe API versions keep it on the subscription items.
export const periodEnd = sub => {
  const s = sub?.current_period_end ?? sub?.items?.data?.map(i => i.current_period_end).filter(Number.isFinite).sort((a, b) => a - b)[0];
  return Number.isFinite(s) ? new Date(s * 1000).toISOString() : '';
};

// Which subscription item is which (license, devices, App Control). Needs the product expanded.
export function itemsByKind(sub) {
  const out = {};
  for (const it of sub?.items?.data || []) {
    const kind = it?.price?.product?.metadata?.kind;
    if (kind) out[kind] = { id: it.id, quantity: it.quantity };
  }
  return out;
}

// What a subscription's state means for the organization.
//  active/trialing -> paid plan on; past_due -> keep the plan on but flag it; canceled/unpaid/incomplete_expired -> plan ended.
export function planFromSubscription(sub, existing = {}) {
  const md = sub?.metadata || {};
  const status = String(sub?.status || '');
  const f = {
    stripeCustomerId: typeof sub?.customer === 'string' ? sub.customer : sub?.customer?.id || existing.stripeCustomerId || '',
    stripeSubscriptionId: sub?.id || existing.stripeSubscriptionId || '',
    stripeStatus: status,
    paidUntil: periodEnd(sub) || existing.paidUntil || '',
    billingIssue: status === 'past_due' || status === 'unpaid'
  };
  if (isTier(md.tier) && !TIERS[md.tier].custom) {
    f.tier = md.tier; f.billing = md.billing === 'annual' ? 'annual' : 'monthly'; f.appControl = md.appControl === 'true';
    if (f.appControl) f.feat_appControl = 'on';
  }
  if (status === 'active' || status === 'trialing' || status === 'past_due') { f.plan = 'active'; f.cancelAtPeriodEnd = sub?.cancel_at_period_end === true; }
  else if (status === 'canceled' || status === 'unpaid' || status === 'incomplete_expired') { f.plan = 'expired'; f.cancelAtPeriodEnd = false; }
  return f;
}

// A device-count change: what the per-device lines should say now.
export function quantityUpdates(items, devices) {
  const n = Math.max(1, Math.floor(Number(devices) || 0));
  return ['devices', 'appcontrol'].filter(k => items?.[k] && items[k].quantity !== n).map(k => ({ id: items[k].id, quantity: n }));
}

export function invoiceRow(inv) {
  const money = c => Math.round(Number(c || 0)) / 100;
  return {
    number: inv.number || '', status: inv.status || '', currency: String(inv.currency || 'usd').toUpperCase(),
    amountDue: money(inv.amount_due), amountPaid: money(inv.amount_paid), total: money(inv.total),
    hostedUrl: inv.hosted_invoice_url || '', pdfUrl: inv.invoice_pdf || '',
    periodStart: inv.period_start ? new Date(inv.period_start * 1000).toISOString() : '', periodEnd: inv.period_end ? new Date(inv.period_end * 1000).toISOString() : '',
    dueAt: inv.due_date ? new Date(inv.due_date * 1000).toISOString() : '', createdAt: inv.created ? new Date(inv.created * 1000).toISOString() : new Date().toISOString(),
    customerId: typeof inv.customer === 'string' ? inv.customer : inv.customer?.id || '', provider: 'stripe'
  };
}

export const invoiceTenantId = inv => inv?.subscription_details?.metadata?.tenantId || inv?.parent?.subscription_details?.metadata?.tenantId || inv?.metadata?.tenantId || '';

// What the subscription costs per month, for the operator's revenue figures (annual prices are divided by 12).
export function monthlyFromSubscription(sub) {
  let total = 0;
  for (const it of sub?.items?.data || []) {
    const per = it?.price?.recurring?.interval === 'year' ? 12 : 1;
    total += ((Number(it?.price?.unit_amount) || 0) * (Number(it?.quantity) || 0)) / per;
  }
  return Math.round(total) / 100;
}

export const billingSummary = (t, env = process.env) => ({
  enabled: billingConfigured(env), mode: billingConfigured(env) ? stripeMode(env) : null,
  subscribed: !!t?.stripeSubscriptionId && ['active', 'trialing', 'past_due'].includes(t?.stripeStatus),
  status: t?.stripeStatus || '', paidUntil: t?.paidUntil || null, billingIssue: t?.billingIssue === true || t?.billingIssue === 'true',
  cancelAtPeriodEnd: t?.cancelAtPeriodEnd === true || t?.cancelAtPeriodEnd === 'true', hasCustomer: !!t?.stripeCustomerId
});
