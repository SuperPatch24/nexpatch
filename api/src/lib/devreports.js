// Device report logic. Pure functions only (no Azure, no Graph) so everything here is unit-tested.
// Devices come from Intune managed devices; see devices.js for the sync that stores them.

const GB = 1024 ** 3;
export const LOW_STORAGE_PCT = 15;       // % free below this is "low"
export const LOW_STORAGE_GB = 20;        // or less than this many GB free
export const LOW_MEMORY_GB = 8;          // below this is "low memory"
export const STALE_DAYS = 30;            // no check-in for this long is "stale"

// ---- Windows builds ----
const FEATURE = {
  19044: 'Windows 10 21H2', 19045: 'Windows 10 22H2',
  22000: 'Windows 11 21H2', 22621: 'Windows 11 22H2', 22631: 'Windows 11 23H2',
  26100: 'Windows 11 24H2', 26200: 'Windows 11 25H2'
};
// "10.0.22631.4037" -> { build: 22631, revision: 4037 }
export function parseOs(osVersion) {
  const m = String(osVersion || '').match(/^\d+\.\d+\.(\d+)(?:\.(\d+))?/);
  if (!m) return { build: 0, revision: 0, label: 'Unknown' };
  const build = Number(m[1]), revision = Number(m[2] || 0);
  return { build, revision, label: FEATURE[build] || (build >= 22000 ? `Windows 11 (build ${build})` : `Windows 10 (build ${build})`) };
}

// Compares dotted versions numerically: "16.0.17328.20162" vs "16.0.17231.20236".
export function cmpVersion(a, b) {
  const x = String(a || '').split('.').map(n => parseInt(n, 10) || 0), y = String(b || '').split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d < 0 ? -1 : 1; }
  return 0;
}

// ---- Patch Tuesday cycles ----
// Patch Tuesday is the second Tuesday of the month. A cycle runs from one Patch Tuesday to the next.
export function patchTuesday(year, month /* 0-11 */) {
  const first = new Date(Date.UTC(year, month, 1)).getUTCDay();          // 0 = Sunday
  return new Date(Date.UTC(year, month, 1 + ((2 - first + 7) % 7) + 7));
}
export function cycleFor(now = new Date()) {
  const d = new Date(now), y = d.getUTCFullYear(), m = d.getUTCMonth();
  const thisPt = patchTuesday(y, m);
  const start = d >= thisPt ? thisPt : patchTuesday(m ? y : y - 1, (m + 11) % 12);
  const nm = start.getUTCMonth() + 1, end = patchTuesday(start.getUTCFullYear() + (nm > 11 ? 1 : 0), nm % 12);
  const key = start.toISOString().slice(0, 10);
  return { key, start: start.toISOString(), end: end.toISOString(), label: 'Patch Tuesday ' + start.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) };
}

const gb = bytes => (bytes ? Math.round(bytes / GB * 10) / 10 : 0);
const days = (iso, now) => (iso ? Math.floor((now - Date.parse(iso)) / 86400000) : null);

// Turns a stored device row into the shape every report uses.
export function shapeDevice(r, now = new Date()) {
  const os = parseOs(r.osVersion), total = Number(r.storageTotal) || 0, free = Number(r.storageFree) || 0, ram = Number(r.ramBytes) || 0;
  const idle = days(r.lastSync, now);
  return {
    id: r.rowKey || r.id || '', name: r.name || '', user: r.user || '', manufacturer: r.manufacturer || '', model: r.model || '', serial: r.serial || '',
    osVersion: r.osVersion || '', osLabel: os.label, build: os.build, revision: os.revision,
    ramGb: gb(ram), storageGb: gb(total), freeGb: gb(free), freePct: total ? Math.round(free / total * 100) : null,
    lastSync: r.lastSync || '', idleDays: idle, stale: idle != null && idle >= STALE_DAYS,
    compliance: r.compliance || 'unknown', encrypted: r.encrypted === true || r.encrypted === 'true' ? true : (r.encrypted === false || r.encrypted === 'false' ? false : null),
    owner: r.owner || '', enrolledAt: r.enrolledAt || '', m365Version: r.m365Version || '',
    firstSeenAt: r.firstSeenAt || '', osChangedAt: r.osChangedAt || '', prevOsVersion: r.prevOsVersion || ''
  };
}

export const isLowStorage = d => d.storageGb > 0 && (d.freePct < LOW_STORAGE_PCT || d.freeGb < LOW_STORAGE_GB);
export const isLowMemory = d => d.ramGb > 0 && d.ramGb < LOW_MEMORY_GB;

// Newest revision seen in the fleet for each Windows build. "Up to date" is measured against this,
// so it is a relative measure: it tells you who is behind your own fleet, not behind Microsoft.
export function newestRevisions(devs) {
  const m = new Map();
  for (const d of devs) if (d.build && d.revision > (m.get(d.build) || 0)) m.set(d.build, d.revision);
  return m;
}
export function newestM365(devs) { return devs.reduce((best, d) => (d.m365Version && cmpVersion(d.m365Version, best) > 0 ? d.m365Version : best), ''); }

// ---- Report tables (each one: head + rows, ready for CSV or a table) ----
const yn = v => (v === true ? 'Yes' : v === false ? 'No' : 'Unknown');
export function buildReports(rawRows, now = new Date()) {
  const devs = rawRows.map(r => shapeDevice(r, now));
  const newest = newestRevisions(devs), m365Latest = newestM365(devs);
  const behind = d => d.build && d.revision < (newest.get(d.build) || 0);

  const hardware = { head: ['Device', 'User', 'Manufacturer', 'Model', 'Serial', 'Windows', 'OS version', 'Memory (GB)', 'Storage (GB)', 'Free (GB)', 'Free %', 'Last check-in', 'Days idle'],
    rows: devs.map(d => [d.name, d.user, d.manufacturer, d.model, d.serial, d.osLabel, d.osVersion, d.ramGb, d.storageGb, d.freeGb, d.freePct ?? '', d.lastSync.slice(0, 10), d.idleDays ?? '']) };
  const lowStorage = { head: ['Device', 'User', 'Storage (GB)', 'Free (GB)', 'Free %', 'Model'],
    rows: devs.filter(isLowStorage).sort((a, b) => a.freePct - b.freePct).map(d => [d.name, d.user, d.storageGb, d.freeGb, d.freePct, d.model]) };
  const lowMemory = { head: ['Device', 'User', 'Memory (GB)', 'Model', 'Windows'],
    rows: devs.filter(isLowMemory).sort((a, b) => a.ramGb - b.ramGb).map(d => [d.name, d.user, d.ramGb, d.model, d.osLabel]) };
  const stale = { head: ['Device', 'User', 'Last check-in', 'Days idle', 'Model'],
    rows: devs.filter(d => d.stale || !d.lastSync).sort((a, b) => (b.idleDays ?? 9999) - (a.idleDays ?? 9999)).map(d => [d.name, d.user, d.lastSync.slice(0, 10), d.idleDays ?? '', d.model]) };

  const byOs = new Map();
  for (const d of devs) { const k = d.osLabel; const o = byOs.get(k) || { devices: 0, behind: 0 }; o.devices++; if (behind(d)) o.behind++; byOs.set(k, o); }
  const windows = { head: ['Windows version', 'Devices', '% of fleet', 'Behind newest update', 'Newest build seen'],
    rows: [...byOs.entries()].sort((a, b) => b[1].devices - a[1].devices).map(([k, o]) => {
      const sample = devs.find(d => d.osLabel === k); const nr = newest.get(sample.build);
      return [k, o.devices, devs.length ? Math.round(o.devices / devs.length * 100) : 0, o.behind, nr ? `${sample.build}.${nr}` : ''];
    }) };

  const security = { head: ['Device', 'User', 'Intune compliance', 'Encrypted', 'Windows', 'Last check-in'],
    rows: devs.filter(d => d.compliance !== 'compliant' || d.encrypted === false).map(d => [d.name, d.user, d.compliance, yn(d.encrypted), d.osLabel, d.lastSync.slice(0, 10)]) };

  const m365Devs = devs.filter(d => d.m365Version);
  const m365 = { head: ['Device', 'User', 'Microsoft 365 Apps version', 'Status', 'Newest in fleet', 'Last check-in'],
    rows: m365Devs.sort((a, b) => cmpVersion(a.m365Version, b.m365Version)).map(d => [d.name, d.user, d.m365Version, cmpVersion(d.m365Version, m365Latest) >= 0 ? 'Current' : 'Behind', m365Latest, d.lastSync.slice(0, 10)]) };
  const byM365 = new Map(); for (const d of m365Devs) byM365.set(d.m365Version, (byM365.get(d.m365Version) || 0) + 1);
  const m365Versions = { head: ['Version', 'Devices', '% of devices with M365 Apps', 'Status'],
    rows: [...byM365.entries()].sort((a, b) => cmpVersion(b[0], a[0])).map(([v, n]) => [v, n, Math.round(n / m365Devs.length * 100), cmpVersion(v, m365Latest) >= 0 ? 'Current' : 'Behind']) };

  const total = devs.length;
  const summary = {
    devices: total,
    avgMemoryGb: total ? Math.round(devs.reduce((n, d) => n + d.ramGb, 0) / total * 10) / 10 : 0,
    totalStorageTb: Math.round(devs.reduce((n, d) => n + d.storageGb, 0) / 1024 * 10) / 10,
    lowStorage: lowStorage.rows.length, lowMemory: lowMemory.rows.length, stale: stale.rows.length,
    notCompliant: devs.filter(d => d.compliance !== 'compliant').length, notEncrypted: devs.filter(d => d.encrypted === false).length,
    behindOnUpdates: devs.filter(behind).length,
    m365Devices: m365Devs.length, m365Behind: m365Devs.filter(d => cmpVersion(d.m365Version, m365Latest) < 0).length, m365Newest: m365Latest
  };
  return { summary, reports: { hardware, lowStorage, lowMemory, stale, windows, security, m365, m365Versions } };
}

// ---- Patch Tuesday cycle compliance ----
// A device is compliant for a cycle when its Windows build advanced during the cycle (that month's update was installed),
// or it joined during the cycle already on the newest revision in the fleet. Devices with no check-in for 30 days are
// reported as "No check-in". The measure is relative to your own fleet because Intune does not publish "latest" per device.
export function cycleCompliance(rawRows, cycle, now = new Date()) {
  const devs = rawRows.map(r => shapeDevice(r, now)), newest = newestRevisions(devs), m365Latest = newestM365(devs);
  const s = Date.parse(cycle.start), e = Date.parse(cycle.end);
  const inCycle = iso => iso && Date.parse(iso) >= s && Date.parse(iso) < e;
  const rows = [];
  let compliant = 0;
  for (const d of devs) {
    let ok = false, reason = '';
    const upToDate = d.build && d.revision >= (newest.get(d.build) || 0);
    const advanced = inCycle(d.osChangedAt) && parseOsCmp(d.prevOsVersion, d.osVersion) < 0;
    if (advanced) { ok = true; reason = 'Installed this cycle’s update'; }
    else if (inCycle(d.firstSeenAt) && upToDate) { ok = true; reason = 'Joined this cycle, already up to date'; }
    else if (d.stale) reason = 'No check-in for ' + STALE_DAYS + '+ days';
    else reason = 'Update not installed yet';
    if (ok) compliant++;
    rows.push({ name: d.name, user: d.user, windows: d.osLabel, osVersion: d.osVersion, compliant: ok, reason, lastSync: d.lastSync.slice(0, 10) });
  }
  const total = rows.length;
  const m365 = devs.filter(d => d.m365Version);
  return {
    cycle: cycle.key, label: cycle.label, start: cycle.start, end: cycle.end,
    devices: total, compliant, pct: total ? Math.round(compliant / total * 1000) / 10 : 0,
    stale: rows.filter(r => r.reason.startsWith('No check-in')).length,
    m365Devices: m365.length, m365Current: m365.filter(d => cmpVersion(d.m365Version, m365Latest) >= 0).length,
    rows: rows.sort((a, b) => Number(a.compliant) - Number(b.compliant) || a.name.localeCompare(b.name))
  };
}
function parseOsCmp(a, b) { const x = parseOs(a), y = parseOs(b); return x.build !== y.build ? (x.build < y.build ? -1 : 1) : (x.revision === y.revision ? 0 : x.revision < y.revision ? -1 : 1); }

// ---- CSV ----
export function toCsv(head, rows) {
  const cell = v => { let s = String(v ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };   // also blocks spreadsheet formula injection
  return '﻿' + [head, ...rows].map(r => r.map(cell).join(',')).join('\r\n');
}
