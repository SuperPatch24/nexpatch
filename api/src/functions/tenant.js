import { app } from '@azure/functions';
import { withUser, HttpError } from '../lib/http.js';
import { graph } from '../lib/graph.js';
import { saveTenant } from '../lib/store.js';

// POST /api/tenant/activate – called after an admin approves Nexpatch.
// Proves the approval works by reading Intune once, then marks the organization active.
app.http('tenantActivate', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'tenant/activate',
  handler: withUser(async (_req, _ctx, user) => {
    await graph(user.tenantId, '/beta/deviceManagement/detectedApps?$top=1');
    const t = await saveTenant(user.tenantId, {
      status: 'active',
      activatedAt: new Date().toISOString(),
      activatedBy: user.email || user.userId
    });
    if (!t) throw new HttpError(500, 'Couldn\u2019t save your organization.');
    return { tenantId: t.rowKey, status: t.status, activatedAt: t.activatedAt };
  })
});
