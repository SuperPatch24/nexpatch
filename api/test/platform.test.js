import test from 'node:test';
import assert from 'node:assert/strict';
import { platformRole, isPlatformAdmin } from '../src/lib/platform.js';

test('platform roles are separated and allowlisted by sign-in identity', () => {
  const names=['PLATFORM_ADMINS','PLATFORM_CATALOG_MANAGERS','PLATFORM_SUPPORT_ADMINS','PLATFORM_TENANT_ID'];
  const old=Object.fromEntries(names.map(n=>[n,process.env[n]]));
  try {
    process.env.PLATFORM_ADMINS='root@example.com';
    process.env.PLATFORM_CATALOG_MANAGERS='catalog@example.com';
    process.env.PLATFORM_SUPPORT_ADMINS='support@example.com';
    delete process.env.PLATFORM_TENANT_ID;
    const user=email=>({email, userId:'oid-'+email, tenantId:'tenant-a'});
    assert.equal(platformRole(user('root@example.com')),'superadmin');
    assert.equal(platformRole(user('catalog@example.com')),'catalog');
    assert.equal(platformRole(user('support@example.com')),'support');
    assert.equal(platformRole(user('other@example.com')),null);
    assert.equal(isPlatformAdmin(user('support@example.com')),true);
  } finally { for(const n of names){if(old[n]===undefined)delete process.env[n];else process.env[n]=old[n];} }
});
