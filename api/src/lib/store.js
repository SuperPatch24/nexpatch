// Table Storage access. Every record is partitioned by the client's tenant ID.
import { TableClient, odata } from '@azure/data-tables';
import { DefaultAzureCredential } from '@azure/identity';
import { createHash } from 'node:crypto';

const TABLES = ['Tenants', 'Inventory', 'SyncRuns'];
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
  ready ??= Promise.all(TABLES.map(n => table(n).createTable().catch(e => { if (e.statusCode !== 409) throw e; })));
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
    upserts.push(['upsert', { partitionKey: tenantId, rowKey: rk, displayName: r.displayName, version: r.version, deviceCount: r.deviceCount, platform: r.platform, syncId }, 'Replace']);
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
  const query = { filter: odata`PartitionKey eq ${tenantId}`, select: ['displayName', 'version', 'deviceCount'] };
  for await (const e of table('Inventory').listEntities({ queryOptions: query })) {
    out.push({ displayName: e.displayName, version: e.version, deviceCount: e.deviceCount });
  }
  return out;
}

// ---- Sync history (PartitionKey = tenant ID, RowKey = newest first) ----
export async function logSyncRun(tenantId, fields) {
  await ensureTables();
  const rk = String(9999999999999 - Date.now()).padStart(13, '0');
  await table('SyncRuns').upsertEntity({ partitionKey: tenantId, rowKey: rk, at: new Date().toISOString(), ...fields });
}
