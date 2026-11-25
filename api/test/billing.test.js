import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { stripeForm, subscriptionLines, checkoutParams, verifySignature, planFromSubscription, itemsByKind, quantityUpdates, invoiceRow, periodEnd, monthlyFromSubscription, billingConfigured, billingSummary, invoiceTenantId } from '../src/lib/billing.js';
import { estimate } from '../src/lib/plans.js';

const read = p => readFileSync(new URL(p, import.meta.url), 'utf8');

test('form encoding uses bracketed keys for objects and lists', () => {
  assert.equal(decodeURIComponent(stripeForm({ a: { b: [{ c: 1 }, { c: 2 }] }, d: 'x y' })), 'a[b][0][c]=1&a[b][1][c]=2&d=x y');
  assert.equal(stripeForm({ a: undefined, b: null }), '');
});

test('Starter is one flat line; Pro adds per-device; App Control adds a third', () => {
  const s = subscriptionLines({ tier: 'starter', devices: 10 });
  assert.equal(s.lines.length, 1); assert.equal(s.lines[0].price_data.unit_amount, 1900);
  const p = subscriptionLines({ tier: 'pro', devices: 100, appControl: true });
  assert.deepEqual(p.lines.map(l => l.price_data.product_data.metadata.kind), ['license', 'devices', 'appcontrol']);
  assert.deepEqual(p.lines.map(l => l.price_data.unit_amount), [4900, 100, 15]);
  assert.deepEqual(p.lines.map(l => l.quantity), [1, 100, 100]);
});

test('annual: one yearly interval, license discounted, per-device charged for 12 months; totals match the estimator', () => {
  const s = subscriptionLines({ tier: 'pro', billing: 'annual', devices: 100, appControl: true });
  assert.ok(s.lines.every(l => l.price_data.recurring.interval === 'year'));
  assert.deepEqual(s.lines.map(l => l.price_data.unit_amount), [49980, 1200, 180]);   // 49*12*0.85 = 499.80
  const yearly = s.lines.reduce((m, l) => m + l.price_data.unit_amount * l.quantity, 0) / 100;
  assert.equal(Math.round(yearly / 12 * 100) / 100, estimate({ tier: 'pro', devices: 100, billing: 'annual', appControl: true }).monthly);
  const m = subscriptionLines({ tier: 'pro', devices: 100, appControl: true });
  assert.equal(m.lines.reduce((t, l) => t + l.price_data.unit_amount * l.quantity, 0) / 100, estimate({ tier: 'pro', devices: 100, appControl: true }).monthly);
});

test('Starter has no annual option, Enterprise is by quote, zero devices still bills one unit', () => {
  assert.match(subscriptionLines({ tier: 'starter', billing: 'annual' }).error, /monthly only/);
  assert.match(subscriptionLines({ tier: 'enterprise' }).error, /quote/);
  assert.match(subscriptionLines({ tier: 'nope' }).error, /quote|plan/i);
  assert.equal(subscriptionLines({ tier: 'pro', devices: 0 }).lines[1].quantity, 1);
});

test('checkout: subscription mode, the organization is carried in metadata, returns to the Organization page', () => {
  const c = checkoutParams({ tenantId: 't-1', email: 'a@b.co', tier: 'pro', billing: 'monthly', appControl: true, devices: 40, siteUrl: 'https://nexpatchonline.com/' });
  const p = c.params;
  assert.equal(p.mode, 'subscription'); assert.equal(p.client_reference_id, 't-1'); assert.equal(p.customer_email, 'a@b.co');
  assert.deepEqual(p.subscription_data.metadata, { tenantId: 't-1', tier: 'pro', billing: 'monthly', appControl: 'true' });
  assert.equal(p.success_url, 'https://nexpatchonline.com/?billing=success#organization');
  assert.equal(c.monthly, estimate({ tier: 'pro', devices: 40, appControl: true }).monthly);
  const again = checkoutParams({ tenantId: 't-1', customerId: 'cus_1', tier: 'pro', billing: 'monthly', devices: 5, automaticTax: true });
  assert.equal(again.params.customer, 'cus_1'); assert.equal(again.params.customer_email, undefined); assert.equal(again.params.automatic_tax.enabled, 'true');
});

test('webhook signatures: valid, tampered, wrong secret, old and malformed are told apart', () => {
  const body = '{"id":"evt_1"}', secret = 'whsec_test', now = 1_800_000_000_000, t = Math.floor(now / 1000);
  const sig = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  const h = `t=${t},v1=${sig}`;
  assert.equal(verifySignature(body, h, secret, { now }), true);
  assert.equal(verifySignature(body + ' ', h, secret, { now }), false);
  assert.equal(verifySignature(body, h, 'whsec_other', { now }), false);
  assert.equal(verifySignature(body, h, secret, { now: now + 10 * 60 * 1000 }), false);
  assert.equal(verifySignature(body, `t=${t},v1=zz`, secret, { now }), false);
  assert.equal(verifySignature(body, `t=${t},v0=${sig},v1=bad,v1=${sig}`, secret, { now }), true);   // any listed v1 may match
  assert.equal(verifySignature(body, '', secret, { now }), false);
  assert.equal(verifySignature(body, h, '', { now }), false);
});

const sub = (over = {}) => ({ id: 'sub_1', customer: 'cus_1', status: 'active', current_period_end: 1_800_000_000, metadata: { tenantId: 't-1', tier: 'pro', billing: 'annual', appControl: 'true' },
  items: { data: [{ id: 'si_l', quantity: 1, price: { unit_amount: 49980, recurring: { interval: 'year' }, product: { metadata: { kind: 'license' } } } }, { id: 'si_d', quantity: 100, price: { unit_amount: 1200, recurring: { interval: 'year' }, product: { metadata: { kind: 'devices' } } } }] }, ...over });

test('a paid subscription turns the plan on; past due keeps it on but flags it; cancelled ends it', () => {
  const a = planFromSubscription(sub());
  assert.equal(a.plan, 'active'); assert.equal(a.tier, 'pro'); assert.equal(a.billing, 'annual'); assert.equal(a.appControl, true); assert.equal(a.feat_appControl, 'on');
  assert.equal(a.stripeCustomerId, 'cus_1'); assert.equal(a.paidUntil, new Date(1_800_000_000 * 1000).toISOString()); assert.equal(a.billingIssue, false);
  const pd = planFromSubscription(sub({ status: 'past_due' })); assert.equal(pd.plan, 'active'); assert.equal(pd.billingIssue, true);
  assert.equal(planFromSubscription(sub({ status: 'canceled' })).plan, 'expired');
  assert.equal(planFromSubscription(sub({ status: 'incomplete' })).plan, undefined);   // not paid yet: nothing changes
  assert.equal(planFromSubscription(sub({ cancel_at_period_end: true })).cancelAtPeriodEnd, true);
});

test('metadata is not trusted for plans that do not exist', () => {
  const f = planFromSubscription(sub({ metadata: { tenantId: 't-1', tier: 'enterprise' } }));
  assert.equal(f.tier, undefined);
  assert.equal(planFromSubscription(sub({ metadata: { tenantId: 't-1', tier: 'zzz' } })).tier, undefined);
});

test('newer API versions keep the period end on the items', () => {
  const s = sub({ current_period_end: undefined }); s.items.data[0].current_period_end = 1_800_000_500; s.items.data[1].current_period_end = 1_800_000_900;
  assert.equal(periodEnd(s), new Date(1_800_000_500 * 1000).toISOString());
});

test('item ids and the monthly value are read from the expanded subscription', () => {
  const items = itemsByKind(sub());
  assert.deepEqual(items, { license: { id: 'si_l', quantity: 1 }, devices: { id: 'si_d', quantity: 100 } });
  assert.equal(monthlyFromSubscription(sub()), (49980 + 1200 * 100) / 12 / 100);
  assert.deepEqual(itemsByKind({ items: { data: [{ id: 'x', price: { product: 'prod_1' } }] } }), {});   // product not expanded
});

test('device count changes update only the per-device lines, and only when they differ', () => {
  const items = { license: { id: 'a', quantity: 1 }, devices: { id: 'b', quantity: 100 }, appcontrol: { id: 'c', quantity: 90 } };
  assert.deepEqual(quantityUpdates(items, 120), [{ id: 'b', quantity: 120 }, { id: 'c', quantity: 120 }]);
  assert.deepEqual(quantityUpdates(items, 100), [{ id: 'c', quantity: 100 }]);
  assert.deepEqual(quantityUpdates({ license: { id: 'a', quantity: 1 } }, 500), []);
});

test('invoices are stored as money, not cents, with the hosted link', () => {
  const r = invoiceRow({ number: 'AB-0001', status: 'paid', currency: 'usd', amount_due: 0, amount_paid: 14900, total: 14900, hosted_invoice_url: 'https://invoice.stripe.com/i/x', created: 1_800_000_000, customer: 'cus_1' });
  assert.equal(r.total, 149); assert.equal(r.currency, 'USD'); assert.equal(r.provider, 'stripe'); assert.equal(r.customerId, 'cus_1');
  assert.equal(invoiceTenantId({ subscription_details: { metadata: { tenantId: 't-9' } } }), 't-9');
  assert.equal(invoiceTenantId({ parent: { subscription_details: { metadata: { tenantId: 't-8' } } } }), 't-8');
});

test('billing counts as set up only with a Stripe key and a webhook secret', () => {
  assert.equal(billingConfigured({}), false);
  assert.equal(billingConfigured({ STRIPE_SECRET_KEY: 'sk_test_1' }), false);
  assert.equal(billingConfigured({ STRIPE_SECRET_KEY: 'sk_test_1', STRIPE_WEBHOOK_SECRET: 'whsec_1' }), true);
  assert.equal(billingConfigured({ STRIPE_SECRET_KEY: 'pk_live_1', STRIPE_WEBHOOK_SECRET: 'whsec_1' }), false);   // a publishable key is not a secret key
  const s = billingSummary({ stripeSubscriptionId: 'sub_1', stripeStatus: 'active', billingIssue: 'true' }, { STRIPE_SECRET_KEY: 'sk_live_1', STRIPE_WEBHOOK_SECRET: 'w' });
  assert.equal(s.subscribed, true); assert.equal(s.billingIssue, true); assert.equal(s.mode, 'live');
});

test('wiring: the webhook checks the signature before anything else; secrets are never returned or logged', () => {
  const f = read('../src/functions/billing.js');
  assert.match(f, /app\.http\('stripeWebhook'/);
  assert.ok(f.indexOf('verifySignature(raw') < f.indexOf('JSON.parse(raw)'));
  assert.doesNotMatch(f.slice(f.indexOf("app.http('stripeWebhook'"), f.indexOf("app.timer('billingSync'")), /withUser/);   // Stripe has no sign-in
  for (const r of ["'billing/checkout'", "'billing/portal'", "'billing/invoices'", "'platform/billing'"]) assert.ok(f.includes(r), r);
  assert.doesNotMatch(f, /console\.log|context\.(log|warn|error)\([^)]*STRIPE_(SECRET|WEBHOOK)/);
  assert.match(f, /app\.timer\('billingSync'/);
  assert.match(f, /proration_behavior: 'none'/);
});

test('wiring: the organization page reports billing, and the company page and Admin Center use it', () => {
  assert.match(read('../src/functions/org.js'), /billing: billingSummary\(t\)/);
  const page = read('../../public/index.html'), admin = read('../../public/admin/index.html');
  assert.ok(page.includes('/billing/checkout') && page.includes('/billing/portal'));
  assert.ok(admin.includes('/platform/billing'));
});
