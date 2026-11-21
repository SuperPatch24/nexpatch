import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cleanRule, isDue, selectEligible, groupProblem, runRule, summarize, eligibleAt } from '../src/lib/automation.js';
import { validatePlanRequest, planRequestOf } from '../src/lib/plans.js';

const NOW = Date.parse('2026-11-21T12:00:00Z'), ago = m => new Date(NOW - m * 60000).toISOString();
const G = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`.replace('00000000-0000-0000-0000-0', 'aaaaaaaa-bbbb-cccc-dddd-0');
const dev = (n, minutesAgo, extra = {}) => ({ id: 'm' + n, deviceName: 'PC' + n, azureADDeviceId: G(n), enrolledDateTime: ago(minutesAgo), operatingSystem: 'Windows', managedDeviceOwnerType: 'company', ...extra });
const rule = (x = {}) => ({ delayMinutes: 120, intervalMinutes: 15, scope: 'all', os: 'all', ownership: 'all', groupId: 'g1', createdAt: ago(10000), ...x });

test('a device is picked up only after the delay has passed', () => {
  const r = selectEligible([dev(1, 119), dev(2, 121), dev(3, 120)], rule(), new Set(), NOW);
  assert.deepEqual(r.map(d => d.id), ['m2', 'm3']);   // oldest enrollment first
  assert.equal(eligibleAt(ago(30), rule()), new Date(NOW + 90 * 60000).toISOString());
});
test('"new devices only" ignores devices enrolled before the rule was created; "all" does not', () => {
  const ds = [dev(1, 500), dev(2, 200)];
  assert.deepEqual(selectEligible(ds, rule({ scope: 'new', createdAt: ago(300) }), new Set(), NOW).map(d => d.id), ['m2']);
  assert.equal(selectEligible(ds, rule({ scope: 'all' }), new Set(), NOW).length, 2);
});
test('already-handled devices, unregistered devices and wrong OS or ownership are skipped', () => {
  const ds = [dev(1, 500), dev(2, 500, { azureADDeviceId: '00000000-0000-0000-0000-000000000000' }), dev(3, 500, { operatingSystem: 'iOS' }), dev(4, 500, { managedDeviceOwnerType: 'personal' }), dev(5, 500, { enrolledDateTime: '' })];
  assert.deepEqual(selectEligible(ds, rule(), new Set(['m1']), NOW).map(d => d.id), ['m3', 'm4']);
  assert.deepEqual(selectEligible(ds, rule({ os: 'Windows', ownership: 'company' }), new Set(), NOW).map(d => d.id), ['m1']);
  assert.deepEqual(selectEligible(ds, rule({ os: 'iOS' }), new Set(), NOW).map(d => d.id), ['m3']);
});
test('a rule runs every 15 minutes when asked to, and not before its interval', () => {
  assert.equal(isDue({ enabled: true, intervalMinutes: 15 }, NOW), true);
  assert.equal(isDue({ enabled: true, intervalMinutes: 15, lastRunAt: ago(15) }, NOW), true);
  assert.equal(isDue({ enabled: true, intervalMinutes: 15, lastRunAt: ago(14.9) }, NOW), true, 'timer jitter allowed');
  assert.equal(isDue({ enabled: true, intervalMinutes: 60, lastRunAt: ago(45) }, NOW), false);
  assert.equal(isDue({ enabled: false, intervalMinutes: 15 }, NOW), false);
  assert.equal(isDue({ enabled: true, intervalMinutes: 15, lockUntil: new Date(NOW + 60000).toISOString() }, NOW), false);
});
test('rule fields are validated', () => {
  assert.ok(cleanRule({ name: '', delayMinutes: 5, intervalMinutes: 15 }).error);
  assert.ok(cleanRule({ name: 'x', delayMinutes: -1, intervalMinutes: 15 }).error);
  assert.ok(cleanRule({ name: 'x', delayMinutes: 5, intervalMinutes: 7 }).error);
  assert.ok(cleanRule({ name: 'x', delayMinutes: 5, intervalMinutes: 15, os: 'Plan9' }).error);
  const ok = cleanRule({ name: ' Pilot ', delayMinutes: 120, intervalMinutes: 15 }).fields;
  assert.deepEqual([ok.name, ok.delayMinutes, ok.os, ok.scope, ok.enabled], ['Pilot', 120, 'all', 'new', true]);
  assert.equal(cleanRule({ enabled: false }, { partial: true }).fields.enabled, false);
});
test('only assigned security groups can be used', () => {
  assert.equal(groupProblem({ id: 'g', securityEnabled: true, groupTypes: [] }), '');
  assert.match(groupProblem({ id: 'g', securityEnabled: true, groupTypes: ['DynamicMembership'] }), /dynamic/i);
  assert.match(groupProblem({ id: 'g', securityEnabled: false, groupTypes: ['Unified'] }), /security group/i);
  assert.match(groupProblem({ id: 'g', securityEnabled: true, groupTypes: [], onPremisesSyncEnabled: true }), /on-premises/i);
  assert.match(groupProblem({ id: 'g', securityEnabled: true, groupTypes: [], isAssignableToRole: true }), /roles/i);
  assert.match(groupProblem(null), /wasn.t found/);
});

// A tiny fake Microsoft Graph
function fake({ devices, members = [], group = { id: 'g1', displayName: 'Pilot', securityEnabled: true, groupTypes: [] }, missing = [], failBatch = false }) {
  const calls = [];
  const graph = async (path, init = {}) => {
    calls.push([init.method || 'GET', path, init.body]);
    if (path.startsWith('/v1.0/$batch')) return { responses: JSON.parse(init.body).requests.map(q => { const aad = /'([^']+)'/.exec(q.url)[1]; return { id: q.id, status: 200, body: { value: missing.includes(aad) ? [] : [{ id: 'obj-' + aad }] } }; }) };
    if (init.method === 'PATCH') { if (failBatch) { const e = new Error('Microsoft Graph returned an error (400)'); e.status = 502; throw e; } return null; }
    if (path.includes('/members/$ref')) return null;
    if (path.startsWith('/v1.0/groups/g1?')) return group;
    throw new Error('unexpected ' + path);
  };
  const graphAll = async p => (p.includes('managedDevices') ? devices : members.map(id => ({ id })));
  return { graph, graphAll, calls };
}

test('the runner adds eligible devices, skips members, and leaves unregistered ones for next time', async () => {
  const ds = [dev(1, 300), dev(2, 300), dev(3, 300), dev(4, 30)];
  const f = fake({ devices: ds, members: ['obj-' + G(2)], missing: [G(3)] });
  const res = await runRule(f, rule(), new Set(), { now: NOW });
  assert.deepEqual(res.added.map(d => d.id), ['m1']);
  assert.deepEqual(res.skippedMember.map(d => d.id), ['m2']);
  assert.equal(res.notInEntra, 1);
  assert.equal(summarize(res), 'Added 1 device, 1 already in the group, 1 not in Entra yet.');
  const patch = f.calls.find(c => c[0] === 'PATCH');
  assert.match(patch[2], /directoryObjects\/obj-/);
});
test('preview changes nothing', async () => {
  const f = fake({ devices: [dev(1, 300)] });
  const res = await runRule(f, rule(), new Set(), { now: NOW, dryRun: true });
  assert.equal(res.wouldAdd.length, 1); assert.equal(res.added.length, 0);
  assert.equal(f.calls.some(c => c[0] === 'PATCH'), false);
});
test('a failed batch falls back to one device at a time; a dynamic group stops the run', async () => {
  const f = fake({ devices: [dev(1, 300), dev(2, 300)], failBatch: true });
  const res = await runRule(f, rule(), new Set(), { now: NOW });
  assert.equal(res.added.length, 2);
  assert.equal(f.calls.filter(c => c[1].includes('/members/$ref')).length, 2);
  await assert.rejects(runRule(fake({ devices: [dev(1, 300)], group: { id: 'g1', securityEnabled: true, groupTypes: ['DynamicMembership'] } }), rule(), new Set(), { now: NOW }), /dynamic/i);
});
test('nothing is added in one run beyond the cap, and the rest is reported', async () => {
  const ds = Array.from({ length: 230 }, (_, i) => dev(i + 1, 300));
  const res = await runRule(fake({ devices: ds }), rule(), new Set(), { now: NOW });
  assert.equal(res.added.length, 200); assert.equal(res.remaining, 30);
});

test('plan change requests: allowed plans, device fit, annual only where offered', () => {
  assert.ok(validatePlanRequest({ tier: 'nope' }).error);
  assert.match(validatePlanRequest({ tier: 'starter', billing: 'annual' }).error, /monthly only/);
  assert.match(validatePlanRequest({ tier: 'starter' }, { devices: 80 }).error, /larger plan/);
  assert.ok(validatePlanRequest({ tier: 'pro', billing: 'annual', appControl: true }, { devices: 80 }).request);
  assert.match(validatePlanRequest({ tier: 'pro' }, { devices: 5, current: { plan: 'active', tier: 'pro', billing: 'monthly' } }).error, /already/);
  assert.ok(validatePlanRequest({ tier: 'enterprise' }, { devices: 9999 }).request);
  assert.equal(planRequestOf({ reqTier: 'pro', reqBilling: 'annual' }).tierLabel, 'Pro');
  assert.equal(planRequestOf({}), null);
});

test('functions are wired: tables, feature switch, timer, role checks', () => {
  const fn = readFileSync(new URL('../src/functions/automation.js', import.meta.url), 'utf8');
  assert.match(fn, /app\.timer\('automationTick'/);
  assert.equal((fn.match(/'admin'\) \}\);/g) || []).length, 4, 'create, update, delete and run need the admin role (history and list are viewer)');
  assert.match(readFileSync(new URL('../src/lib/store.js', import.meta.url), 'utf8'), /'AutomationRules', 'AutomationDone'/);
  assert.match(readFileSync(new URL('../src/lib/tenantsettings.js', import.meta.url), 'utf8'), /automation: 'Automation'/);
});
