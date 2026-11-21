import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stuckKind, stuckMessage } from '../src/lib/jobhealth.js';
import { cleanPrivateApp, privateId, TENANT_ID } from '../src/lib/privatecatalog.js';

const NOW = Date.parse('2026-11-21T12:00:00Z'), ago = m => new Date(NOW - m * 60000).toISOString();

test('a job that stays queued, or runs far too long, is flagged; healthy and finished jobs are not', () => {
  assert.equal(stuckKind({ status: 'queued', createdAt: ago(2) }, NOW), '');
  assert.equal(stuckKind({ status: 'queued', createdAt: ago(6) }, NOW), 'not-started');
  assert.equal(stuckKind({ status: 'running', startedAt: ago(10), createdAt: ago(40) }, NOW), '');
  assert.equal(stuckKind({ status: 'running', startedAt: ago(31) }, NOW), 'slow');
  assert.equal(stuckKind({ status: 'succeeded', createdAt: ago(500) }, NOW), '');
  assert.equal(stuckKind({ status: 'failed', createdAt: ago(500) }, NOW), '');
  assert.equal(stuckKind({ status: 'queued' }, NOW), '', 'no timestamp, no flag');
  assert.ok(stuckMessage('not-started').includes('background service') && stuckMessage('slow') && stuckMessage('') === '');
});

test('company-only apps are validated and get their own id', () => {
  const ok = cleanPrivateApp({ name: ' Contoso CRM ', vendor: 'Contoso', winget: '' });
  assert.equal(ok.id, 'p-contoso-crm'); assert.equal(ok.value.private, true); assert.equal(ok.value.winget, '');
  assert.equal(privateId('x', 'Vendor.App'), 'p-vendor-app');
  assert.ok(cleanPrivateApp({ name: '' }).error); assert.ok(cleanPrivateApp({ name: 'A', winget: '../bad id' }).error);
  assert.ok(TENANT_ID.test('0b8c1f52-1111-4222-8333-444455556666')); assert.ok(!TENANT_ID.test('global')); assert.ok(!TENANT_ID.test('../x'));
});

test('the shared catalog list adds only the caller’s own partition; nothing lists other companies’ apps', () => {
  const src = readFileSync(new URL('../src/functions/platform.js', import.meta.url), 'utf8');
  const list = src.slice(src.indexOf("route: 'catalog'"), src.indexOf('// Platform administration'));
  assert.ok(list.includes("listRows('Catalog', user.tenantId") && list.includes("listRows('Catalog', GLOBAL)"));
  assert.ok(!/listAllTenants/.test(list), 'the customer-facing list never walks other tenants');
  for (const r of ['privateCatalogList', 'privateCatalogPut', 'privateCatalogDelete']) assert.ok(src.includes(r));
  assert.ok(src.includes("PRIVATE_ROLES = ['superadmin', 'catalog', 'support']"));
});
