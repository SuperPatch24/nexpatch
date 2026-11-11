import test from 'node:test';
import assert from 'node:assert/strict';
import { MSSTORE_CANDIDATES } from '../src/lib/msstore-candidates.js';

test('Microsoft Store discovery seed contains 250 unique candidate names', () => {
  assert.equal(MSSTORE_CANDIDATES.length, 250);
  const names = MSSTORE_CANDIDATES.map(x => x.name.toLowerCase());
  assert.equal(new Set(names).size, 250);
  assert.ok(MSSTORE_CANDIDATES.every(x => x.name && x.category));
});

test('Store discovery candidates do not contain invented product IDs or PFNs', () => {
  assert.ok(MSSTORE_CANDIDATES.every(x => !('productId' in x) && !('packageFamily' in x) && !('pfn' in x)));
});
