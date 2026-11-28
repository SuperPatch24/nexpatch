import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { newInviteCode, normalizeCode, codeHash, looksLikeCode, effectiveRole, cleanAccess, partnerDecision, customerSummary } from '../src/lib/partners.js';

const read = p => readFileSync(new URL(p, import.meta.url), 'utf8');
const link = (access = 'admin') => ({ status: 'active', access });

test('invite codes are readable, random, and stored only as a hash that ignores formatting', () => {
  const a = newInviteCode(), b = newInviteCode();
  assert.match(a, /^NXP-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/); assert.notEqual(a, b);
  assert.equal(codeHash(a), codeHash(a.toLowerCase().replace(/-/g, ' ')));
  assert.equal(normalizeCode('nxp-abcd-efgh-jkmn'), 'ABCDEFGHJKMN');
  assert.equal(looksLikeCode(a), true); assert.equal(looksLikeCode('NXP-12'), false);
  assert.match(codeHash(a), /^[0-9a-f]{64}$/);
});

test('a partner never has more than the customer allowed, or than their own role', () => {
  assert.equal(effectiveRole('owner', 'admin'), 'admin');
  assert.equal(effectiveRole('owner', 'viewer'), 'viewer');
  assert.equal(effectiveRole('viewer', 'admin'), 'viewer');
  assert.equal(effectiveRole('admin', 'owner'), null);          // customers can't grant owner
  assert.equal(effectiveRole(null, 'admin'), null);
  assert.equal(cleanAccess('owner'), 'viewer'); assert.equal(cleanAccess('admin'), 'admin');
});

test('each request is checked: blocked routes, missing or removed links, suspended or revoked customers, too little access', () => {
  const t = { rowKey: 'c1' };
  assert.deepEqual(partnerDecision({ homeRole: 'owner', link: link(), tenant: t, minRole: 'admin' }), { role: 'admin', tenantStatus: 'active' });
  assert.match(partnerDecision({ blocked: true, homeRole: 'owner', link: link(), tenant: t }).error.message, /Switch back/);
  assert.equal(partnerDecision({ homeRole: 'owner', link: null, tenant: t }).error.status, 403);
  assert.equal(partnerDecision({ homeRole: 'owner', link: { status: 'removed', access: 'admin' }, tenant: t }).error.status, 403);
  assert.equal(partnerDecision({ homeRole: 'owner', link: link(), tenant: null }).error.status, 404);
  assert.match(partnerDecision({ homeRole: 'owner', link: link(), tenant: t, tenantStatus: 'revoked' }).error.message, /revoked/);
  assert.equal(partnerDecision({ homeRole: 'owner', link: link(), tenant: t, tenantStatus: 'suspended', minRole: 'viewer' }).role, 'admin');
  assert.match(partnerDecision({ homeRole: 'owner', link: link(), tenant: t, tenantStatus: 'suspended', minRole: 'admin' }).error.message, /suspended/);
  assert.match(partnerDecision({ homeRole: 'owner', link: link('viewer'), tenant: t, minRole: 'admin' }).error.message, /View only/);
  assert.match(partnerDecision({ homeRole: 'owner', link: link(), tenant: t, minRole: 'owner' }).error.message, /Manage/);
  assert.equal(partnerDecision({ homeRole: null, link: link(), tenant: t }).error.status, 403);
  assert.equal(partnerDecision({ homeRole: 'viewer', link: link(), tenant: t, minRole: 'any' }).role, 'viewer');
});

test('customer overview: what needs attention is spelled out', () => {
  const now = new Date().toISOString();
  const ok = customerSummary({ rowKey: 'c1', access: 'admin' }, { status: 'active', name: 'Fabrikam', lastSyncAt: now, lastSyncCount: 120, vulnSummary: JSON.stringify({ knownExploited: 0, cves: { CRITICAL: 0, HIGH: 2 } }) }, { devices: 40, agentDevices: 38, agentAttention: 0 });
  assert.equal(ok.status, 'ok'); assert.equal(ok.name, 'Fabrikam'); assert.equal(ok.accessName, 'Manage'); assert.equal(ok.vulnerabilities.high, 2);
  const bad = customerSummary({ rowKey: 'c2', access: 'viewer', customerName: 'Contoso' }, { status: 'active', lastSyncAt: '2026-01-01T00:00:00Z', lastSyncError: 'x', vulnSummary: JSON.stringify({ knownExploited: 2, cves: {} }) }, { failedPublishes: 3, agentAttention: 1, agentDevices: 5 });
  assert.equal(bad.status, 'attention'); assert.equal(bad.name, 'Contoso');
  assert.deepEqual(bad.attention, ['Inventory not synced in 2 days', 'Last sync failed', '2 known exploited flaws', '3 failed publishes in 30 days', '1 device need attention']);
  assert.deepEqual(customerSummary({ rowKey: 'c3', access: 'admin' }, null).attention, ['Not connected to Intune']);
});

test('wiring: the context header is checked on every request; sensitive routes refuse partners; codes are single-use', () => {
  const http = read('../src/lib/http.js');
  assert.match(http, /x-nexpatch-context/); assert.match(http, /await applyPartnerContext\(request, user, minRole, options\);\n\s+const body = await handler/);
  assert.match(http, /getRow\('PartnerLinks', user\.tenantId, ctx\)/);
  const blocked = { 'users.js': 5, 'org.js': 3, 'planrequest.js': 2, 'legal.js': 2, 'tenant.js': 1, 'security.js': 2, 'billing.js': 3 };
  for (const [f, n] of Object.entries(blocked)) assert.equal((read(`../src/functions/${f}`).match(/partner: false/g) || []).length, n, f);
  const p = read('../src/functions/partners.js');
  assert.equal((p.match(/NO_PARTNER\) \}\);/g) || []).length, 9);
  assert.match(p, /if \(!inv \|\| inv\.usedAt\)/); assert.match(p, /usedAt: now/); assert.match(p, /inv\.mspTenantId === user\.tenantId/);
  assert.match(p.slice(p.indexOf("'partnerAccept'")), /'owner', NO_PARTNER/);
  const me = read('../src/functions/me.js');
  assert.match(me, /user\.partner \? \{ \.\.\.user, tenantId: user\.partner\.homeTenantId \}/);
});
