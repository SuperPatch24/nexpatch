import { app } from '@azure/functions';
import { withUser, HttpError } from '../lib/http.js';
import { graph } from '../lib/graph.js';
import { getTenant, saveTenant, listMemberRows, saveMemberRow, memberKey, audit } from '../lib/store.js';
import { isEntraAdmin } from '../lib/access.js';

// POST /api/tenant/activate – called after an administrator approves NexpatchOnline.
// Allowed for Entra Global/Intune administrators, existing owners, or the very first activation of an organization.
app.http('tenantActivate', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'tenant/activate',
  handler: withUser(async (_req, _ctx, user) => {
    const tid = user.tenantId;
    const existing = await getTenant(tid);
    const members = await listMemberRows(tid);
    const firstTime = !existing && members.length === 0;
    if (!(isEntraAdmin(user) || user.role === 'owner' || firstTime)) {
      throw new HttpError(403, 'Only an owner or an Entra administrator can connect this organization.');
    }

    await graph(tid, '/beta/deviceManagement/detectedApps?$top=1'); // proves the approval works
    const t = await saveTenant(tid, { status: 'active', activatedAt: new Date().toISOString(), activatedBy: user.email || user.userId });

    // The person who connects the organization becomes its first owner.
    if (!members.some(m => m.kind === 'member' && m.role === 'owner')) {
      await saveMemberRow(tid, memberKey(user.userId), {
        kind: 'member', role: 'owner', name: user.name, email: user.email,
        addedBy: 'Connected the organization', addedAt: new Date().toISOString(), joinedAt: new Date().toISOString(), lastSeenAt: new Date().toISOString()
      });
    }
    await audit(tid, user.email || user.userId, 'connected', 'Connected the organization to NexpatchOnline');
    return { tenantId: t.rowKey, status: t.status, activatedAt: t.activatedAt };
  }, 'any')
});
