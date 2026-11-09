import { app } from '@azure/functions';
import { withUser } from '../lib/http.js';
import { getTenant } from '../lib/store.js';
import { isPlatformAdmin } from '../lib/platform.js';
import { planStatus } from '../lib/plan.js';

// GET /api/me – who is signed in, their role, and whether their organization is connected.
app.http('me', {
  methods: ['GET'],
  authLevel: 'anonymous', // access is checked by withUser
  route: 'me',
  handler: withUser(async (_req, _ctx, user) => {
    const t = await getTenant(user.tenantId);
    return {
      user: { tenantId: user.tenantId, userId: user.userId, name: user.name, email: user.email },
      role: user.role,
      access: user.access,
      platformAdmin: isPlatformAdmin(user),
      plan: t && t.status === 'active' ? planStatus(t) : null,
      tenant: t ? { tenantId: t.rowKey, status: t.status, activatedAt: t.activatedAt, lastSyncAt: t.lastSyncAt || null, lastSyncCount: t.lastSyncCount || 0, lastSyncError: t.lastSyncError || '' } : null
    };
  }, 'any')
});
