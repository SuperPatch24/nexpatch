// Pulls the apps Intune has discovered on a tenant's Windows devices and stores them.
import { graphAll } from './graph.js';
import { replaceInventory, saveTenant, logSyncRun } from './store.js';

export async function syncInventory(tenantId, trigger) {
  const syncId = Date.now().toString(36);
  try {
    const apps = await graphAll(tenantId, '/beta/deviceManagement/detectedApps');
    const rows = apps
      .filter(a => a.displayName && (!a.platform || a.platform === 'windows' || a.platform === 'unknown'))
      .map(a => ({ displayName: String(a.displayName), version: String(a.version || ''), deviceCount: Number(a.deviceCount) || 0, platform: a.platform || 'unknown' }));

    await replaceInventory(tenantId, rows, syncId);
    const syncedAt = new Date().toISOString();
    await saveTenant(tenantId, { lastSyncAt: syncedAt, lastSyncCount: rows.length, lastSyncError: '' });
    await logSyncRun(tenantId, { trigger, status: 'ok', count: rows.length });
    return { count: rows.length, syncedAt };
  } catch (err) {
    await saveTenant(tenantId, { lastSyncError: String(err.message || err).slice(0, 500) }).catch(() => {});
    await logSyncRun(tenantId, { trigger, status: 'failed', error: String(err.message || err).slice(0, 500) }).catch(() => {});
    throw err;
  }
}
