import test from 'node:test';
import assert from 'node:assert/strict';
import { legalNeeds, LEGAL, userKey } from '../src/lib/legaldocs.js';

test('everyone accepts the Terms; only admins and owners accept the DPA', () => {
  const current = { termsVersion: LEGAL.terms, privacyVersion: LEGAL.privacy };
  assert.deepEqual([legalNeeds(null, null, 'viewer').needsTerms, legalNeeds(null, null, 'viewer').needsDpa], [true, false]);
  assert.equal(legalNeeds(current, null, 'viewer').needsTerms, false);
  assert.equal(legalNeeds(current, null, 'admin').needsDpa, true);
  assert.equal(legalNeeds(current, { version: LEGAL.dpa }, 'owner').needsDpa, false);
});

test('a new document version asks again', () => {
  const old = { termsVersion: '2020-01-01', privacyVersion: LEGAL.privacy };
  assert.equal(legalNeeds(old, null, 'viewer').needsTerms, true);
  assert.equal(legalNeeds({ termsVersion: LEGAL.terms, privacyVersion: LEGAL.privacy }, { version: '2020-01-01' }, 'admin').needsDpa, true);
});

test('user keys are stable and bounded', () => {
  assert.equal(userKey('ABC'), 'user-abc');
  assert.ok(userKey('x'.repeat(500)).length <= 120);
});
