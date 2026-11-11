// Table Storage access. Every record is partitioned by the client's tenant ID.
import { TableClient, odata } from '@azure/data-tables';
import { DefaultAzureCredential } from '@azure/identity';
import { createHash } from 'node:crypto';

const TABLES = ['Tenants', 'Inventory', 'SyncRuns', 'Members', 'AuditLog', 'PublishJobs', 'AcEvents', 'AcDecisions', 'AcDevices', 'Catalog', 'SalesLeads', 'AppRequests', 'SiteContent', 'InstallReports'];
const clients = {};
let credential;
let ready;

function table(name) {
  if (!clients[name]) {
    if (process.env.TABLES_CONNECTION) {
      clients[name] = TableClient.fromConnectionString(process.env.TABLES_CONNECTION, name, { allowInsecureConnection: true });
    } else {
      credential ??= new DefaultAzureCredential();
      clients[name] = new TableClient(process.env.TABLES_URL, name, credential);
    }
  }
  return clients[name];
}

async function ensureTables() {
  // Share table creation across concurrent requests, but don't cache a transient failure
  // forever: a cold-start storage outage must be recoverable without restarting the app.
  if (!ready) {
    ready = Promise.all(TABLES.map(n => table(n).createTable().catch(e => { if (e.statusCode !== 409) throw e; })))
      .catch(err => { ready = null; throw err; });
  }
  return ready;
}

// ---- Tenants (PartitionKey 'tenant', RowKey = tenant ID) ----
export async function getTenant(tenantId) {
  await ensureTables();
  try { return await table('Tenants').getEntity('tenant', tenantId); }
  catch (e) { if (e.statusCode === 404) return null; throw e; }
}

export async function saveTenant(tenantId, fields) {
  await ensureTables();
  await table('Tenants').upsertEntity({ partitionKey: 'tenant', rowKey: tenantId, ...fields }, 'Merge');
  return getTenant(tenantId);
}

export async function listAllTenants() {
  await ensureTables();
  const out = [];
  for await (const t of table('Tenants').listEntities({ queryOptions: { filter: odata`PartitionKey eq 'tenant'` } })) out.push(t);
  return out;
}

export async function listActiveTenants() {
  await ensureTables();
  const out = [];
  for await (const t of table('Tenants').listEntities({ queryOptions: { filter: odata`PartitionKey eq 'tenant' and status eq 'active'` } })) out.push(t);
  return out;
}

// ---- Inventory (PartitionKey = tenant ID, RowKey = hash of name + version) ----
const rowKey = (name, version) => createHash('sha1').update(`${name}|${version}`).digest('hex');

async function inBatches(client, actions) {
  for (let i = 0; i < actions.length; i += 100) await client.submitTransaction(actions.slice(i, i + 100));
}

export async function replaceInventory(tenantId, rows, syncId) {
  await ensureTables();
  const client = table('Inventory');
  const seen = new Set();
  const upserts = [];
  for (const r of rows) {
    const rk = rowKey(r.displayName, r.version);
    if (seen.has(rk)) continue;
    seen.add(rk);
    upserts.push(['upsert', { partitionKey: tenantId, rowKey: rk, displayName: r.displayName, publisher: r.publisher || '', version: r.version, deviceCount: r.deviceCount, platform: r.platform, syncId }, 'Replace']);
  }
  await inBatches(client, upserts);

  // Remove apps that are no longer installed anywhere.
  const stale = [];
  for await (const e of client.listEntities({ queryOptions: { filter: odata`PartitionKey eq ${tenantId}`, select: ['RowKey', 'syncId'] } })) {
    if (e.syncId !== syncId) stale.push(['delete', { partitionKey: tenantId, rowKey: e.rowKey }]);
  }
  await inBatches(client, stale);
}

export async function getInventory(tenantId) {
  await ensureTables();
  const out = [];
  const query = { filter: odata`PartitionKey eq ${tenantId}`, select: ['displayName', 'publisher', 'version', 'deviceCount'] };
  for await (const e of table('Inventory').listEntities({ queryOptions: query })) {
    out.push({ displayName: e.displayName, publisher: e.publisher || '', version: e.version, deviceCount: e.deviceCount });
  }
  return out;
}

// ---- Sync history (PartitionKey = tenant ID, RowKey = newest first) ----
export async function logSyncRun(tenantId, fields) {
  await ensureTables();
  const rk = String(9999999999999 - Date.now()).padStart(13, '0');
  await table('SyncRuns').upsertEntity({ partitionKey: tenantId, rowKey: rk, at: new Date().toISOString(), ...fields });
}

// ---- Members (PartitionKey = tenant ID) ----
// RowKey 'u_<object id>' for people who have signed in, 'i_<hash of email>' for pending invitations.
export const inviteKey = email => 'i_' + createHash('sha1').update(String(email).toLowerCase()).digest('hex');
export const memberKey = oid => 'u_' + oid;

export async function getMemberRow(tenantId, rowKey) {
  await ensureTables();
  try { return await table('Members').getEntity(tenantId, rowKey); }
  catch (e) { if (e.statusCode === 404) return null; throw e; }
}

export async function listMemberRows(tenantId) {
  await ensureTables();
  const out = [];
  for await (const m of table('Members').listEntities({ queryOptions: { filter: odata`PartitionKey eq ${tenantId}` } })) out.push(m);
  return out;
}

export async function saveMemberRow(tenantId, rowKey, fields) {
  await ensureTables();
  await table('Members').upsertEntity({ partitionKey: tenantId, rowKey, ...fields }, 'Merge');
  return getMemberRow(tenantId, rowKey);
}

export async function deleteMemberRow(tenantId, rowKey) {
  await ensureTables();
  await table('Members').deleteEntity(tenantId, rowKey);
}

// ---- Audit log (PartitionKey = tenant ID, newest first) ----
export async function audit(tenantId, actor, action, detail = '') {
  await ensureTables();
  const rk = String(9999999999999 - Date.now()).padStart(13, '0') + '_' + Math.random().toString(36).slice(2, 8);
  await table('AuditLog').upsertEntity({ partitionKey: tenantId, rowKey: rk, at: new Date().toISOString(), actor, action, detail: String(detail).slice(0, 500) });
}

export async function listAudit(tenantId, limit = 50) {
  await ensureTables();
  const out = [];
  for await (const e of table('AuditLog').listEntities({ queryOptions: { filter: odata`PartitionKey eq ${tenantId}` } })) {
    out.push({ at: e.at, actor: e.actor, action: e.action, detail: e.detail });
    if (out.length >= limit) break;
  }
  return out;
}

// ---- Publishing jobs (PartitionKey = tenant ID, RowKey = job ID) ----
export async function saveJob(tenantId, jobId, fields) {
  await ensureTables();
  await table('PublishJobs').upsertEntity({ partitionKey: tenantId, rowKey: jobId, ...fields }, 'Merge');
}
export async function getJob(tenantId, jobId) {
  await ensureTables();
  try { return await table('PublishJobs').getEntity(tenantId, jobId); }
  catch (e) { if (e.statusCode === 404) return null; throw e; }
}
export async function listJobs(tenantId, limit = 30) {
  await ensureTables();
  const out = [];
  for await (const j of table('PublishJobs').listEntities({ queryOptions: { filter: odata`PartitionKey eq ${tenantId}`, select: ['RowKey', 'status', 'appName', 'version', 'summary', 'appId', 'createdBy', 'createdAt', 'finishedAt', 'error', 'step'] } })) out.push(j);
  return out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, limit);
}

// ---- App Control events, decisions and reporting devices (PartitionKey = tenant ID) ----
export async function getRow(name, tenantId, rowKey) {
  await ensureTables();
  try { return await table(name).getEntity(tenantId, rowKey); }
  catch (e) { if (e.statusCode === 404) return null; throw e; }
}
export async function putRow(name, tenantId, rowKey, fields, mode = 'Merge') {
  await ensureTables();
  await table(name).upsertEntity({ partitionKey: tenantId, rowKey, ...fields }, mode);
}
export async function deleteRow(name, tenantId, rowKey) {
  await ensureTables();
  try { await table(name).deleteEntity(tenantId, rowKey); } catch (e) { if (e.statusCode !== 404) throw e; }
}
export async function listRows(name, tenantId, limit = 2000) {
  await ensureTables();
  const out = [];
  for await (const r of table(name).listEntities({ queryOptions: { filter: odata`PartitionKey eq ${tenantId}` } })) { out.push(r); if (out.length >= limit) break; }
  return out;
}
