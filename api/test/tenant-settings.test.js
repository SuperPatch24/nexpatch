import test from 'node:test';
import assert from 'node:assert/strict';
import { accessOf, accessMessage, featureOn, overrideNumber, parseDomains, emailDomainAllowed, highestGrantedRole } from '../src/lib/tenantsettings.js';
import { limitsFor, TIERS } from '../src/lib/plans.js';

test('access status defaults to active and explains revoked and suspended organizations', () => {
  assert.equal(accessOf({}), 'active'); assert.equal(accessOf({ accessStatus: 'bogus' }), 'active'); assert.equal(accessOf(null), 'active');
  assert.equal(accessMessage({}), '');
  assert.match(accessMessage({ accessStatus: 'revoked', accessReason: 'subscription ended' }), /ended.*subscription ended.*renew/);
  assert.match(accessMessage({ accessStatus: 'suspended' }), /view your data/);
});
test('features are on unless the operator turned them off', () => {
  assert.equal(featureOn({}, 'packaging'), true); assert.equal(featureOn({ feat_packaging: 'off' }, 'packaging'), false);
  assert.equal(featureOn({ feat_packaging: 'on' }, 'packaging'), true); assert.equal(featureOn({ feat_appControl: 'off' }, 'packaging'), true);
});
test('limit overrides replace plan limits only when set', () => {
  const base = limitsFor({ plan: 'active', tier: 'pro' });
  assert.equal(base.customApps, TIERS.pro.customApps);
  const o = limitsFor({ plan: 'active', tier: 'pro', limitCustomApps: 25, limitDevices: '', limitPackageRequests: 0 });
  assert.equal(o.customApps, 25); assert.equal(o.devices, TIERS.pro.maxDevices); assert.equal(o.packageRequests, 0);
  assert.equal(limitsFor({ plan: 'trial', trialEndsAt: 'x', limitCustomApps: 3 }).customApps, 3);
  assert.equal(overrideNumber(''), null); assert.equal(overrideNumber('12'), 12); assert.equal(overrideNumber(-1), null); assert.equal(overrideNumber('abc'), null);
});
test('allowed invitation domains are cleaned and enforced', () => {
  assert.deepEqual(parseDomains('Contoso.com, @fabrikam.com; bad_domain, contoso.com'), ['contoso.com', 'fabrikam.com']);
  assert.equal(emailDomainAllowed('a@contoso.com', ''), true);
  assert.equal(emailDomainAllowed('a@contoso.com', 'contoso.com'), true);
  assert.equal(emailDomainAllowed('a@evil.com', 'contoso.com, fabrikam.com'), false);
  assert.equal(emailDomainAllowed('nope', 'contoso.com'), false);
});
test('an Entra group grants the highest role among the groups the person is in', () => {
  const grants = [{ groupId: 'g1', role: 'viewer' }, { groupId: 'g2', role: 'admin' }, { groupId: 'g3', role: 'owner' }];
  assert.equal(highestGrantedRole(grants, new Set(['g1'])), 'viewer');
  assert.equal(highestGrantedRole(grants, new Set(['g1', 'g2'])), 'admin');
  assert.equal(highestGrantedRole(grants, new Set(['g3'])), null);   // owner cannot be granted by a group
  assert.equal(highestGrantedRole(grants, new Set()), null);
});
