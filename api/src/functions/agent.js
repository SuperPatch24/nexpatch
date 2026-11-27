import { app } from '@azure/functions';
import { readFile } from 'node:fs/promises';
import { withUser, HttpError, readJson, json } from '../lib/http.js';
import { getTenant, saveTenant, getRow, putRow, deleteRow, listRows, audit } from '../lib/store.js';
import { graph } from '../lib/graph.js';
import { planStatus } from '../lib/plan.js';
import { featureOn, featureMessage } from '../lib/tenantsettings.js';
import { LIMITS, newSecret, hashSecret, secretMatches, rateCheck } from '../lib/agentauth.js';
import { normalizeGroupInputs } from '../lib/acgroups.js';
import { AGENT_LIMITS, isGuid, cleanReport, deviceHealth, fleetReport, explainExit, toChunks, fromChunks, agentConfig } from '../lib/deviceagent.js';
import { AGENT_RELEASE } from '../lib/agentrelease.js';
import { publishAgent, AGENT_APP_NAME } from '../lib/agentpublish.js';

const T = 'AgentDevices';
const KEY_DAYS = 365;   // the key is inside the Intune package, so it has to outlive the package; republish to rotate it
const fail = (status, msg, extra) => json(status, { error: msg }, extra);
const rk = id => String(id || '').toLowerCase();
const intervals = () => ({ heartbeatSeconds: AGENT_LIMITS.heartbeatSeconds, fullSeconds: AGENT_LIMITS.fullSeconds });
const parse = (v, d) => { try { return v ? JSON.parse(v) : d; } catch { return d; } };

async function activeTenant(tid) {
  const t = await getTenant(tid);
  if (!t || t.status !== 'active') throw new HttpError(409, 'Connect your organization on the Connect page first.');
  return t;
}

// ---- Device side (no user sign-in: the enrollment key once, then the device's own token) ----------------------------

app.http('agentEnroll', { methods: ['POST'], authLevel: 'anonymous', route: 'agent/enroll',
  handler: async (req, context) => {
    try {
      const tid = req.headers.get('x-nexpatch-tenant') || '', key = req.headers.get('x-nexpatch-key') || '';
      if (!isGuid(tid) || !key) return fail(401, 'Missing tenant or key.');
      const t = await getTenant(tid);
      if (!t || t.status !== 'active') return fail(401, 'Unknown organization or key.');
      // Two keys: the one inside the Intune package, and a short-lived one for a manual test install.
      const pkgKey = secretMatches(t.agKeyHash, key), manualKey = !pkgKey && secretMatches(t.agManualKeyHash, key);
      if (!pkgKey && !manualKey) return fail(401, 'Unknown organization or key.');
      const exp = pkgKey ? t.agKeyExpiresAt : t.agManualKeyExpiresAt;
      if (!exp || Date.parse(exp) <= Date.now()) return fail(403, pkgKey ? 'The agent package has expired. Republish the agent from NexpatchOnline.' : 'This test configuration has expired. Download a new one from NexpatchOnline.');
      if (!featureOn(t, 'apps')) return fail(403, featureMessage('apps'));
      const text = await req.text();
      if (text.length > 4096) return fail(413, 'Request too large.');
      let body; try { body = JSON.parse(text); } catch { return fail(400, 'Body must be JSON.'); }
      const agentId = rk(body.agentId), intuneId = rk(body.intuneDeviceId);
      if (!isGuid(agentId)) return fail(400, 'Missing agent ID.');
      if (!isGuid(intuneId)) return fail(403, 'This device isn’t enrolled in Intune yet. The agent will retry.');
      const now = new Date();
      const tw = rateCheck({ enrollWindowStart: t.agEnrollWindowStart, enrollCount: t.agEnrollCount }, now, 0, 'enroll', { ...LIMITS, enrollsPerHour: LIMITS.tenantEnrollsPerHour });
      if (!tw.ok) return fail(429, 'Too many enrollments right now. The agent will retry.', { headers: { 'retry-after': String(tw.retryAfter) } });
      await saveTenant(tid, { agEnrollWindowStart: tw.patch.enrollWindowStart, agEnrollCount: tw.patch.enrollCount });
      // Only devices in this organization's own Intune list can enroll, so a leaked key can't register other PCs.
      const known = await getRow('DeviceInventory', tid, intuneId) || await getRow('DeviceInventory', tid, intuneId.toUpperCase());
      if (!known) return fail(403, 'This device isn’t in your organization’s Intune device list yet. The agent will retry after the next sync.');
      const existing = await getRow(T, tid, agentId);
      if (existing?.status === 'revoked') return fail(403, 'An admin revoked this device.');
      const dr = rateCheck(existing || {}, now, 0, 'enroll');
      if (!dr.ok) return fail(429, 'Too many enrollments for this device.', { headers: { 'retry-after': String(dr.retryAfter) } });
      // A reinstall gets a new agent ID: drop the old record for the same Intune device.
      for (const r of await listRows(T, tid, 5000)) if (r.rowKey !== agentId && r.intuneDeviceId === intuneId && r.status !== 'revoked') await deleteRow(T, tid, r.rowKey);
      const token = newSecret();
      await putRow(T, tid, agentId, { status: 'active', name: String(known.name || body.deviceName || '').slice(0, 100), intuneDeviceId: intuneId, tokenHash: hashSecret(token),
        enrolledAt: now.toISOString(), lastSeenAt: now.toISOString(), agentVersion: String(body.agentVersion || '').slice(0, 20), ...dr.patch });
      await audit(tid, `device ${known.name || intuneId}`, 'enrolled NexpatchOnline agent', intuneId);
      return json(200, { token, ...intervals() });
    } catch (err) { context.error('Agent enroll failed', err); return fail(500, 'Could not enroll the device.'); }
  } });

app.http('agentReport', { methods: ['POST'], authLevel: 'anonymous', route: 'agent/report',
  handler: async (req, context) => {
    try {
      const tid = req.headers.get('x-nexpatch-tenant') || '', id = rk(req.headers.get('x-nexpatch-agent')), token = req.headers.get('x-nexpatch-token') || '';
      if (!isGuid(tid) || !isGuid(id) || !token) return fail(401, 'Missing credentials.');
      const row = await getRow(T, tid, id);
      if (!row || !secretMatches(row.tokenHash, token)) return fail(401, 'Unknown device or token.');
      if (row.status === 'revoked') return fail(403, 'An admin revoked this device.');
      const t = await getTenant(tid);
      if (!t || t.status !== 'active') return fail(401, 'Unknown organization.');
      if (Number(req.headers.get('content-length') || 0) > AGENT_LIMITS.maxBody) return fail(413, 'Send at most 1 MB per report.');
      const text = await req.text();
      if (text.length > AGENT_LIMITS.maxBody) return fail(413, 'Send at most 1 MB per report.');
      let body; try { body = JSON.parse(text); } catch { return fail(400, 'Body must be JSON.'); }
      const now = new Date();
      const rc = rateCheck(row, now, 0);
      if (!rc.ok) return fail(429, 'This device is reporting too often. It will retry later.', { headers: { 'retry-after': String(rc.retryAfter) } });
      const r = cleanReport(body);
      const fields = { lastSeenAt: now.toISOString(), lastKind: r.kind, agentVersion: r.agent.version, device: JSON.stringify(r.device), health: JSON.stringify(r.health),
        agentInfo: JSON.stringify(r.agent), reportedName: r.device.name, ...rc.patch };
      if (r.kind === 'full') {
        Object.assign(fields, toChunks('apps', r.apps), toChunks('res', r.results, 4), { lastFullAt: now.toISOString(), appCount: r.apps.length,
          failedInstalls: r.results.filter(x => explainExit(x.exitCode).status === 'fail').length });
      }
      await putRow(T, tid, id, fields);
      return json(200, { ok: true, ...intervals() });
    } catch (err) { context.error('Agent report failed', err); return fail(500, 'Could not store the report.'); }
  } });

// ---- Company side ------------------------------------------------------------------------------------------------

const shapeRow = (r, full = false) => {
  const out = { id: r.rowKey, name: r.name || r.reportedName || '', intuneDeviceId: r.intuneDeviceId || '', status: r.status || 'active', enrolledAt: r.enrolledAt || null,
    lastSeenAt: r.lastSeenAt || null, lastFullAt: r.lastFullAt || null, agentVersion: r.agentVersion || '', appCount: Number(r.appCount) || 0, failedInstalls: Number(r.failedInstalls) || 0,
    device: parse(r.device, {}), health: parse(r.health, {}) };
  const results = fromChunks(r, 'res') || [];
  const h = deviceHealth({ ...out, results });
  out.state = h.status; out.issues = h.issues;
  if (full) {
    out.apps = fromChunks(r, 'apps') || [];
    out.results = results.map(x => ({ ...x, ...explainExit(x.exitCode) }));
    out.agent = parse(r.agentInfo, {});
  }
  return out;
};

app.http('agentDevices', { methods: ['GET'], authLevel: 'anonymous', route: 'agent/devices',
  handler: withUser(async (_r, _c, user) => {
    await activeTenant(user.tenantId);
    const order = { attention: 0, stale: 1, healthy: 2, revoked: 3 };
    const devices = (await listRows(T, user.tenantId, 5000)).map(r => shapeRow(r)).sort((a, b) => order[a.state] - order[b.state] || a.name.localeCompare(b.name));
    return { devices };
  }, 'viewer') });

app.http('agentDevice', { methods: ['GET'], authLevel: 'anonymous', route: 'agent/devices/{id}',
  handler: withUser(async (req, _c, user) => {
    const r = await getRow(T, user.tenantId, rk(req.params.id));
    if (!r) throw new HttpError(404, 'That device wasn’t found.');
    return { device: shapeRow(r, true) };
  }, 'viewer') });

app.http('agentDeviceRevoke', { methods: ['POST'], authLevel: 'anonymous', route: 'agent/devices/{id}/revoke',
  handler: withUser(async (req, _c, user) => {
    const r = await getRow(T, user.tenantId, rk(req.params.id));
    if (!r) throw new HttpError(404, 'That device wasn’t found.');
    await putRow(T, user.tenantId, r.rowKey, { status: 'revoked', revokedAt: new Date().toISOString(), revokedBy: user.email || user.userId, tokenHash: '' });
    await audit(user.tenantId, user.email || user.userId, 'revoked agent device', r.name || r.rowKey);
    return { ok: true };
  }, 'admin') });

app.http('agentDeviceDelete', { methods: ['DELETE'], authLevel: 'anonymous', route: 'agent/devices/{id}',
  handler: withUser(async (req, _c, user) => {
    const r = await getRow(T, user.tenantId, rk(req.params.id));
    if (!r) throw new HttpError(404, 'That device wasn’t found.');
    await deleteRow(T, user.tenantId, r.rowKey);
    await audit(user.tenantId, user.email || user.userId, 'removed agent device', r.name || r.rowKey);
    return { ok: true };
  }, 'admin') });

app.http('agentFleet', { methods: ['GET'], authLevel: 'anonymous', route: 'agent/report',
  handler: withUser(async (_r, _c, user) => {
    await activeTenant(user.tenantId);
    const rows = (await listRows(T, user.tenantId, 5000)).map(r => ({ status: r.status, lastSeenAt: r.lastSeenAt, agentVersion: r.agentVersion, device: parse(r.device, {}), health: parse(r.health, {}),
      apps: fromChunks(r, 'apps') || [], results: fromChunks(r, 'res') || [] }));
    const intune = (await listRows('DeviceInventory', user.tenantId, 20000)).length;
    return { ...fleetReport(rows), intuneDevices: intune, generatedAt: new Date().toISOString() };
  }, 'viewer') });

app.http('agentSettings', { methods: ['GET'], authLevel: 'anonymous', route: 'agent/settings',
  handler: withUser(async (_r, _c, user) => {
    const t = await activeTenant(user.tenantId);
    return { release: AGENT_RELEASE, appName: AGENT_APP_NAME, hasKey: !!t.agKeyHash, keyExpiresAt: t.agKeyExpiresAt || null,
      published: t.agAppId ? { appId: t.agAppId, version: t.agAppVersion || '', at: t.agPublishedAt || null, groups: parse(t.agGroups, []), allDevices: t.agAllDevices === true || t.agAllDevices === 'true' } : null };
  }, 'viewer') });

async function newKey(tid, user, why, manual = false) {
  const key = newSecret();
  const expiresAt = new Date(Date.now() + (manual ? 7 : KEY_DAYS) * 864e5).toISOString();
  await saveTenant(tid, manual ? { agManualKeyHash: hashSecret(key), agManualKeyExpiresAt: expiresAt } : { agKeyHash: hashSecret(key), agKeyCreatedAt: new Date().toISOString(), agKeyExpiresAt: expiresAt });
  await audit(tid, user.email || user.userId, 'created agent enrollment key', why);
  return { key, expiresAt };
}
const endpointFor = req => new URL('/api/agent/', req.url).toString();
const agentExe = () => readFile(new URL('../../assets/agent/nexpatch-agent.exe', import.meta.url));

async function resolveGroups(tid, list) {
  const out = [];
  for (const g of normalizeGroupInputs(list)) {
    if (g.id) {
      const f = await graph(tid, `/v1.0/groups/${g.id}?$select=id,displayName`).catch(e => { if (/\(404\)/.test(String(e.message))) return null; throw e; });
      if (!f) throw new HttpError(409, `No Entra group with ID ${g.id} was found.`);
      out.push({ id: f.id, name: f.displayName });
    } else {
      const q = encodeURIComponent(`displayName eq '${g.name.replace(/'/g, "''")}'`);
      const f = (await graph(tid, `/v1.0/groups?$filter=${q}&$select=id,displayName`)).value || [];
      if (f.length !== 1) throw new HttpError(409, f.length ? `More than one group is named "${g.name}". Pick it from the list.` : `No Entra group named "${g.name}" was found.`);
      out.push({ id: f[0].id, name: f[0].displayName });
    }
  }
  return out;
}

// Publishes (or refreshes) the agent in the customer's Intune and assigns it.
app.http('agentPublish', { methods: ['POST'], authLevel: 'anonymous', route: 'agent/publish',
  handler: withUser(async (req, _c, user) => {
    const t = await activeTenant(user.tenantId);
    if (!planStatus(t).active) throw new HttpError(402, 'Your free trial has ended. Subscribe to deploy the agent.');
    if (!featureOn(t, 'apps')) throw new HttpError(403, featureMessage('apps'));
    const body = await readJson(req);
    const groups = await resolveGroups(user.tenantId, body.groups);
    const allDevices = body.allDevices === true;
    if (!groups.length && !allDevices) throw new HttpError(400, 'Choose at least one group (start with a pilot group), or All devices.');
    const exe = await agentExe();
    const { key, expiresAt } = await newKey(user.tenantId, user, `Agent ${AGENT_RELEASE.version} published to Intune`);
    const log = [];
    const r = await publishAgent(user.tenantId, { exe, config: agentConfig({ tenantId: user.tenantId, key, endpoint: endpointFor(req) }), version: AGENT_RELEASE.version,
      groupIds: groups.map(g => g.id), allDevices, log: async m => { log.push(m); } });
    await saveTenant(user.tenantId, { agAppId: r.appId, agAppVersion: AGENT_RELEASE.version, agPublishedAt: new Date().toISOString(), agGroups: JSON.stringify(groups), agAllDevices: allDevices });
    await audit(user.tenantId, user.email || user.userId, 'published NexpatchOnline agent', `${AGENT_RELEASE.version} to ${[...groups.map(g => g.name), ...(allDevices ? ['All devices'] : [])].join(', ')}`);
    return { ...r, version: AGENT_RELEASE.version, groups, allDevices, keyExpiresAt: expiresAt, log };
  }, 'admin') });

// For testing on one PC without Intune: a config.json to put next to the downloaded exe.
app.http('agentManual', { methods: ['POST'], authLevel: 'anonymous', route: 'agent/manual',
  handler: withUser(async (req, _c, user) => {
    await activeTenant(user.tenantId);
    const { key, expiresAt } = await newKey(user.tenantId, user, 'Agent test configuration downloaded (valid 7 days)', true);
    return { config: agentConfig({ tenantId: user.tenantId, key, endpoint: endpointFor(req) }), keyExpiresAt: expiresAt, release: AGENT_RELEASE };
  }, 'admin') });
