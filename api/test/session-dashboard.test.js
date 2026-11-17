import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanPlatformPolicy, cleanTenantPolicy, effectivePolicy, evaluate, mfaClaims, cleanCountry } from '../src/lib/sessionpolicy.js';
import { buildDashboard, summarizeBlobs } from '../src/lib/dashboard.js';
import { cleanTheme, cleanIcon, iconUrl } from '../src/lib/appearance.js';

const H = 3600e3, NOW = Date.parse('2026-11-16T12:00:00Z');

test('organization overrides win over the platform default; blank inherits', () => {
  const platform = { maxHours: 12, idleMinutes: 60, requireMfa: true, authContext: 'c2' };
  assert.deepEqual(effectivePolicy({}, platform).maxHours, 12);
  const p = effectivePolicy({ sessionMaxHours: 4, sessionIdleMinutes: '', mfaMode: 'off' }, platform);
  assert.equal(p.maxHours, 4); assert.equal(p.idleMinutes, 60); assert.equal(p.requireMfa, false); assert.equal(p.authContext, 'c2');
  assert.equal(effectivePolicy({ mfaMode: 'required' }, { requireMfa: false }).requireMfa, true);
  assert.equal(effectivePolicy({ sessionMaxHours: 0 }, platform).maxHours, 0, '0 means no limit for this organization');
});

test('validation rejects out-of-range values and bad auth context IDs', () => {
  assert.throws(() => cleanTenantPolicy({ sessionMaxHours: 9999 }));
  assert.throws(() => cleanTenantPolicy({ sessionIdleMinutes: 1.5 }));
  assert.equal(cleanTenantPolicy({ mfaMode: 'bogus' }).mfaMode, 'default');
  assert.throws(() => cleanPlatformPolicy({ authContext: 'x1' }));
  assert.deepEqual(cleanPlatformPolicy({ maxHours: '8', idleMinutes: 30, requireMfa: true, authContext: 'C3' }), { maxHours: 8, idleMinutes: 30, requireMfa: true, authContext: 'c3' });
});

test('sessions expire by sign-in age and by inactivity; MFA needs the auth context', () => {
  const policy = { maxHours: 8, idleMinutes: 30, requireMfa: false, authContext: 'c1' };
  const signedIn = (NOW - 2 * H) / 1000;
  assert.equal(evaluate(policy, { authTime: signedIn, acrs: [] }, { lastSeen: NOW - 5 * 60e3 }, NOW), null);
  assert.equal(evaluate(policy, { authTime: (NOW - 9 * H) / 1000, acrs: [] }, null, NOW).code, 'session_expired');
  assert.equal(evaluate(policy, { authTime: signedIn, acrs: [] }, { lastSeen: NOW - 31 * 60e3 }, NOW).code, 'session_idle');
  const mfa = { ...policy, requireMfa: true };
  assert.equal(evaluate(mfa, { authTime: signedIn, acrs: [] }, null, NOW).code, 'mfa_required');
  assert.equal(evaluate(mfa, { authTime: signedIn, acrs: ['c1'] }, null, NOW), null);
  assert.deepEqual(JSON.parse(mfaClaims('c1')), { access_token: { acrs: { essential: true, value: 'c1' } } });
  assert.equal(evaluate({ maxHours: 8, idleMinutes: 0, requireMfa: false }, { authTime: null, acrs: [] }, null, NOW), null, 'no auth_time: not enforceable, never blocks');
});

test('country codes are sanitized', () => {
  assert.equal(cleanCountry('ca'), 'CA'); assert.equal(cleanCountry('XX'), ''); assert.equal(cleanCountry('<script>'), ''); assert.equal(cleanCountry(''), '');
});

test('dashboard aggregates sign-ins, activity, packages, installs and storage', () => {
  const day = (n) => new Date(NOW - n * 864e5).toISOString();
  const tenants = [{ rowKey: 't1', label: 'Contoso', plan: 'active', lastSyncAt: day(1) }, { rowKey: 't2', plan: 'trial' }];
  const perTenant = {
    t1: { members: [{ kind: 'member' }, { kind: 'invite' }], inventory: [{ deviceCount: 40 }, { deviceCount: 12 }],
      publishJobs: [{ status: 'succeeded', createdAt: day(0) }, { status: 'failed', createdAt: day(2) }],
      packagingJobs: [{ status: 'test-passed', createdAt: day(0) }, { status: 'scan-failed', createdAt: day(1) }, { status: 'upload-pending', createdAt: day(1) }],
      installReports: [{ app: '7-Zip', installed: 30, failed: 2, pending: 1 }], appRequests: [{ createdAt: day(3) }] },
    t2: {}
  };
  const signIns = [
    { tenantId: 't1', userId: 'a', country: 'CA', mfa: true, authTime: 1, at: day(0) },
    { tenantId: 't1', userId: 'a', country: 'CA', mfa: true, authTime: 1, at: day(0) },
    { tenantId: 't1', userId: 'b', country: 'US', mfa: false, authTime: '', at: day(1) },
    { tenantId: 't1', userId: 'c', country: '', at: day(45) }
  ];
  const storage = summarizeBlobs([{ name: 'c1', blobs: [{ name: '11111111-2222-3333-4444-555555555555/x.msi', size: 100 }, { name: 'shared.txt', size: 5 }] }]);
  const d = buildDashboard({ tenants, perTenant, signIns, usage: [{ day: day(0).slice(0, 10), tenantId: 't1', requests: 7 }], storage, days: 30, now: NOW });
  assert.equal(d.totals.signIns, 3, 'only sign-ins inside the window');
  assert.deepEqual(d.countries, [{ name: 'CA', value: 2 }, { name: 'US', value: 1 }]);
  assert.equal(d.daily.activeUsers.at(-1).value, 1, 'same user twice counts once');
  assert.equal(d.daily.requests.at(-1).value, 7);
  assert.equal(d.totals.packages, 2); assert.equal(d.totals.packagesSucceeded, 1); assert.equal(d.totals.packagesFailed, 1);
  assert.equal(d.totals.publishes, 2); assert.equal(d.totals.publishFailed, 1);
  assert.equal(d.totals.installs, 30); assert.equal(d.totals.installFailures, 2); assert.equal(d.totals.devices, 40); assert.equal(d.totals.members, 1);
  assert.equal(d.totals.activeOrganizations, 1); assert.deepEqual(d.plans, { active: 1, trial: 1 });
  assert.equal(d.totals.storageBytes, 105); assert.equal(storage.byTenant['11111111-2222-3333-4444-555555555555'], 100);
  assert.equal(d.warnings.length, 1, 'warns when auth_time is missing');
  assert.equal(d.daily.signIns.length, 30);
});

test('themes and icons accept only known values', () => {
  assert.equal(cleanTheme('ocean'), 'ocean'); assert.equal(cleanTheme('neon'), '');
  assert.equal(cleanIcon('../../etc'), 'classic'); assert.equal(iconUrl('shield'), '/icons/shield.svg'); assert.equal(iconUrl(''), '/favicon.svg');
});
