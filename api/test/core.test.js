import test from 'node:test';
import assert from 'node:assert/strict';
import { planStatus, trialFields, TRIAL_DAYS } from '../src/lib/plan.js';
import { compareVersions } from '../src/lib/winget.js';
import { buildBasePolicy } from '../src/lib/basepolicy.js';

test('planStatus rejects a missing tenant', () => {
  assert.deepEqual(planStatus(null), {
    plan: 'none', active: false, daysLeft: 0, trialEndsAt: null
  });
});

test('planStatus treats an active subscription as active', () => {
  assert.equal(planStatus({ plan: 'active' }).active, true);
});

test('planStatus treats an explicitly expired plan as inactive', () => {
  assert.equal(planStatus({ plan: 'expired' }).active, false);
});

test('planStatus preserves legacy tenants without trial dates', () => {
  const result = planStatus({ status: 'active' });
  assert.equal(result.plan, 'trial');
  assert.equal(result.active, true);
  assert.equal(result.daysLeft, TRIAL_DAYS);
});

test('trialFields does not reset an existing trial or plan', () => {
  assert.deepEqual(trialFields({ plan: 'trial', trialEndsAt: '2030-01-01T00:00:00.000Z' }), {});
  assert.deepEqual(trialFields({ plan: 'active' }), {});
});

test('trialFields creates a 30-day trial for a new tenant', () => {
  const fields = trialFields(null);
  assert.equal(fields.plan, 'trial');
  assert.ok(Date.parse(fields.trialEndsAt) > Date.now());
  assert.equal(Math.round((Date.parse(fields.trialEndsAt) - Date.parse(fields.trialStartedAt)) / 864e5), TRIAL_DAYS);
});

test('compareVersions compares numeric components rather than lexically', () => {
  assert.ok(compareVersions('1.10.0', '1.9.9') > 0);
  assert.ok(compareVersions('2.0', '10.0') < 0);
  assert.equal(compareVersions('4.2.1', '4.2.1'), 0);
});


test('base policy includes protected administrator path rules', async () => {
  const { xml } = await buildBasePolicy({ base: 'AllowMicrosoft', mode: 'audit', pathRules: ['C:\\Program Files\\Contoso\\*', '%PROGRAMFILES%\\Fabrikam\\*'] });
  assert.match(xml, /FilePathCondition Path="C:\\Program Files\\Contoso\\\*"/);
  assert.match(xml, /FilePathCondition Path="%PROGRAMFILES%\\Fabrikam\\\*"/);
});

test('base policy rejects user-writable path rules', async () => {
  await assert.rejects(() => buildBasePolicy({ pathRules: ['C:\\Users\\Public\\*'] }), /Unsafe path rule/);
  await assert.rejects(() => buildBasePolicy({ pathRules: ['relative\\folder'] }), /Invalid path rule/);
});
