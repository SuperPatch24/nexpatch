import test from 'node:test';
import assert from 'node:assert/strict';
import { TIERS, TRIAL_DAYS, estimate, limitsFor, limitMessage, countThisMonth, monthStart, APP_CONTROL_PER_DEVICE } from '../src/lib/plans.js';
import { planStatus } from '../src/lib/plan.js';

test('the free trial is 15 days', () => {
  assert.equal(TRIAL_DAYS, 15);
  const t = { plan: 'trial', trialEndsAt: new Date(Date.now() + 15 * 864e5 - 1000).toISOString() };
  assert.equal(planStatus(t).daysLeft, 15);
});
test('Starter is flat, monthly only and capped at 25 devices; no per-device charge', () => {
  const e = estimate({ tier: 'starter', devices: 20 });
  assert.equal(e.monthly, 29); assert.equal(e.usage, 0); assert.equal(e.overLimit, false);
  assert.ok(estimate({ tier: 'starter', devices: 20, billing: 'annual' }).error);
  assert.equal(estimate({ tier: 'starter', devices: 40 }).suggest, 'pro');
});
test('Pro and Pro Plus: platform license plus per-device usage; annual discounts the license only', () => {
  assert.equal(estimate({ tier: 'pro', devices: 100 }).monthly, 99 + 100 * 3);
  const a = estimate({ tier: 'pro', devices: 100, billing: 'annual' });
  assert.equal(a.platform, 84.15); assert.equal(a.usage, 300); assert.equal(a.annualLicenseTotal, 1009.8);
  assert.equal(estimate({ tier: 'proplus', devices: 300 }).monthly, 249 + 300 * 2.75);
  assert.equal(estimate({ tier: 'pro', devices: 150 }).suggest, 'proplus');
  assert.equal(estimate({ tier: 'proplus', devices: 400 }).suggest, 'enterprise');
});
test('App Control adds a small per-device price', () => {
  const e = estimate({ tier: 'pro', devices: 100, appControl: true });
  assert.equal(e.appControl, 100 * APP_CONTROL_PER_DEVICE); assert.equal(e.monthly, 99 + 300 + 40);
});
test('Enterprise is a quote, and unknown plans are rejected', () => {
  assert.equal(estimate({ tier: 'enterprise', devices: 5 }).contact, true);
  assert.ok(estimate({ tier: 'gold' }).error);
});
test('limits: trials get Pro limits, paid follow their tier, old paid orgs and Enterprise are unlimited, expired fall back to Starter', () => {
  assert.equal(limitsFor({ plan: 'trial', trialEndsAt: 'x' }).customApps, TIERS.pro.customApps);
  assert.equal(limitsFor({ plan: 'active', tier: 'proplus' }).packageRequests, TIERS.proplus.packageRequests);
  assert.equal(limitsFor({ plan: 'active' }).customApps, Infinity);
  assert.equal(limitsFor({ plan: 'active', tier: 'enterprise' }).devices, Infinity);
  assert.equal(limitsFor({ plan: 'expired' }).customApps, TIERS.starter.customApps);
});
test('monthly limit messages and counting', () => {
  const lim = limitsFor({ plan: 'active', tier: 'starter' });
  assert.equal(limitMessage('customApps', lim, 1), '');
  assert.match(limitMessage('customApps', lim, 2), /2 custom app builds per month/);
  assert.equal(limitMessage('customApps', limitsFor({ plan: 'active' }), 999), '');
  const now = new Date('2026-11-15T10:00:00Z');
  assert.equal(monthStart(now), '2026-11-01T00:00:00.000Z');
  assert.equal(countThisMonth([{ createdAt: '2026-10-31T23:59:59Z' }, { createdAt: '2026-11-02T00:00:00Z' }, {}], 'createdAt', now), 1);
});
