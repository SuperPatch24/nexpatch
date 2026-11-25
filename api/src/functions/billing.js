import { app } from '@azure/functions';
import { withUser, HttpError, readJson, json } from '../lib/http.js';
import { getTenant, saveTenant, listRows, listAllTenants, putRow, audit } from '../lib/store.js';
import { validatePlanRequest, CLEAR_PLAN_REQUEST } from '../lib/plans.js';
import { billingConfigured, billingSummary, stripeMode, stripeForm, STRIPE_API_VERSION, checkoutParams, verifySignature, planFromSubscription, itemsByKind, quantityUpdates, invoiceRow, invoiceTenantId, monthlyFromSubscription } from '../lib/billing.js';
import { platformRole } from '../lib/platform.js';

const SITE = () => String(process.env.PUBLIC_APP_URL || process.env.WEBSITE_URL || 'https://nexpatchonline.com').replace(/\/$/, '');
const iso = () => new Date().toISOString();

// One call to the Stripe API. The secret key never leaves this function and is never put in an error message.
async function stripe(path, { method = 'POST', params } = {}) {
  if (!billingConfigured()) throw new HttpError(503, 'Online payment isn’t set up yet. Contact NexpatchOnline to arrange your plan.');
  const body = params ? stripeForm(params) : '';
  const url = 'https://api.stripe.com/v1' + path + (method === 'GET' && body ? (path.includes('?') ? '&' : '?') + body : '');
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`, 'Stripe-Version': STRIPE_API_VERSION, ...(method !== 'GET' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
    body: method === 'GET' ? undefined : body
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new HttpError(res.status >= 500 ? 502 : 400, String(data?.error?.message || 'The payment provider refused the request.').slice(0, 240)); e.stripeCode = data?.error?.code; throw e; }
  return data;
}

const devicesOf = async tid => (await listRows('Inventory', tid, 20000)).reduce((m, x) => Math.max(m, Number(x.deviceCount) || 0), 0);

// ---- Company side -------------------------------------------------------------------------------------------------

// Pay for a plan: returns a Stripe Checkout address the browser opens.
app.http('billingCheckout', { methods: ['POST'], authLevel: 'anonymous', route: 'billing/checkout',
  handler: withUser(async (req, _c, user) => {
    const t = await getTenant(user.tenantId);
    if (!t) throw new HttpError(404, 'Your organization isn’t connected yet.');
    if (!billingConfigured()) throw new HttpError(503, 'Online payment isn’t set up yet. Send a plan request and NexpatchOnline will arrange it.');
    if (t.stripeSubscriptionId && ['active', 'trialing', 'past_due'].includes(t.stripeStatus)) throw new HttpError(409, 'You already have a subscription. Use Manage billing for payment details and invoices, or send a plan change request.');
    const devices = await devicesOf(user.tenantId);
    const b = await readJson(req);
    const v = validatePlanRequest(b, { devices, current: {} });
    if (v.error) throw new HttpError(400, v.error);
    const r = v.request;
    const c = checkoutParams({ tenantId: user.tenantId, email: user.email, customerId: t.stripeCustomerId || '', tier: r.tier, billing: r.billing, appControl: r.appControl, devices, siteUrl: SITE(), automaticTax: process.env.STRIPE_AUTOMATIC_TAX === 'true' });
    if (c.error) throw new HttpError(400, c.error);
    const session = await stripe('/checkout/sessions', { params: c.params });
    await audit(user.tenantId, user.email || user.userId, 'started checkout', `${r.tier}, ${r.billing}${r.appControl ? ', with App Control' : ''}`);
    return { url: session.url };
  }, 'admin') });

// Stripe's own page for payment method, invoices and cancelling.
app.http('billingPortal', { methods: ['POST'], authLevel: 'anonymous', route: 'billing/portal',
  handler: withUser(async (_req, _c, user) => {
    const t = await getTenant(user.tenantId);
    if (!t?.stripeCustomerId) throw new HttpError(404, 'There is no online subscription to manage yet.');
    const s = await stripe('/billing_portal/sessions', { params: { customer: t.stripeCustomerId, return_url: `${SITE()}/#organization` } });
    return { url: s.url };
  }, 'admin') });

app.http('billingInvoices', { methods: ['GET'], authLevel: 'anonymous', route: 'billing/invoices',
  handler: withUser(async (_r, _c, user) => {
    const rows = await listRows('Invoices', user.tenantId, 200);
    return { invoices: rows.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).map(r => ({ id: r.rowKey, number: r.number, status: r.status, total: r.total, currency: r.currency, createdAt: r.createdAt, hostedUrl: r.hostedUrl })) };
  }, 'admin') });

// ---- Stripe tells us what happened ----------------------------------------------------------------------------------

async function applySubscription(sub, context, { fresh = false } = {}) {
  const tid = sub?.metadata?.tenantId;
  if (!tid) { context.log(`Billing: subscription ${sub?.id} has no tenantId; ignored`); return; }
  const t = await getTenant(tid);
  if (!t) { context.warn(`Billing: organization ${tid} not found`); return; }
  const f = planFromSubscription(sub, t);
  const items = itemsByKind(sub);
  if (Object.keys(items).length) { f.stripeItems = JSON.stringify(items); f.stripeMonthly = monthlyFromSubscription(sub); }   // only when the lines were included
  if (f.plan === 'active') Object.assign(f, CLEAR_PLAN_REQUEST);
  await saveTenant(tid, f);
  const was = t.stripeStatus || '';
  if (fresh || was !== f.stripeStatus) await audit(tid, 'Stripe', fresh ? 'subscription started' : 'subscription changed', `${f.tier || ''} ${f.stripeStatus}${f.billingIssue ? ' (payment issue)' : ''}`.trim());
}

async function recordInvoice(inv, context) {
  let tid = invoiceTenantId(inv);
  if (!tid) { const cid = typeof inv.customer === 'string' ? inv.customer : inv.customer?.id; if (cid) tid = (await listAllTenants()).find(x => x.stripeCustomerId === cid)?.rowKey || ''; }
  if (!tid) { context.log(`Billing: invoice ${inv.id} has no organization; ignored`); return; }
  await putRow('Invoices', tid, inv.id, invoiceRow(inv));
}

app.http('stripeWebhook', { methods: ['POST'], authLevel: 'anonymous', route: 'stripe/webhook',
  handler: async (req, context) => {
    const raw = await req.text();
    if (!verifySignature(raw, req.headers.get('stripe-signature'), process.env.STRIPE_WEBHOOK_SECRET)) return json(400, { error: 'Bad signature.' });
    let ev; try { ev = JSON.parse(raw); } catch { return json(400, { error: 'Bad body.' }); }
    try {
      const o = ev?.data?.object || {};
      if (ev.type === 'checkout.session.completed') {
        if (o.mode === 'subscription' && o.subscription) {
          const sub = await stripe(`/subscriptions/${encodeURIComponent(o.subscription)}`, { method: 'GET', params: { expand: ['items.data.price.product'] } });
          await applySubscription(sub, context, { fresh: true });
        }
      } else if (ev.type?.startsWith('customer.subscription.')) {
        const sub = ev.type === 'customer.subscription.deleted' ? { ...o, status: 'canceled' } : await stripe(`/subscriptions/${encodeURIComponent(o.id)}`, { method: 'GET', params: { expand: ['items.data.price.product'] } }).catch(() => o);
        await applySubscription(sub, context);
      } else if (['invoice.paid', 'invoice.payment_failed', 'invoice.finalized', 'invoice.voided', 'invoice.marked_uncollectible'].includes(ev.type)) {
        await recordInvoice(o, context);
      }
      return json(200, { received: true });
    } catch (e) {
      context.error('Stripe webhook failed', ev?.type, e?.message);
      return json(500, { error: 'Could not process the event.' });   // Stripe tries again later
    }
  } });

// Keep the per-device lines equal to the devices an organization really has. No proration: the new count is billed from the next invoice.
app.timer('billingSync', { schedule: '0 30 6 * * *',
  handler: async (_t, context) => {
    if (!billingConfigured()) return;
    for (const t of await listAllTenants()) {
      if (!t.stripeSubscriptionId || !['active', 'trialing'].includes(t.stripeStatus)) continue;
      try {
        const items = JSON.parse(t.stripeItems || '{}');
        const devices = await devicesOf(t.rowKey);
        if (!devices) continue;
        const ups = quantityUpdates(items, devices);
        for (const u of ups) await stripe(`/subscription_items/${encodeURIComponent(u.id)}`, { params: { quantity: u.quantity, proration_behavior: 'none' } });
        if (ups.length) {
          for (const k of Object.keys(items)) if (k !== 'license') items[k].quantity = Math.max(1, devices);
          await saveTenant(t.rowKey, { stripeItems: JSON.stringify(items) });
          await audit(t.rowKey, 'NexpatchOnline billing', 'device count updated', `${Math.max(1, devices)} devices`);
        }
      } catch (e) { context.warn(`Billing sync ${t.rowKey}: ${e.message}`); }
    }
  } });

// ---- Operator side ------------------------------------------------------------------------------------------------

app.http('platformBilling', { methods: ['GET'], authLevel: 'anonymous', route: 'platform/billing',
  handler: withUser(async (_r, _c, user) => {
    const role = platformRole(user);
    if (!role || !['superadmin', 'support'].includes(role)) throw new HttpError(403, 'Your platform administrator role does not allow this action.');
    const tenants = await listAllTenants();
    const subs = tenants.filter(t => t.stripeSubscriptionId);
    const live = subs.filter(t => ['active', 'trialing', 'past_due'].includes(t.stripeStatus));
    const mrr = Math.round(live.reduce((m, t) => m + (Number(t.stripeMonthly) || 0), 0) * 100) / 100;
    const invoices = [];
    for (const t of subs) for (const r of await listRows('Invoices', t.rowKey, 100)) invoices.push({ id: r.rowKey, tenantId: t.rowKey, number: r.number, status: r.status, total: r.total, currency: r.currency, createdAt: r.createdAt, periodStart: r.periodStart, periodEnd: r.periodEnd, dueAt: r.dueAt, hostedUrl: r.hostedUrl, provider: 'Stripe' });
    invoices.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    const count = s => invoices.filter(i => i.status === s).length;
    return {
      provider: { name: 'Stripe', connected: billingConfigured(), mode: billingConfigured() ? stripeMode() : null, automaticTax: process.env.STRIPE_AUTOMATIC_TAX === 'true' },
      activeSubscriptions: live.length, pastDue: subs.filter(t => t.stripeStatus === 'past_due' || t.stripeStatus === 'unpaid').length, canceling: live.filter(t => t.cancelAtPeriodEnd === true || t.cancelAtPeriodEnd === 'true').length,
      mrr, arr: Math.round(mrr * 12 * 100) / 100,
      invoiceCounts: { draft: count('draft'), open: count('open'), paid: count('paid'), uncollectible: count('uncollectible'), void: count('void') },
      outstanding: Math.round(invoices.filter(i => i.status === 'open').reduce((m, i) => m + (Number(i.total) || 0), 0) * 100) / 100,
      collected: Math.round(invoices.filter(i => i.status === 'paid').reduce((m, i) => m + (Number(i.total) || 0), 0) * 100) / 100,
      subscriptions: subs.map(t => ({ tenantId: t.rowKey, tier: t.tier || '', billing: t.billing || '', status: t.stripeStatus || '', monthly: Number(t.stripeMonthly) || 0, paidUntil: t.paidUntil || null, cancelAtPeriodEnd: t.cancelAtPeriodEnd === true || t.cancelAtPeriodEnd === 'true' })),
      invoices: invoices.slice(0, 200)
    };
  }, 'any') });
