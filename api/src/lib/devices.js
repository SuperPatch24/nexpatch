// Pulls Windows managed devices from Intune and keeps a compact copy for reports.
import { graphAll } from './graph.js';
import { listRows, putRow, deleteRow, getRow } from './store.js';
import { cycleFor, cycleCompliance, parseOs, cmpVersion } from './devreports.js';

const M365_NAME = /microsoft (365 apps|office 365|office (professional|standard|home|click))/i;
const SELECT = 'id,deviceName,userPrincipalName,operatingSystem,osVersion,manufacturer,model,serialNumber,totalStorageSpaceInBytes,freeStorageSpaceInBytes,physicalMemoryInBytes,lastSyncDateTime,complianceState,isEncrypted,enrolledDateTime,managedDeviceOwnerType';

export async function syncDevices(tenantId, now = new Date()) {
  const graphDevices = await graphAll(tenantId, `/beta/deviceManagement/managedDevices?$select=${SELECT}&$filter=${encodeURIComponent("operatingSystem eq 'Windows'")}`);
  const existing = new Map((await listRows('DeviceInventory', tenantId, 20000)).map(r => [r.rowKey, r]));

  // Which devices have Microsoft 365 Apps, and which version (detected apps know the version, devices know the app).
  const m365 = new Map();
  try {
    const apps = (await graphAll(tenantId, '/beta/deviceManagement/detectedApps')).filter(a => M365_NAME.test(a.displayName || '') && a.id);
    for (const a of apps.slice(0, 40)) {
      for (const d of await graphAll(tenantId, `/beta/deviceManagement/detectedApps/${encodeURIComponent(a.id)}/managedDevices?$select=id`)) {
        const prev = m365.get(d.id);
        if (!prev || cmpVersion(a.version, prev) > 0) m365.set(d.id, String(a.version || ''));
      }
    }
  } catch { /* Microsoft 365 data is optional: devices still sync without it */ }

  const nowIso = now.toISOString(), seen = new Set(), merged = [];
  for (const g of graphDevices) {
    if (!g.id) continue;
    const id = String(g.id).replace(/[^A-Za-z0-9-]/g, '');
    seen.add(id);
    const old = existing.get(id), osVersion = String(g.osVersion || '');
    const row = {
      name: String(g.deviceName || '').slice(0, 120), user: String(g.userPrincipalName || '').slice(0, 120), osVersion,
      manufacturer: String(g.manufacturer || '').slice(0, 80), model: String(g.model || '').slice(0, 120), serial: String(g.serialNumber || '').slice(0, 60),
      storageTotal: Number(g.totalStorageSpaceInBytes) || 0, storageFree: Number(g.freeStorageSpaceInBytes) || 0, ramBytes: Number(g.physicalMemoryInBytes) || 0,
      lastSync: g.lastSyncDateTime && !String(g.lastSyncDateTime).startsWith('0001') ? String(g.lastSyncDateTime) : '',
      compliance: String(g.complianceState || 'unknown'), encrypted: typeof g.isEncrypted === 'boolean' ? g.isEncrypted : '',
      enrolledAt: String(g.enrolledDateTime || ''), owner: String(g.managedDeviceOwnerType || ''), m365Version: m365.get(g.id) || '',
      firstSeenAt: old?.firstSeenAt || nowIso, osChangedAt: old?.osChangedAt || '', prevOsVersion: old?.prevOsVersion || ''
    };
    if (old && old.osVersion && old.osVersion !== osVersion) { row.prevOsVersion = old.osVersion; row.osChangedAt = nowIso; }
    await putRow('DeviceInventory', tenantId, id, row, 'Replace');
    merged.push({ rowKey: id, ...row });
  }
  for (const k of existing.keys()) if (!seen.has(k)) await deleteRow('DeviceInventory', tenantId, k).catch(() => {});

  // Freeze today's picture into the current Patch Tuesday cycle (the last sync inside a cycle is what stays).
  const c = cycleCompliance(merged, cycleFor(now), now);
  await putRow('CycleReports', tenantId, c.cycle, {
    label: c.label, start: c.start, end: c.end, devices: c.devices, compliant: c.compliant, pct: c.pct, stale: c.stale,
    m365Devices: c.m365Devices, m365Current: c.m365Current, updatedAt: nowIso,
    behind: JSON.stringify(c.rows.filter(r => !r.compliant).slice(0, 120).map(r => [r.name, r.user, r.windows, r.reason]))
  }, 'Replace');
  return { devices: merged.length };
}

export async function loadDevices(tenantId) { return listRows('DeviceInventory', tenantId, 20000); }

export async function loadCycles(tenantId) {
  const rows = await listRows('CycleReports', tenantId, 60);
  return rows.map(r => ({ cycle: r.rowKey, label: r.label, start: r.start, end: r.end, devices: Number(r.devices) || 0, compliant: Number(r.compliant) || 0, pct: Number(r.pct) || 0, stale: Number(r.stale) || 0,
    m365Devices: Number(r.m365Devices) || 0, m365Current: Number(r.m365Current) || 0, updatedAt: r.updatedAt || '',
    behind: (() => { try { return JSON.parse(r.behind || '[]'); } catch { return []; } })() })).sort((a, b) => b.cycle.localeCompare(a.cycle));
}
export { getRow, parseOs };
