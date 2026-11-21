import test from 'node:test';
import assert from 'node:assert/strict';
import { newSecret, hashSecret, secretMatches, rateCheck, keyExpiry, keyExpired, LIMITS, GUID } from '../src/lib/agentauth.js';

test('tokens: random, stored as hash, compared safely', () => {
  const a = newSecret(), b = newSecret();
  assert.notEqual(a, b); assert.ok(a.length >= 40);
  const h = hashSecret(a);
  assert.ok(secretMatches(h, a)); assert.ok(!secretMatches(h, b)); assert.ok(!secretMatches('', a)); assert.ok(!secretMatches(h, ''));
  assert.ok(!h.includes(a));
});

test('enrollment key expires after 30 days', () => {
  const now = new Date('2026-11-14T00:00:00Z');
  assert.ok(!keyExpired({ acKeyExpiresAt: keyExpiry(now) }, new Date('2026-12-13T00:00:00Z')));
  assert.ok(keyExpired({ acKeyExpiresAt: keyExpiry(now) }, new Date('2026-12-15T00:00:00Z')));
  assert.ok(keyExpired({}, now), 'no expiry on file counts as expired');
});

test('rate limit: counts calls and events per hour, then resets', () => {
  const t0 = new Date('2026-11-14T10:00:00Z');
  let row = {};
  let r = rateCheck(row, t0, 100); assert.ok(r.ok); row = { ...row, ...r.patch };
  assert.equal(row.winCalls, 1); assert.equal(row.winEvents, 100);
  r = rateCheck(row, new Date(t0.getTime() + 60000), LIMITS.eventsPerHour); assert.ok(!r.ok); assert.ok(r.retryAfter >= 60 && r.retryAfter <= 3600);
  r = rateCheck(row, new Date(t0.getTime() + 3600001), LIMITS.eventsPerHour); assert.ok(r.ok, 'new hour, new allowance');
  let calls = { winStart: t0.toISOString(), winCalls: LIMITS.callsPerHour, winEvents: 0 };
  assert.ok(!rateCheck(calls, new Date(t0.getTime() + 1000), 0).ok);
});

test('enroll limit is separate from ingest limit', () => {
  const t0 = new Date('2026-11-14T10:00:00Z'); let row = {};
  for (let i = 0; i < LIMITS.enrollsPerHour; i++) { const r = rateCheck(row, t0, 0, 'enroll'); assert.ok(r.ok); row = { ...row, ...r.patch }; }
  assert.ok(!rateCheck(row, t0, 0, 'enroll').ok);
  assert.ok(rateCheck(row, t0, 10, 'ingest').ok);
});

test('device ids must be GUIDs', () => { assert.ok(GUID.test('0b8c1f52-1111-4222-8333-444455556666')); assert.ok(!GUID.test('../etc/passwd')); assert.ok(!GUID.test('PC-01')); });
