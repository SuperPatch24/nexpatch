import { app } from '@azure/functions';
import ExcelJS from 'exceljs';
import { withUser, HttpError } from '../lib/http.js';
import { listRows, listAllTenants } from '../lib/store.js';
import { platformRole } from '../lib/platform.js';

const norm = value => String(value || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '');
function parseRequest(job) { try { return JSON.parse(job.request || '{}'); } catch { return {}; } }

async function collect(user) {
  if (!['superadmin', 'support'].includes(platformRole(user))) throw new HttpError(403, 'Your platform role cannot access platform reports.');
  const [catalog, tenants] = await Promise.all([listRows('Catalog', 'global', 5000), listAllTenants()]);
  const requests = [], tenantRows = [], jobs = [], inventories = [], installReports = [];
  for (const t of tenants) {
    const [rs, js, inv, ir] = await Promise.all([
      listRows('AppRequests', t.rowKey, 1000), listRows('PublishJobs', t.rowKey, 2000),
      listRows('Inventory', t.rowKey, 20000), listRows('InstallReports', t.rowKey, 5000)
    ]);
    for (const r of rs) requests.push({ tenantId: t.rowKey, id: r.rowKey, name: r.name, publisher: r.publisher || '', version: r.version || '', architecture: r.architecture || 'unknown', status: r.status || 'submitted', createdAt: r.createdAt || '', updatedAt: r.updatedAt || '', fileName: r.fileName || '', scanStatus: r.scanStatus || 'not-uploaded' });
    for (const j of js) {
      const request = parseRequest(j);
      const source = j.source || request.app?.source || 'winget';
      const operationType = j.operationType || (request.options?.updateOnly ? 'update' : 'deployment');
      jobs.push({ tenantId: t.rowKey, id: j.rowKey, appName: j.appName || '', source, operationType, status: j.status || 'unknown', version: j.version || '', createdAt: j.createdAt || '', finishedAt: j.finishedAt || '', error: j.error || '', step: j.step || '', createdBy: j.createdBy || '' });
    }
    for (const x of inv) inventories.push({ tenantId: t.rowKey, name: x.displayName || '', publisher: x.publisher || '', version: x.version || '', deviceCount: Number(x.deviceCount) || 0 });
    for (const x of ir) installReports.push({ tenantId: t.rowKey, app: x.app || '', version: x.version || '', installed: Number(x.installed) || 0, pending: Number(x.pending) || 0, failed: Number(x.failed) || 0, other: Number(x.other) || 0, errors: (() => { try { return JSON.parse(x.errors || '[]'); } catch { return []; } })(), importedAt: x.importedAt || '' });
    tenantRows.push({ tenantId: t.rowKey, status: t.status || '', plan: t.plan || 'trial', activatedAt: t.activatedAt || '', lastSyncAt: t.lastSyncAt || '', lastSyncError: t.lastSyncError || '' });
  }

  const apps = catalog.map(a => ({
    id: a.rowKey, name: a.name || '', publisher: a.vendor || '', source: a.source === 'msstore' ? 'Microsoft Store' : 'WinGet',
    wingetId: a.winget || '', storeProductId: a.storeProductId || '', storeUrl: a.appStoreUrl || '',
    verificationStatus: a.verificationStatus || (a.source === 'msstore' ? 'candidate' : 'verified'),
    category: a.category || '', enabled: a.enabled !== false, deployable: a.source === 'msstore' ? !!(a.storeProductId && a.appStoreUrl && a.verificationStatus === 'verified') : !!a.winget,
    updatedAt: a.updatedAt || ''
  }));

  const catalogKeys = new Set();
  for (const a of catalog) { catalogKeys.add(norm(a.name)); catalogKeys.add(norm(a.reg)); }
  const gapMap = new Map();
  for (const x of inventories) {
    const key = norm(x.name);
    if (!key || catalogKeys.has(key)) continue;
    if (!gapMap.has(key)) gapMap.set(key, { name: x.name, publisher: x.publisher, tenants: new Set(), deviceCount: 0, versions: new Set() });
    const gap = gapMap.get(key); gap.tenants.add(x.tenantId); gap.deviceCount += x.deviceCount;
    if (x.version) gap.versions.add(x.version);
    if (!gap.publisher && x.publisher) gap.publisher = x.publisher;
  }
  const catalogGaps = [...gapMap.values()].map(x => ({ name: x.name, publisher: x.publisher, tenantCount: x.tenants.size, deviceCount: x.deviceCount, versions: [...x.versions].join(', ') }))
    .sort((a, b) => b.deviceCount - a.deviceCount || a.name.localeCompare(b.name));

  const byStatus = {}; for (const r of requests) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
  const byJobStatus = {}; for (const j of jobs) byJobStatus[j.status] = (byJobStatus[j.status] || 0) + 1;
  const byCatalogSource = { WinGet: apps.filter(a => a.source === 'WinGet').length, 'Microsoft Store': apps.filter(a => a.source === 'Microsoft Store').length };
  const failedUpdates = jobs.filter(j => j.status === 'failed' && j.operationType === 'update').length;
  const failedDeployments = jobs.filter(j => j.status === 'failed' && j.operationType !== 'update').length;
  const reportedInstallFailures = installReports.reduce((n, x) => n + x.failed, 0);
  const counts = {
    catalog: apps.length, enabledApps: apps.filter(a => a.enabled).length,
    wingetApps: byCatalogSource.WinGet, microsoftStoreApps: byCatalogSource['Microsoft Store'],
    verifiedStoreApps: apps.filter(a => a.source === 'Microsoft Store' && a.deployable).length,
    storeCandidates: apps.filter(a => a.source === 'Microsoft Store' && !a.deployable).length,
    organizations: tenantRows.length, requests: requests.length,
    pendingRequests: requests.filter(r => !['published', 'rejected'].includes(r.status)).length,
    failedUpdates, failedDeployments, reportedInstallFailures, catalogGaps: catalogGaps.length
  };
  return { generatedAt: new Date().toISOString(), counts, byStatus, byJobStatus, byCatalogSource, apps, requests, tenants: tenantRows, jobs: jobs.sort((a,b) => String(b.createdAt).localeCompare(String(a.createdAt))), installReports, catalogGaps };
}

app.http('platformReports', { methods: ['GET'], authLevel: 'anonymous', route: 'platform/reports', handler: withUser(async (_req, _ctx, user) => collect(user), 'any') });
app.http('platformReportsExcel', { methods: ['GET'], authLevel: 'anonymous', route: 'platform/reports.xlsx', handler: withUser(async (_req, _ctx, user) => {
  const data = await collect(user), wb = new ExcelJS.Workbook(); wb.creator = 'NexpatchOnline'; wb.created = new Date();
  const summary = wb.addWorksheet('Summary');
  summary.addRows([['NexpatchOnline platform report'], ['Generated', data.generatedAt], [], ['Metric', 'Count'], ...Object.entries(data.counts).map(([k,v]) => [k,v]), [], ['Catalog source','Count'], ...Object.entries(data.byCatalogSource), [], ['Request status','Count'], ...Object.entries(data.byStatus), [], ['Publishing job status','Count'], ...Object.entries(data.byJobStatus)]);
  summary.getRow(1).font = { bold: true, size: 16 }; summary.getColumn(1).width = 34; summary.getColumn(2).width = 28;
  const cat = wb.addWorksheet('Catalog');
  cat.columns = [{header:'ID',key:'id',width:32},{header:'Application',key:'name',width:32},{header:'Publisher',key:'publisher',width:28},{header:'Source',key:'source',width:20},{header:'WinGet ID',key:'wingetId',width:32},{header:'Store product ID',key:'storeProductId',width:22},{header:'Verification',key:'verificationStatus',width:18},{header:'Deployable',key:'deployable',width:12},{header:'Category',key:'category',width:20},{header:'Enabled',key:'enabled',width:12},{header:'Updated',key:'updatedAt',width:26}];
  cat.addRows(data.apps); cat.getRow(1).font = {bold:true}; cat.autoFilter = 'A1:K1';
  const req = wb.addWorksheet('Client requests');
  req.columns = [{header:'Organization ID',key:'tenantId',width:38},{header:'Request ID',key:'id',width:38},{header:'Application',key:'name',width:30},{header:'Publisher',key:'publisher',width:25},{header:'Version',key:'version',width:16},{header:'Architecture',key:'architecture',width:16},{header:'Status',key:'status',width:20},{header:'Submitted',key:'createdAt',width:26},{header:'Installer',key:'fileName',width:30},{header:'Scan status',key:'scanStatus',width:18}];
  req.addRows(data.requests); req.getRow(1).font = {bold:true}; req.autoFilter = 'A1:J1';
  const org = wb.addWorksheet('Organizations');
  org.columns = [{header:'Tenant ID',key:'tenantId',width:40},{header:'Status',key:'status',width:16},{header:'Plan',key:'plan',width:16},{header:'Activated',key:'activatedAt',width:26},{header:'Last sync',key:'lastSyncAt',width:26},{header:'Last sync error',key:'lastSyncError',width:48}];
  org.addRows(data.tenants); org.getRow(1).font = {bold:true}; org.autoFilter = 'A1:F1';
  const job = wb.addWorksheet('Publishing jobs');
  job.columns = [{header:'Organization ID',key:'tenantId',width:38},{header:'Job ID',key:'id',width:38},{header:'App',key:'appName',width:30},{header:'Source',key:'source',width:18},{header:'Operation',key:'operationType',width:16},{header:'Status',key:'status',width:16},{header:'Created',key:'createdAt',width:26},{header:'Finished',key:'finishedAt',width:26},{header:'Error',key:'error',width:60}];
  job.addRows(data.jobs); job.getRow(1).font = {bold:true}; job.autoFilter = 'A1:I1';
  const installs = wb.addWorksheet('Install results');
  installs.columns = [{header:'Organization ID',key:'tenantId',width:38},{header:'App',key:'app',width:30},{header:'Version',key:'version',width:18},{header:'Installed',key:'installed',width:12},{header:'Pending',key:'pending',width:12},{header:'Failed',key:'failed',width:12},{header:'Other',key:'other',width:12},{header:'Imported',key:'importedAt',width:26}];
  installs.addRows(data.installReports); installs.getRow(1).font = {bold:true}; installs.autoFilter = 'A1:H1';
  const gaps = wb.addWorksheet('Catalog gaps');
  gaps.columns = [{header:'Application found in tenant inventory',key:'name',width:42},{header:'Publisher',key:'publisher',width:30},{header:'Organizations',key:'tenantCount',width:16},{header:'Device installs',key:'deviceCount',width:18},{header:'Versions seen',key:'versions',width:38}];
  gaps.addRows(data.catalogGaps); gaps.getRow(1).font = {bold:true}; gaps.autoFilter = 'A1:E1';
  const charts = wb.addWorksheet('Visual summary');
  charts.columns = [{header:'Report',key:'report',width:30},{header:'Category',key:'category',width:30},{header:'Count',key:'count',width:14},{header:'Visual',key:'visual',width:54}];
  const addBars = (report, entries) => {
    const values = Object.entries(entries || {}); const max = Math.max(1, ...values.map(([,v]) => Number(v) || 0));
    for (const [category, value] of values) charts.addRow({report, category, count:Number(value)||0, visual:'█'.repeat(Math.max(0, Math.round((Number(value)||0) / max * 40)))});
  };
  addBars('Catalog by source', data.byCatalogSource);
  addBars('Publishing failures', { 'Failed updates': data.counts.failedUpdates, 'Failed deployments': data.counts.failedDeployments });
  addBars('Client requests', data.byStatus);
  addBars('Intune install results', data.installReports.reduce((o,x)=>{ o.Installed=(o.Installed||0)+x.installed; o.Pending=(o.Pending||0)+x.pending; o.Failed=(o.Failed||0)+x.failed; return o; }, {}));
  addBars('Top catalog gaps', Object.fromEntries(data.catalogGaps.slice(0,20).map(x=>[x.name,x.deviceCount])));
  charts.getRow(1).font = {bold:true};
  const buf = await wb.xlsx.writeBuffer();
  return { filename:'nexpatch-platform-report-'+new Date().toISOString().slice(0,10)+'.xlsx', contentType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', base64:Buffer.from(buf).toString('base64') };
}, 'any') });
