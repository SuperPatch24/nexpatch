import { app } from '@azure/functions';
import ExcelJS from 'exceljs';
import { withUser, HttpError } from '../lib/http.js';
import { getTenant } from '../lib/store.js';
import { loadDevices, loadCycles } from '../lib/devices.js';
import { buildReports, cycleCompliance, cycleFor, toCsv } from '../lib/devreports.js';

const TITLES = { hardware: 'Hardware and storage', lowStorage: 'Low storage', lowMemory: 'Low memory', stale: 'No recent check-in', windows: 'Windows versions', security: 'Compliance and encryption', m365: 'Microsoft 365 Apps by device', m365Versions: 'Microsoft 365 Apps versions' };

async function data(user) {
  const t = await getTenant(user.tenantId);
  if (!t || t.status !== 'active') throw new HttpError(409, 'Your organization isn’t connected yet. Approve NexpatchOnline on the Connect page first.');
  const rows = await loadDevices(user.tenantId);
  const now = new Date(), live = cycleCompliance(rows.map(r => ({ ...r })), cycleFor(now), now);
  const stored = await loadCycles(user.tenantId);
  const cycles = [{ cycle: live.cycle, label: live.label, start: live.start, end: live.end, devices: live.devices, compliant: live.compliant, pct: live.pct, stale: live.stale, m365Devices: live.m365Devices, m365Current: live.m365Current, current: true }]
    .concat(stored.filter(c => c.cycle !== live.cycle).map(c => ({ ...c, current: false })));
  return { t, rows, now, live, stored, cycles, ...buildReports(rows, now) };
}

// GET /api/reports/devices – summary and every device report table, plus the Patch Tuesday cycles.
app.http('deviceReports', { methods: ['GET'], authLevel: 'anonymous', route: 'reports/devices', handler: withUser(async (_r, _c, user) => {
  const d = await data(user);
  return { syncedAt: d.t.lastDeviceSyncAt || null, syncError: d.t.lastDeviceSyncError || '', summary: d.summary, titles: TITLES, reports: d.reports,
    cycles: d.cycles.map(({ cycle, label, start, end, devices, compliant, pct, stale, m365Devices, m365Current, current }) => ({ cycle, label, start, end, devices, compliant, pct, stale, m365Devices, m365Current, current: !!current })),
    currentCycle: { ...d.cycles[0], rows: d.live.rows } };
}, 'viewer') });

// GET /api/reports/devices.xlsx – one workbook with every report on its own sheet.
app.http('deviceReportsXlsx', { methods: ['GET'], authLevel: 'anonymous', route: 'reports/devices.xlsx', handler: withUser(async (_r, _c, user) => {
  const d = await data(user), wb = new ExcelJS.Workbook(); wb.creator = 'NexpatchOnline'; wb.created = d.now;
  const sum = wb.addWorksheet('Summary');
  sum.addRows([['Device reports'], ['Generated', d.now.toISOString()], [], ['Metric', 'Value'], ...Object.entries(d.summary)]); sum.getRow(1).font = { bold: true, size: 16 }; sum.getColumn(1).width = 28; sum.getColumn(2).width = 24;
  const add = (name, head, rows) => { const ws = wb.addWorksheet(name.slice(0, 31)); ws.addRow(head).font = { bold: true }; for (const r of rows) ws.addRow(r.map(v => (typeof v === 'string' && /^[=+\-@]/.test(v) ? "'" + v : v))); ws.columns.forEach(c => { c.width = 18; }); if (rows.length) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: head.length } }; };
  for (const [k, v] of Object.entries(d.reports)) add(TITLES[k], v.head, v.rows);
  add('Patch Tuesday cycles', ['Cycle', 'Starts', 'Ends', 'Devices', 'Compliant', 'Compliance %', 'No check-in', 'M365 devices', 'M365 current'], d.cycles.map(c => [c.label, c.start.slice(0, 10), c.end.slice(0, 10), c.devices, c.compliant, c.pct, c.stale, c.m365Devices, c.m365Current]));
  add('Current cycle devices', ['Device', 'User', 'Windows', 'OS version', 'Compliant', 'Reason', 'Last check-in'], d.live.rows.map(r => [r.name, r.user, r.windows, r.osVersion, r.compliant ? 'Yes' : 'No', r.reason, r.lastSync]));
  return { filename: 'nexpatch-device-reports-' + d.now.toISOString().slice(0, 10) + '.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', base64: Buffer.from(await wb.xlsx.writeBuffer()).toString('base64') };
}, 'viewer') });

// GET /api/reports/device-csv/{name} - CSV text for one report or for a cycle's devices.
app.http('deviceReportCsv', { methods: ['GET'], authLevel: 'anonymous', route: 'reports/device-csv/{name}', handler: withUser(async (req, _c, user) => {
  const name = String(req.params.name || ''), d = await data(user);
  if (name === 'cycle') {
    const key = new URL(req.url).searchParams.get('cycle') || d.live.cycle;
    const head = ['Device', 'User', 'Windows', 'Reason'];
    if (key === d.live.cycle) return { filename: `patch-tuesday-${key}.csv`, csv: toCsv(['Device', 'User', 'Windows', 'OS version', 'Compliant', 'Reason', 'Last check-in'], d.live.rows.map(r => [r.name, r.user, r.windows, r.osVersion, r.compliant ? 'Yes' : 'No', r.reason, r.lastSync])) };
    const c = d.stored.find(x => x.cycle === key); if (!c) throw new HttpError(404, 'No report for that cycle.');
    return { filename: `patch-tuesday-${key}.csv`, csv: toCsv(head, c.behind) };
  }
  const rep = d.reports[name]; if (!rep) throw new HttpError(404, 'Unknown report.');
  return { filename: `nexpatch-${name}-${d.now.toISOString().slice(0, 10)}.csv`, csv: toCsv(rep.head, rep.rows) };
}, 'viewer') });
