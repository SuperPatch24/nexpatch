import { app } from '@azure/functions';
import { withUser } from '../lib/http.js';
import { getTenant } from '../lib/store.js';
import { isPlatformAdmin, platformRole } from '../lib/platform.js';
import { planStatus } from '../lib/plan.js';
import { featureMap } from '../lib/tenantsettings.js';
import { legalStatus, DOC_URLS } from '../lib/legal.js';

// GET /api/me – who is signed in, their role, and whether their organization is connected.
app.http('me', {
  methods: ['GET'],
  authLevel: 'anonymous', // access is checked by withUser
  route: 'me',
  handler: withUser(async (_req, _ctx, user) => {
    const t = await getTenant(user.tenantId);
    // What the person still has to accept; the app shows the "Before you continue" box when needed.
    // A partner working in a customer accepts NexpatchOnline's terms for their own organization, not the customer's.
    const legalUser = user.partner ? { ...user, tenantId: user.partner.homeTenantId } : user, legalRole = user.partner ? user.partner.homeRole : user.role;
    const legal = legalRole ? await legalStatus(legalUser, legalRole).then(l => ({ ...l, urls: DOC_URLS })).catch(() => null) : null;
    return {
      legal,
      user: { tenantId: user.tenantId, userId: user.userId, name: user.name, email: user.email },
      role: user.role,
      partner: user.partner ? { customerTenantId: user.partner.customerTenantId, customerName: user.partner.customerName, access: user.partner.access, accessName: user.partner.accessName, homeTenantId: user.partner.homeTenantId, homeRole: user.partner.homeRole } : null,
      access: user.access,
      accessStatus: user.tenantStatus || 'active', accessMessage: user.tenantMessage || '',
      platformAdmin: isPlatformAdmin(user),
      platformRole: platformRole(user),
      plan: t && t.status === 'active' ? planStatus(t) : null,
      features: t ? featureMap(t) : null,
      tenant: t ? { tenantId: t.rowKey, status: t.status, activatedAt: t.activatedAt, lastSyncAt: t.lastSyncAt || null, lastSyncCount: t.lastSyncCount || 0, lastSyncError: t.lastSyncError || '' } : null
    };
  }, 'any')
});
