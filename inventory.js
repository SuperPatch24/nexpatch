// Pulls the apps Intune has discovered on a tenant's Windows devices and stores them.
import { randomUUID } from 'node:crypto';
import { graphAll } from './graph.js';
import { replaceInventory, saveTenant, logSyncRun } from './store.js';
import { syncDevices } from './devices.js';

export async function syncInventory(tenantId, trigger) {
  // Distinct even when manual and scheduled syncs start in the same millisecond.
  const syncId = randomUUID();
  try {
    const apps = await graphAll(tenantId, '/beta/deviceManagement/detectedApps');
    const rows = apps
      .filter(a => a.displayName && (!a.platform || a.platform === 'windows' || a.platform === 'unknown'))
      .map(a => ({ displayName: String(a.displayName), version: String(a.version || ''), publisher: String(a.publisher || ''), deviceCount: Number(a.deviceCount) || 0, platform: a.platform || 'unknown' }));

    await replaceInventory(tenantId, rows, syncId);
    const syncedAt = new Date().toISOString();
    await saveTenant(tenantId, { lastSyncAt: syncedAt, lastSyncCount: rows.length, lastSyncError: '' });
    await logSyncRun(tenantId, { trigger, status: 'ok', count: rows.length });
    // Device reports are best-effort: a missing permission here must not fail the app inventory sync.
    let devices = null, deviceError = '';
    try { devices = (await syncDevices(tenantId)).devices; } catch (e) { deviceError = String(e.message || e).slice(0, 300); await saveTenant(tenantId, { lastDeviceSyncError: deviceError }).catch(() => {}); }
    if (devices != null) await saveTenant(tenantId, { lastDeviceSyncAt: syncedAt, lastDeviceSyncError: '' }).catch(() => {});
    return { count: rows.length, syncedAt, devices, deviceError };
  } catch (err) {
    await saveTenant(tenantId, { lastSyncError: String(err.message || err).slice(0, 500) }).catch(() => {});
    await logSyncRun(tenantId, { trigger, status: 'failed', error: String(err.message || err).slice(0, 500) }).catch(() => {});
    throw err;
  }
}
