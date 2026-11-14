// The public pricing page carries its own copy of the plan table. This keeps it identical to api/src/lib/plans.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TIERS, TRIAL_DAYS, ANNUAL_DISCOUNT, APP_CONTROL_PER_DEVICE, estimate } from '../src/lib/plans.js';

const html = readFileSync(fileURLToPath(new URL('../../public/index.html', import.meta.url)), 'utf8');
const PLANS = JSON.parse(/const PLANS=\/\*plans\*\/(.*?)\/\*end\*\//s.exec(html)[1]);

test('page plan table equals the API plan table', () => {
  assert.equal(PLANS.trialDays, TRIAL_DAYS); assert.equal(PLANS.annualDiscount, ANNUAL_DISCOUNT); assert.equal(PLANS.appControlPerDevice, APP_CONTROL_PER_DEVICE);
  for (const k of ['starter', 'pro', 'proplus']) assert.deepEqual(PLANS.tiers[k], TIERS[k], k);
  assert.deepEqual(Object.keys(PLANS.tiers), ['starter', 'pro', 'proplus']);
});
test('page estimator gives the same totals as the API estimator', () => {
  const src = /function planEstimate[\s\S]*?\n(?=function renderPlanCards)/.exec(html)[0];
  const planEstimate = new Function('PLANS', 'r2', `${src}; return planEstimate;`)(PLANS, n => Math.round(n * 100) / 100);
  for (const tier of ['starter', 'pro', 'proplus']) for (const devices of [1, 25, 100, 300, 500]) for (const billing of ['monthly', 'annual']) for (const ac of [false, true]) {
    const a = estimate({ tier, devices, billing, appControl: ac });
    if (a.error) continue;
    const p = planEstimate(tier, devices, billing, ac);
    assert.equal(p.total, a.monthly, `${tier} ${devices} ${billing} ${ac}`);
  }
});
test('the page offers the 15-day trial and no longer shows the old plans or the 30-day trial', () => {
  assert.ok(html.includes('Try it free for 15 days'));
  assert.ok(!/Starter<\/p><h3[^>]*>\$49/.test(html) && !html.includes('Restart 30-day trial'));
});
