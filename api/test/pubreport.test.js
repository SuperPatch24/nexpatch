import test from 'node:test';
import assert from 'node:assert/strict';
import { publishingReport, errorKey } from '../src/lib/pubreport.js';

const NOW = Date.parse('2026-11-26T12:00:00Z');
const job = (app, status, day, extra = {}) => ({ appName: app, status, createdAt: new Date(NOW - day * 864e5).toISOString(), startedAt: new Date(NOW - day * 864e5).toISOString(),
  finishedAt: new Date(NOW - day * 864e5 + 4 * 60000).toISOString(), ...extra });

test('publishing report: success rate, per-app results, grouped errors, recent failures', () => {
  const r = publishingReport([
    job('Chrome', 'succeeded', 1, { version: '131' }), job('Chrome', 'failed', 2, { error: 'Intune reported commitFileFailed. Job 12345678-aaaa-bbbb-cccc-1234567890ab.' }),
    job('Chrome', 'failed', 3, { error: 'Intune reported commitFileFailed. Job 99999999-aaaa-bbbb-cccc-1234567890ab.' }),
    job('Zoom', 'succeeded', 5, { operationType: 'update' }), job('Zoom', 'running', 0), job('Old', 'succeeded', 200), job('Gone', 'cancelled', 1)
  ], { now: NOW });
  assert.equal(r.total, 5); assert.equal(r.succeeded, 2); assert.equal(r.failed, 2); assert.equal(r.running, 1); assert.equal(r.successRate, 50); assert.equal(r.medianMinutes, 4);
  assert.deepEqual(r.apps.map(a => [a.app, a.succeeded, a.failed, a.successRate]), [['Chrome', 1, 2, 33], ['Zoom', 1, 0, 100]]);
  assert.equal(r.apps[0].lastVersion, '131'); assert.equal(r.apps[1].updates, 1);
  assert.deepEqual(r.errors, [{ error: 'Intune reported commitFileFailed.', count: 2 }]);
  assert.equal(r.failures.length, 2); assert.equal(r.failures[0].app, 'Chrome');
  assert.equal(publishingReport([], { now: NOW }).successRate, null);
  assert.equal(errorKey(''), 'Unknown error');
});
