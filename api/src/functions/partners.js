import { app } from '@azure/functions';
import { withUser, HttpError, readJson } from '../lib/http.js';
import { getTenant, saveTenant, getRow, putRow, deleteRow, listRows, listJobs, audit } from '../lib/store.js';
import { ACCESS, INVITE_DAYS, newInviteCode, codeHash, looksLikeCode, cleanAccess, customerSummary } from '../lib/partners.js';
import { deviceHealth } from '../lib/deviceagent.js';

const NO_PARTNER = { partner: false };                // these are about the signed-in person's own organization
const L = 'PartnerLinks', OF = 'PartnerOf', INV = 'PartnerInvites';
const by = user => user.email || user.userId;
const parse = (v, d) => { try { return v ? JSON.parse(v) : d; } catch { return d; } };
async function ownTenant(user) {
  const t = await getTenant(user.tenantId);
  if (!t || t.status !== 'active') throw new HttpError(409, 'Connect your organization first.');
  return t;
}

// ---- Partner side -------------------------------------------------------------------------------------------------

// A one-time code the partner gives to a customer. Valid 7 days; only its hash is stored.
app.http('partnerInviteCreate', { methods: ['POST'], authLevel: 'anonymous', route: 'partner/invites',
  handler: withUser(async (req, _c, user) => {
    const t = await ownTenant(user);
    const b = await readJson(req).catch(() => ({}));
    const pending = (await listRows(INV, 'code', 5000)).filter(r => r.mspTenantId === user.tenantId && !r.usedAt && Date.parse(r.expiresAt) > Date.now());
    if (pending.length >= 25) throw new HttpError(429, 'You have 25 open invitations. Wait for some to be used or remove them.');
    const code = newInviteCode(), expiresAt = new Date(Date.now() + INVITE_DAYS * 864e5).toISOString();
    await putRow(INV, 'code', codeHash(code), { mspTenantId: user.tenantId, mspName: t.name || '', note: String(b.note || '').slice(0, 120), createdBy: by(user), createdAt: new Date().toISOString(), expiresAt });
    if (t.isPartner !== true && t.isPartner !== 'true') await saveTenant(user.tenantId, { isPartner: true });
    await audit(user.tenantId, by(user), 'created partner invitation', String(b.note || '').slice(0, 120));
    return { code, expiresAt };
  }, 'owner', NO_PARTNER) });

app.http('partnerInviteList', { methods: ['GET'], authLevel: 'anonymous', route: 'partner/invites',
  handler: withUser(async (_r, _c, user) => ({ invites: (await listRows(INV, 'code', 5000)).filter(r => r.mspTenantId === user.tenantId && !r.usedAt)
    .map(r => ({ id: r.rowKey.slice(0, 16), note: r.note || '', createdBy: r.createdBy, createdAt: r.createdAt, expiresAt: r.expiresAt, expired: Date.parse(r.expiresAt) <= Date.now() }))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))) }), 'owner', NO_PARTNER) });

app.http('partnerInviteDelete', { methods: ['DELETE'], authLevel: 'anonymous', route: 'partner/invites/{id}',
  handler: withUser(async (req, _c, user) => {
    const id = String(req.params.id || '');
    const r = (await listRows(INV, 'code', 5000)).find(x => x.mspTenantId === user.tenantId && x.rowKey.startsWith(id) && id.length === 16);
    if (!r) throw new HttpError(404, 'That invitation wasn’t found.');
    await deleteRow(INV, 'code', r.rowKey);
    return { ok: true };
  }, 'owner', NO_PARTNER) });

// The partner's overview of every customer it manages, built from stored data (fast, no calls to Microsoft).
app.http('partnerCustomers', { methods: ['GET'], authLevel: 'anonymous', route: 'partner/customers',
  handler: withUser(async (_r, _c, user) => {
    const links = (await listRows(L, user.tenantId, 1000)).filter(l => l.status === 'active');
    const since = Date.now() - 30 * 864e5;
    const customers = await Promise.all(links.map(async l => {
      const [t, inv, agents, jobs] = await Promise.all([getTenant(l.rowKey), listRows('Inventory', l.rowKey, 20000), listRows('AgentDevices', l.rowKey, 5000), listJobs(l.rowKey, 500)]);
      const recent = jobs.filter(j => Date.parse(j.createdAt || 0) >= since);
      const live = agents.filter(a => a.status !== 'revoked');
      const agentAttention = live.filter(a => deviceHealth({ ...a, health: parse(a.health, {}), device: parse(a.device, {}) }).status !== 'healthy').length;
      return customerSummary(l, t, { devices: inv.reduce((m, x) => Math.max(m, Number(x.deviceCount) || 0), 0), agentDevices: live.length, agentAttention,
        failedPublishes: recent.filter(j => j.status === 'failed').length, succeededPublishes: recent.filter(j => j.status === 'succeeded').length });
    }));
    customers.sort((a, b) => (a.status === b.status ? 0 : a.status === 'attention' ? -1 : 1) || (b.vulnerabilities?.knownExploited || 0) - (a.vulnerabilities?.knownExploited || 0) || a.name.localeCompare(b.name));
    const sum = k => customers.reduce((n, c) => n + (k(c) || 0), 0);
    return { customers, totals: { customers: customers.length, needAttention: customers.filter(c => c.status === 'attention').length, devices: sum(c => c.devices),
      knownExploited: sum(c => c.vulnerabilities?.knownExploited), critical: sum(c => c.vulnerabilities?.critical), failedPublishes: sum(c => c.publishing.failed30d) } };
  }, 'viewer', NO_PARTNER) });

async function unlink(mspId, customerId) {
  await deleteRow(L, mspId, customerId).catch(() => {});
  await deleteRow(OF, customerId, mspId).catch(() => {});
}
app.http('partnerCustomerRemove', { methods: ['DELETE'], authLevel: 'anonymous', route: 'partner/customers/{id}',
  handler: withUser(async (req, _c, user) => {
    const id = String(req.params.id || '').toLowerCase(), l = await getRow(L, user.tenantId, id);
    if (!l) throw new HttpError(404, 'That customer wasn’t found.');
    await unlink(user.tenantId, id);
    await audit(user.tenantId, by(user), 'stopped managing customer', l.customerName || id);
    await audit(id, by(user), 'partner stopped managing this organization', l.mspName || user.tenantId);
    return { ok: true };
  }, 'owner', NO_PARTNER) });

// ---- Customer side ------------------------------------------------------------------------------------------------

// The customer's owner enters the partner's code and chooses what the partner may do.
app.http('partnerAccept', { methods: ['POST'], authLevel: 'anonymous', route: 'partner/accept',
  handler: withUser(async (req, _c, user) => {
    const t = await ownTenant(user), b = await readJson(req);
    if (!looksLikeCode(b.code)) throw new HttpError(400, 'Enter the code your IT partner gave you, like NXP-ABCD-EFGH-JKLM.');
    const inv = await getRow(INV, 'code', codeHash(b.code));
    if (!inv || inv.usedAt) throw new HttpError(404, 'That code isn’t valid. Ask your IT partner for a new one.');
    if (Date.parse(inv.expiresAt) <= Date.now()) throw new HttpError(410, 'That code has expired. Ask your IT partner for a new one.');
    if (inv.mspTenantId === user.tenantId) throw new HttpError(400, 'That code is from your own organization.');
    const msp = await getTenant(inv.mspTenantId);
    if (!msp || msp.status !== 'active') throw new HttpError(409, 'The partner’s organization isn’t active.');
    const access = cleanAccess(b.access), now = new Date().toISOString();
    const row = { status: 'active', access, approvedBy: by(user), approvedAt: now, customerName: t.name || '', mspName: msp.name || inv.mspName || '' };
    await putRow(L, inv.mspTenantId, user.tenantId, row);
    await putRow(OF, user.tenantId, inv.mspTenantId, row);
    await putRow(INV, 'code', inv.rowKey, { usedAt: now, usedBy: user.tenantId });
    await audit(user.tenantId, by(user), 'approved IT partner', `${row.mspName} (${ACCESS[access]})`);
    await audit(inv.mspTenantId, by(user), 'customer approved partner access', `${row.customerName} (${ACCESS[access]})`);
    return { partner: { tenantId: inv.mspTenantId, name: row.mspName, access, accessName: ACCESS[access], since: now } };
  }, 'owner', NO_PARTNER) });

app.http('partnerManagers', { methods: ['GET'], authLevel: 'anonymous', route: 'partner/managers',
  handler: withUser(async (_r, _c, user) => ({ partners: (await listRows(OF, user.tenantId, 100)).filter(r => r.status === 'active')
    .map(r => ({ tenantId: r.rowKey, name: r.mspName || 'IT partner', access: r.access, accessName: ACCESS[r.access], since: r.approvedAt, approvedBy: r.approvedBy })) }), 'viewer', NO_PARTNER) });

app.http('partnerManagerUpdate', { methods: ['PUT'], authLevel: 'anonymous', route: 'partner/managers/{id}',
  handler: withUser(async (req, _c, user) => {
    const id = String(req.params.id || '').toLowerCase(), r = await getRow(OF, user.tenantId, id);
    if (!r) throw new HttpError(404, 'That partner wasn’t found.');
    const access = cleanAccess((await readJson(req)).access);
    await putRow(OF, user.tenantId, id, { access }); await putRow(L, id, user.tenantId, { access });
    await audit(user.tenantId, by(user), 'changed IT partner access', `${r.mspName}: ${ACCESS[access]}`);
    return { ok: true, access, accessName: ACCESS[access] };
  }, 'owner', NO_PARTNER) });

app.http('partnerManagerRemove', { methods: ['DELETE'], authLevel: 'anonymous', route: 'partner/managers/{id}',
  handler: withUser(async (req, _c, user) => {
    const id = String(req.params.id || '').toLowerCase(), r = await getRow(OF, user.tenantId, id);
    if (!r) throw new HttpError(404, 'That partner wasn’t found.');
    await unlink(id, user.tenantId);
    await audit(user.tenantId, by(user), 'removed IT partner', r.mspName || id);
    await audit(id, by(user), 'customer removed partner access', r.customerName || user.tenantId);
    return { ok: true };
  }, 'owner', NO_PARTNER) });
