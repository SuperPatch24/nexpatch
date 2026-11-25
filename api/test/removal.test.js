import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { removeIntuneApp, isOurApp, validAppId, APPS } from '../src/lib/removal.js';

const ID = '0d6c5a7e-1b2c-4d3e-8f90-123456789abc';
const fake = (apps, calls = []) => ({ calls, graph: async (path, o = {}) => {
  calls.push((o.method || 'GET') + ' ' + path);
  const id = path.split('/mobileApps/')[1]?.split('?')[0];
  const a = apps[id];
  if (!a) { const e = new Error('Microsoft Graph returned an error (404): not found'); e.status = 502; throw e; }
  if (o.method === 'DELETE') { delete apps[id]; return null; }
  return a;
} });

test('an app NexpatchOnline created is deleted in Intune', async () => {
  const apps = { [ID]: { id: ID, displayName: 'Google Chrome', description: 'Google Chrome 131, packaged by NexpatchOnline from winget (Google.Chrome).' } };
  const f = fake(apps);
  assert.deepEqual(await removeIntuneApp(f, ID), { status: 'removed', name: 'Google Chrome' });
  assert.deepEqual(f.calls, [`GET ${APPS}/${ID}?$select=id,displayName,description,notes`, `DELETE ${APPS}/${ID}`]);
  assert.equal(apps[ID], undefined);
});

test('Store apps NexpatchOnline created are recognised too', () => {
  assert.equal(isOurApp({ description: 'Slack from the Microsoft Store. Managed by NexpatchOnline.' }), true);
  assert.equal(isOurApp({ description: 'Our own line-of-business app', notes: '' }), false);
  assert.equal(isOurApp(null), false);
});

test('an app the company made itself is never deleted', async () => {
  const apps = { [ID]: { id: ID, displayName: 'Payroll', description: 'Made by IT.' } };
  const f = fake(apps);
  assert.deepEqual(await removeIntuneApp(f, ID), { status: 'not-ours', name: 'Payroll' });
  assert.equal(f.calls.some(c => c.startsWith('DELETE')), false);
  assert.ok(apps[ID]);
});

test('an app that is already gone from Intune is not an error', async () => {
  assert.deepEqual(await removeIntuneApp(fake({}), ID), { status: 'already-gone' });
  // deleted by someone between the check and the delete
  let n = 0; const g = async (_p, o = {}) => { if (o.method === 'DELETE') { const e = new Error('(404)'); e.status = 404; throw e; } n++; return { id: ID, displayName: 'X', description: 'NexpatchOnline' }; };
  assert.equal((await removeIntuneApp({ graph: g }, ID)).status, 'already-gone');
});

test('no app id or a malformed one never reaches Graph', async () => {
  const f = fake({});
  assert.equal((await removeIntuneApp(f, '')).status, 'no-app');
  assert.equal((await removeIntuneApp(f, '../../devices')).status, 'no-app');
  assert.equal(f.calls.length, 0);
  assert.equal(validAppId(ID), true); assert.equal(validAppId('x/y'), false);
});

test('other Graph errors are passed up, so the deployment is not marked removed', async () => {
  const g = async () => { const e = new Error('Microsoft Graph returned an error (500)'); e.status = 502; throw e; };
  await assert.rejects(() => removeIntuneApp({ graph: g }, ID), /500/);
});

test('wiring: removing needs admin, is audited, and the page asks before removing from Intune', () => {
  const f = readFileSync(new URL('../src/functions/publish.js', import.meta.url), 'utf8');
  const route = f.slice(f.indexOf("app.http('publishRemove'"));
  assert.match(route, /methods: \['DELETE'\]/); assert.match(route, /'admin'\)/); assert.match(route, /audit\(/);
  assert.match(f, /j\.removedAt\) continue/);   // removed apps no longer count as "last updated"
  const page = readFileSync(new URL('../../public/index.html', import.meta.url), 'utf8');
  assert.ok(page.includes("api('/publish/'+encodeURIComponent(") && page.includes('Remove from Intune'));
});
