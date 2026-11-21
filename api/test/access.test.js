import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FEATURES, PRODUCT_FEATURES, featureFields, featureMap, featureOn } from '../src/lib/tenantsettings.js';

const read = f => readFileSync(new URL(f, import.meta.url), 'utf8');

test('Apps and patching, App Control and Automation can each be granted or revoked', () => {
  for (const k of ['apps', 'appControl', 'automation']) assert.ok(FEATURES[k], k);
  assert.deepEqual(PRODUCT_FEATURES.slice(0, 3), ['apps', 'appControl', 'automation']);
});
test('only the switches that are sent change; unknown or non-boolean values are ignored', () => {
  assert.deepEqual(featureFields({ appControl: false }), { feat_appControl: 'off' });
  assert.deepEqual(featureFields({ automation: true, nope: false, apps: 'yes' }), { feat_automation: 'on' });
  assert.deepEqual(featureFields(undefined), {});
});
test('a company keeps everything unless something is switched off', () => {
  assert.equal(Object.values(featureMap({})).every(Boolean), true);
  const m = featureMap({ feat_appControl: 'off', feat_apps: 'on' });
  assert.equal(m.appControl, false); assert.equal(m.apps, true); assert.equal(featureOn({ feat_automation: 'off' }, 'automation'), false);
});
test('wiring: apps are gated on publish, sync and the nightly job; the Admin Center has the Company access tab; /me tells the app what is off', () => {
  assert.match(read('../src/functions/publish.js'), /featureOn\(t, 'apps'\)/);
  assert.match(read('../src/functions/inventory.js'), /featureOn\(t, 'apps'\)/);
  assert.match(read('../src/functions/nightlySync.js'), /featureOn\(x, 'apps'\)/);
  const p = read('../src/functions/platform.js');
  assert.match(p, /platform\/tenants\/\{id\}\/features/); assert.match(p, /feat_appControl: 'on'/);
  assert.doesNotMatch(p, /fields\['feat_' \+ k\] = b\.features/, 'saving org settings must not re-enable switches it was not sent');
  assert.match(read('../src/functions/me.js'), /features: t \? featureMap\(t\)/);
  const a = read('../../public/admin/index.html');
  assert.match(a, /data-tab="access"/); assert.match(a, /id="tab-access"/);
  assert.match(read('../../public/index.html'), /body\[data-off~=appControl\]/);
});
