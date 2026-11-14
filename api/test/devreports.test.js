import test from 'node:test';
import assert from 'node:assert/strict';
import { patchTuesday, cycleFor, parseOs, cmpVersion, buildReports, cycleCompliance, toCsv, shapeDevice } from '../src/lib/devreports.js';

test('Patch Tuesday is the second Tuesday of the month', () => {
  assert.equal(patchTuesday(2026, 10).toISOString().slice(0, 10), '2026-11-10');
  assert.equal(patchTuesday(2026, 11).toISOString().slice(0, 10), '2026-12-08');
  assert.equal(patchTuesday(2026, 0).toISOString().slice(0, 10), '2026-01-13');
  assert.equal(patchTuesday(2027, 2).toISOString().slice(0, 10), '2027-03-09');
});
test('a cycle runs from one Patch Tuesday to the next, across month and year ends', () => {
  const a = cycleFor(new Date('2026-11-13T12:00:00Z'));
  assert.equal(a.key, '2026-11-10'); assert.equal(a.end.slice(0, 10), '2026-12-08');
  const b = cycleFor(new Date('2026-11-09T23:59:00Z'));          // the day before: still last month's cycle
  assert.equal(b.key, '2026-10-13'); assert.equal(b.end.slice(0, 10), '2026-11-10');
  assert.equal(cycleFor(new Date('2026-11-10T00:00:00Z')).key, '2026-11-10');   // the day itself starts the new cycle
  const c = cycleFor(new Date('2026-12-20T00:00:00Z'));
  assert.equal(c.key, '2026-12-08'); assert.equal(c.end.slice(0, 10), '2027-01-12');
  const d = cycleFor(new Date('2027-01-05T00:00:00Z'));
  assert.equal(d.key, '2026-12-08');
  assert.match(a.label, /Nov 10, 2026/);
});
test('Windows builds and Microsoft 365 versions compare numerically', () => {
  assert.deepEqual([parseOs('10.0.22631.4037').build, parseOs('10.0.22631.4037').revision], [22631, 4037]);
  assert.equal(parseOs('10.0.22631.4037').label, 'Windows 11 23H2');
  assert.equal(parseOs('').label, 'Unknown');
  assert.equal(cmpVersion('16.0.17328.20162', '16.0.17231.20236'), 1);
  assert.equal(cmpVersion('16.0.9.1', '16.0.10.1'), -1);
  assert.equal(cmpVersion('1.2', '1.2.0'), 0);
});

const GB = 1024 ** 3, now = new Date('2026-11-13T12:00:00Z');
const dev = (o) => ({ rowKey: o.id, name: o.id, user: o.id + '@x.com', osVersion: '10.0.22631.4037', storageTotal: 256 * GB, storageFree: 100 * GB, ramBytes: 16 * GB, lastSync: '2026-11-12T00:00:00Z', compliance: 'compliant', encrypted: true, firstSeenAt: '2026-06-01T00:00:00Z', ...o });

test('hardware reports flag low storage, low memory and stale devices', () => {
  const { summary, reports } = buildReports([
    dev({ id: 'ok' }),
    dev({ id: 'full', storageFree: 10 * GB }),                       // 4% free, 10 GB
    dev({ id: 'smallram', ramBytes: 4 * GB }),
    dev({ id: 'old', lastSync: '2026-09-01T00:00:00Z' }),
    dev({ id: 'noenc', encrypted: false, compliance: 'noncompliant' })
  ], now);
  assert.equal(summary.devices, 5); assert.equal(summary.lowStorage, 1); assert.equal(summary.lowMemory, 1); assert.equal(summary.stale, 1);
  assert.equal(summary.notEncrypted, 1); assert.equal(summary.notCompliant, 1);
  assert.equal(reports.lowStorage.rows[0][0], 'full'); assert.equal(reports.lowMemory.rows[0][2], 4);
  assert.equal(reports.hardware.rows.length, 5);
  assert.equal(reports.security.rows.length, 1);
});
test('a device with unknown storage is not reported as low storage', () => {
  const { summary } = buildReports([dev({ id: 'a', storageTotal: 0, storageFree: 0 })], now);
  assert.equal(summary.lowStorage, 0);
});
test('Microsoft 365 Apps report compares each device with the newest version in the fleet', () => {
  const { summary, reports } = buildReports([dev({ id: 'a', m365Version: '16.0.17328.20162' }), dev({ id: 'b', m365Version: '16.0.17231.20236' }), dev({ id: 'c' })], now);
  assert.equal(summary.m365Devices, 2); assert.equal(summary.m365Behind, 1); assert.equal(summary.m365Newest, '16.0.17328.20162');
  assert.deepEqual(reports.m365.rows.map(r => r[3]), ['Behind', 'Current']);
  assert.equal(reports.m365Versions.rows[0][0], '16.0.17328.20162');
});
test('Windows version report counts devices behind the newest revision of their build', () => {
  const { summary, reports } = buildReports([dev({ id: 'a', osVersion: '10.0.22631.4100' }), dev({ id: 'b', osVersion: '10.0.22631.4037' }), dev({ id: 'c', osVersion: '10.0.19045.5000' })], now);
  assert.equal(summary.behindOnUpdates, 1);
  assert.equal(reports.windows.rows[0][0], 'Windows 11 23H2'); assert.equal(reports.windows.rows[0][3], 1);
});

test('cycle compliance: installed this cycle, joined up to date, not patched, no check-in', () => {
  const cyc = cycleFor(now);   // starts 2026-11-10
  const c = cycleCompliance([
    dev({ id: 'patched', osVersion: '10.0.22631.4200', prevOsVersion: '10.0.22631.4037', osChangedAt: '2026-11-12T07:00:00Z' }),
    dev({ id: 'newjoin', osVersion: '10.0.22631.4200', firstSeenAt: '2026-11-11T07:00:00Z' }),
    dev({ id: 'behind', osVersion: '10.0.22631.4037' }),
    dev({ id: 'gone', osVersion: '10.0.22631.4037', lastSync: '2026-09-01T00:00:00Z' }),
    dev({ id: 'oldchange', osVersion: '10.0.22631.4100', prevOsVersion: '10.0.22631.4037', osChangedAt: '2026-10-20T07:00:00Z' })   // patched last cycle, not this one
  ], cyc, now);
  const by = Object.fromEntries(c.rows.map(r => [r.name, r]));
  assert.equal(by.patched.compliant, true); assert.equal(by.newjoin.compliant, true);
  assert.equal(by.behind.compliant, false); assert.equal(by.gone.compliant, false); assert.match(by.gone.reason, /No check-in/);
  assert.equal(by.oldchange.compliant, false);
  assert.equal(c.devices, 5); assert.equal(c.compliant, 2); assert.equal(c.pct, 40); assert.equal(c.stale, 1);
  assert.equal(c.rows[0].compliant, false);   // non-compliant listed first
});
test('a downgrade or rollback does not count as installing the update', () => {
  const c = cycleCompliance([dev({ id: 'x', osVersion: '10.0.22631.3900', prevOsVersion: '10.0.22631.4037', osChangedAt: '2026-11-12T07:00:00Z' })], cycleFor(now), now);
  assert.equal(c.rows[0].compliant, false);
});
test('CSV output is quoted correctly and neutralises spreadsheet formulas', () => {
  const csv = toCsv(['A', 'B'], [['x, y', 'say "hi"'], ['=cmd|calc', '+1'], ['line\nbreak', 5]]);
  assert.ok(csv.startsWith('﻿A,B\r\n'));
  assert.ok(csv.includes('"x, y","say ""hi"""'));
  assert.ok(csv.includes("'=cmd|calc,'+1"));
  assert.ok(csv.includes('"line\nbreak",5'));
});
test('shapeDevice tolerates empty rows', () => {
  const d = shapeDevice({}, now); assert.equal(d.freePct, null); assert.equal(d.stale, false); assert.equal(d.encrypted, null);
});
