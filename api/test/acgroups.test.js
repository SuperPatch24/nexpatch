import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeGroupInputs, checkAssignments, isGroupId } from '../src/lib/acgroups.js';

const A = '3F2B1C4D-1111-2222-3333-444455556666', B = '9a8b7c6d-aaaa-bbbb-cccc-ddddeeeeffff';

test('every way a group is entered is kept: ids (with or without braces), names and saved objects; repeats are dropped', () => {
  assert.deepEqual(normalizeGroupInputs([A, `{${A.toLowerCase()}}`, 'Pilot devices', ' pilot DEVICES ', { id: B, name: 'Sales' }, '', null, { name: 'IT' }]),
    [{ id: A.toLowerCase() }, { name: 'Pilot devices' }, { id: B }, { name: 'IT' }]);
  assert.deepEqual(normalizeGroupInputs(undefined), []);
  assert.equal(normalizeGroupInputs(Array.from({ length: 40 }, (_, i) => 'G' + i)).length, 25);
  assert.equal(isGroupId(`{${A}}`), true); assert.equal(isGroupId('Pilot'), false);
});

test('a deploy only counts as done when Intune has every requested group', () => {
  const saved = [{ target: { '@odata.type': '#microsoft.graph.groupAssignmentTarget', groupId: A.toLowerCase() } }];
  assert.equal(checkAssignments({ groupIds: [A] }, saved).ok, true);
  const miss = checkAssignments({ groupIds: [A, B] }, saved);
  assert.equal(miss.ok, false); assert.deepEqual(miss.missing, [B]);
  assert.equal(checkAssignments({ groupIds: [], allDevices: true }, saved).ok, false);
  assert.equal(checkAssignments({ groupIds: [], allDevices: true }, [{ target: { '@odata.type': '#microsoft.graph.allDevicesAssignmentTarget' } }]).ok, true);
});

test('wiring: deploy refuses no target, verifies assignments, and the page sends every group field', () => {
  const fn = readFileSync(new URL('../src/functions/appcontrol.js', import.meta.url), 'utf8');
  assert.match(fn, /Choose at least one group \(or All devices\)/);
  assert.doesNotMatch(fn, /resolveGroupIds/);
  const dep = readFileSync(new URL('../src/lib/acdeploy.js', import.meta.url), 'utf8');
  assert.match(dep, /\/assignments`\)/); assert.match(dep, /checkAssignments\(/);
  const page = readFileSync(new URL('../../public/index.html', import.meta.url), 'utf8');
  assert.match(page, /function acbTargets\(\)/);
  assert.match(page, /groups:targets, allDevices/);
  assert.match(page, /S\.policy\.group/);
});
