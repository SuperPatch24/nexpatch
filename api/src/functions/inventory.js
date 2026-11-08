import { app } from '@azure/functions';
import { withUser, HttpError } from '../lib/http.js';
import { getTenant, getInventory, audit } from '../lib/store.js';
import { syncInventory } from '../lib/inventory.js';

async function requireActive(tenantId) {
  const t = await getTenant(tenantId);
  if (!t || t.status !== 'active') throw new HttpError(409, 'Your organization isn\u2019t connected yet. Approve Nexpatch on the Connect page first.');
  return t;
}

// GET /api/inventory – the last stored inventory for the signed-in user's organization.
app.http('inventoryGet', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'inventory',
  handler: withUser(async (_req, _ctx, user) => {
    const t = await requireActive(user.tenantId);
    return { syncedAt: t.lastSyncAt || null, apps: await getInventory(user.tenantId) };
  }, 'viewer')
});

// POST /api/inventory/sync – pull fresh inventory from Intune now.
app.http('inventorySync', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'inventory/sync',
  handler: withUser(async (_req, _ctx, user) => {
    const t = await requireActive(user.tenantId);
    if (t.lastSyncAt && Date.now() - Date.parse(t.lastSyncAt) < 5 * 60 * 1000) {
      throw new HttpError(429, 'Inventory was synced in the last 5 minutes. Please try again shortly.');
    }
    const result = await syncInventory(user.tenantId, 'manual');
    await audit(user.tenantId, user.email || user.userId, 'synced inventory', `${result.count} app versions`);
    return { ...result, apps: await getInventory(user.tenantId) };
  }, 'admin')
});
