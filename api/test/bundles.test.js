import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BUNDLES, clientIdFor, hasOwnApp, decodeRoles, missingRoles, wantsAppControl, bundleStatus } from '../src/lib/bundles.js';

const jwt = roles => 'x.' + Buffer.from(JSON.stringify({ roles })).toString('base64url') + '.y';

test('App Control and Automation permissions are not part of the core approval', () => {
  const core = BUNDLES.core.roles;
  for (const r of ['ThreatHunting.Read.All', 'DeviceManagementConfiguration.ReadWrite.All', 'GroupMember.ReadWrite.All', 'Device.Read.All', 'Group.Create']) assert.equal(core.includes(r), false, r);
  assert.ok(BUNDLES.appcontrol.roles.includes('ThreatHunting.Read.All'));
  assert.ok(BUNDLES.automation.roles.includes('GroupMember.ReadWrite.All'));
  assert.equal(BUNDLES.core.optional, false); assert.equal(BUNDLES.appcontrol.optional, true);
});
test('each add-on uses its own app registration, and falls back to the core app when none is set', () => {
  const env = { CLIENT_ID: 'core-id', CLIENT_ID_APPCONTROL: 'ac-id' };
  assert.equal(clientIdFor('core', env), 'core-id');
  assert.equal(clientIdFor('appcontrol', env), 'ac-id');
  assert.equal(clientIdFor('automation', env), 'core-id');
  assert.equal(hasOwnApp('appcontrol', env), true); assert.equal(hasOwnApp('automation', env), false);
});
test('approved permissions are read from the token roles', () => {
  assert.deepEqual(decodeRoles(jwt(['A.Read', 'B.Write'])), ['A.Read', 'B.Write']);
  assert.deepEqual(decodeRoles('garbage'), []);
  assert.deepEqual(missingRoles(['A', 'B', 'C'], ['B']), ['A', 'C']);
});
test('status: a bundle counts as approved only when every required permission is granted', () => {
  const t = { plan: 'active', appControl: false };
  const some = bundleStatus('appcontrol', ['ThreatHunting.Read.All'], t, { CLIENT_ID: 'c' });
  assert.equal(some.consented, false); assert.deepEqual(some.missing.sort(), ['DeviceManagementConfiguration.ReadWrite.All', 'Group.Read.All']);
  const all = bundleStatus('appcontrol', BUNDLES.appcontrol.roles, t, { CLIENT_ID: 'c' });
  assert.equal(all.consented, true);
  const auto = bundleStatus('automation', BUNDLES.automation.roles, t, { CLIENT_ID: 'c' });
  assert.deepEqual(auto.optionalMissing, ['Group.Create']); assert.equal(auto.consented, true);
});
test('App Control is "needed" only when the plan, a trial interest or a plan request includes it', () => {
  assert.equal(wantsAppControl({ plan: 'active', appControl: true }), true);
  assert.equal(wantsAppControl({ plan: 'active', appControl: false }), false);
  assert.equal(wantsAppControl({ plan: 'trial', interestAppControl: true }), true);
  assert.equal(wantsAppControl({ plan: 'active', reqAppControl: true }), true);
  assert.equal(wantsAppControl({ plan: 'active', interestAppControl: true }), false, 'interest only counts during a trial');
  assert.equal(wantsAppControl(null), false);
  assert.equal(bundleStatus('appcontrol', [], { plan: 'active', appControl: true }, {}).needed, true);
  assert.equal(bundleStatus('core', [], {}, {}).needed, true);
});
test('wiring: App Control and Automation sign in with their own bundle; the Connect page shows add-ons', () => {
  const r = f => readFileSync(new URL(f, import.meta.url), 'utf8');
  for (const f of ['../src/lib/acdeploy.js', '../src/lib/appcontrol.js', '../src/functions/appcontrol.js']) assert.match(r(f), /graphAs\('appcontrol'\)/, f);
  assert.match(r('../src/functions/automation.js'), /graphAs\('automation'\)/);
  assert.match(r('../src/lib/graph.js'), /export const graphAs/);
  const html = readFileSync(new URL('../../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="addonPanel"/); assert.match(html, /\/tenant\/permissions/); assert.match(html, /nexpatch-consent-bundle/);
});
