import { app } from '@azure/functions';
import { featureOn, featureMessage } from '../lib/tenantsettings.js';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { withUser, HttpError, readJson, json } from '../lib/http.js';
import { getTenant, saveTenant, listActiveTenants, getRow, putRow, deleteRow, listRows, audit } from '../lib/store.js';
import { normalize, storeEvents, pollDefender, buildSupplemental } from '../lib/appcontrol.js';
import { explainDefenderError } from '../lib/defender-errors.js';
import { normalizeGroupInputs } from '../lib/acgroups.js';
import { installerFor, UNINSTALLER } from '../lib/collector.js';
import { graphAs } from '../lib/graph.js';
const graph = graphAs('appcontrol');
import { GUID as GUID_STRICT, LIMITS, newSecret, hashSecret, secretMatches, keyExpiry, keyExpired, rateCheck } from '../lib/agentauth.js';

const GUID = /^\{?[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}\}?$/;
const sha = v => createHash('sha256').update(v).digest();
async function activeTenant(tid) {
  const t = await getTenant(tid);
  if (!t || t.status !== 'active') throw new HttpError(409, 'Connect your organization on the Connect page first.');
  return t;
}
const settingsOf = t => ({ source: t.acSource || '', basePolicyId: t.acBasePolicyId || '', hasKey: !!t.acKeyHash, keyCreatedAt: t.acKeyCreatedAt || null, keyExpiresAt: t.acKeyExpiresAt || null,
  lastPollAt: t.acLastPollAt || null, lastIngestAt: t.acLastIngestAt || null, lastError: t.acLastError || '', policyVersion: Number(t.acPolicyVersion || 1) });

app.http('acSettingsGet', { methods: ['GET'], authLevel: 'anonymous', route: 'appcontrol/settings',
  handler: withUser(async (_r, _c, user) => {
    const t = await activeTenant(user.tenantId);
    const rows = (await listRows('AcDevices', user.tenantId)).filter(d => d.tokenHash && d.status !== 'revoked');
    const devices = rows.filter(d => Date.now() - Date.parse(d.lastSeen) < 24 * 3600 * 1000).length;
    const online = rows.filter(d => Date.now() - Date.parse(d.lastSeen) < 10 * 60 * 1000).length;
    return { ...settingsOf(t), devicesLast24h: devices, devicesOnline: online };
  }, 'viewer') });

// Cheap check the page makes every few seconds; it loads the full event list only when something new arrived.
app.http('acPulse', { methods: ['GET'], authLevel: 'anonymous', route: 'appcontrol/pulse',
  handler: withUser(async (_r, _c, user) => {
    const t = await activeTenant(user.tenantId);
    const rows = (await listRows('AcDevices', user.tenantId)).filter(d => d.tokenHash && d.status !== 'revoked');
    return { lastIngestAt: t.acLastIngestAt || null, lastEventAt: t.acLastEventAt || null, devicesOnline: rows.filter(d => Date.now() - Date.parse(d.lastSeen) < 10 * 60 * 1000).length };
  }, 'viewer') });

app.http('acSettingsPut', { methods: ['PUT'], authLevel: 'anonymous', route: 'appcontrol/settings',
  handler: withUser(async (req, _c, user) => {
    await activeTenant(user.tenantId);
    const { source, basePolicyId } = await readJson(req);
    const fields = {};
    if (source !== undefined) { if (!['defender', 'collector'].includes(source)) throw new HttpError(400, 'Choose Microsoft Defender or the NexpatchOnline collector.'); fields.acSource = source; }
    if (basePolicyId !== undefined) {
      if (basePolicyId && !GUID.test(basePolicyId)) throw new HttpError(400, 'The base policy ID should look like {12345678-1234-1234-1234-123456789ABC}.');
      fields.acBasePolicyId = basePolicyId ? `{${basePolicyId.replace(/[{}]/g, '').toUpperCase()}}` : '';
    }
    const t = await saveTenant(user.tenantId, fields);
    await audit(user.tenantId, user.email || user.userId, 'changed App Control settings', Object.entries(fields).map(([k, v]) => `${k.replace('ac', '')}: ${v || 'cleared'}`).join(', '));
    return settingsOf(t);
  }, 'admin') });

// Create or replace the collector key; returns it once, with ready-made scripts.
app.http('acKey', { methods: ['POST'], authLevel: 'anonymous', route: 'appcontrol/key',
  handler: withUser(async (req, _c, user) => {
    await activeTenant(user.tenantId);
    const key = randomBytes(32).toString('base64url');
    await saveTenant(user.tenantId, { acKeyHash: sha(key).toString('hex'), acKeyCreatedAt: new Date().toISOString(), acKeyExpiresAt: keyExpiry() });
    await audit(user.tenantId, user.email || user.userId, 'created agent enrollment key', 'Valid for 30 days. Devices that already enrolled keep working; revoke them one by one on the App Control page.');
    const base = new URL('/api/appcontrol/', req.url).toString();
    return { key, expiresAt: keyExpiry(), installer: installerFor(user.tenantId, key, base), uninstaller: UNINSTALLER };
  }, 'admin') });

const authFail = (status, msg, extra) => json(status, { error: msg }, extra);
const rowKeyOf = id => String(id).toLowerCase();

// A device registers once with the organization's enrollment key and receives its own token.
app.http('acEnroll', { methods: ['POST'], authLevel: 'anonymous', route: 'appcontrol/enroll',
  handler: async (req, context) => {
    try {
      const tid = req.headers.get('x-nexpatch-tenant') || '', key = req.headers.get('x-nexpatch-key') || '';
      if (!GUID.test(tid) || !key) return authFail(401, 'Missing tenant or key.');
      const t = await getTenant(tid);
      if (!t || t.status !== 'active' || !secretMatches(t.acKeyHash, key)) return authFail(401, 'Unknown organization or key.');
      if (t.acSource !== 'collector') return authFail(409, 'This organization uses Microsoft Defender for App Control events.');
      if (keyExpired(t)) return authFail(403, 'The enrollment key has expired. Create a new installer on the App Control page.');
      const text = await req.text();
      if (text.length > 4096) return authFail(413, 'Request too large.');
      let body; try { body = JSON.parse(text); } catch { return authFail(400, 'Body must be JSON.'); }
      const id = String(body.deviceId || '').trim();
      if (!GUID_STRICT.test(id)) return authFail(400, 'Send the Intune device ID.');
      // Tenant-wide limit on enrollments, so a leaked key can't be used to register devices in bulk
      const now = new Date();
      const tw = rateCheck({ enrollWindowStart: t.acEnrollWindowStart, enrollCount: t.acEnrollCount }, now, 0, 'enroll', { ...LIMITS, enrollsPerHour: LIMITS.tenantEnrollsPerHour });
      if (!tw.ok) return authFail(429, 'Too many enrollments. Try again later.', { headers: { 'retry-after': String(tw.retryAfter) } });
      await saveTenant(tid, { acEnrollWindowStart: tw.patch.enrollWindowStart, acEnrollCount: tw.patch.enrollCount });
      // The device must be one of this organization's Intune devices
      const known = await getRow('DeviceInventory', tid, id) || await getRow('DeviceInventory', tid, id.toUpperCase());
      if (!known) return authFail(403, 'This device isn’t in your Intune device list yet. It will retry.');
      const rk = rowKeyOf(id), existing = await getRow('AcDevices', tid, rk);
      if (existing?.status === 'revoked') return authFail(403, 'An admin revoked this device.');
      const dr = rateCheck(existing || {}, now, 0, 'enroll');
      if (!dr.ok) return authFail(429, 'Too many enrollments for this device.', { headers: { 'retry-after': String(dr.retryAfter) } });
      const token = newSecret();
      await putRow('AcDevices', tid, rk, { name: String(known.name || body.name || '').slice(0, 100), status: 'active', tokenHash: hashSecret(token), enrolledAt: now.toISOString(), lastSeen: existing?.lastSeen || now.toISOString(), ...dr.patch });
      await audit(tid, `device ${known.name || id}`, 'enrolled App Control agent', id);
      return json(200, { deviceId: id, token });
    } catch (err) { context.error('Enroll failed', err); return json(500, { error: 'Could not enroll the device.' }); }
  } });

// Enrolled devices send events here with their own token (no user sign-in).
app.http('acIngest', { methods: ['POST'], authLevel: 'anonymous', route: 'appcontrol/ingest',
  handler: async (req, context) => {
    try {
      const tid = req.headers.get('x-nexpatch-tenant') || '', id = req.headers.get('x-nexpatch-device') || '', token = req.headers.get('x-nexpatch-token') || '';
      if (!GUID.test(tid) || !GUID_STRICT.test(id) || !token) return authFail(401, 'Missing credentials.');
      const t = await getTenant(tid);
      if (!t || t.status !== 'active') return authFail(401, 'Unknown organization.');
      const row = await getRow('AcDevices', tid, rowKeyOf(id));
      if (!row || !secretMatches(row.tokenHash, token)) return authFail(401, 'Unknown device or token.');
      if (row.status === 'revoked') return authFail(403, 'An admin revoked this device.');
      if (t.acSource !== 'collector') return authFail(409, 'This organization uses Microsoft Defender for App Control events.');
      const declaredLength = Number(req.headers.get('content-length') || 0);
      if (declaredLength > 1024 * 1024) return authFail(413, 'Send at most 1 MB per call.');
      const text = await req.text();
      if (text.length > 1024 * 1024) return authFail(413, 'Send at most 1 MB per call.');
      let body; try { body = JSON.parse(text); } catch { return authFail(400, 'Body must be JSON.'); }
      const list = Array.isArray(body.events) ? body.events.slice(0, 500) : [];
      const now = new Date();
      const rc = rateCheck(row, now, list.length);
      if (!rc.ok) return authFail(429, 'This device is sending too much. It will retry later.', { headers: { 'retry-after': String(rc.retryAfter) } });
      // The device name comes from the Intune record, not from the request
      const device = String(row.name || '').slice(0, 100);
      const events = list.map(e => normalize(e || {}, device)).filter(Boolean);
      const stored = events.length ? await storeEvents(tid, events) : 0;
      const stamp = now.toISOString();
      await putRow('AcDevices', tid, rowKeyOf(id), { lastSeen: stamp, agent: String(body.agent || '').slice(0, 20), ...(events.length ? { lastEventAt: stamp } : {}), ...rc.patch });
      await saveTenant(tid, { acLastIngestAt: stamp, ...(events.length ? { acLastEventAt: stamp } : {}) });
      return json(200, { received: events.length, apps: stored });
    } catch (err) { context.error('Ingest failed', err); return json(500, { error: 'Could not store the events.' }); }
  } });

app.http('acDevices', { methods: ['GET'], authLevel: 'anonymous', route: 'appcontrol/devices',
  handler: withUser(async (_r, _c, user) => {
    await activeTenant(user.tenantId);
    const rows = (await listRows('AcDevices', user.tenantId)).filter(d => d.tokenHash);
    return { devices: rows.map(d => ({ id: d.rowKey, name: d.name || '', status: d.status || 'active', agent: d.agent || '', enrolledAt: d.enrolledAt || null, lastSeen: d.lastSeen || null,
      online: Date.now() - Date.parse(d.lastSeen || 0) < 10 * 60 * 1000 })).sort((a, b) => String(b.lastSeen).localeCompare(String(a.lastSeen))) };
  }, 'viewer') });

app.http('acDeviceAccess', { methods: ['POST'], authLevel: 'anonymous', route: 'appcontrol/devices/access',
  handler: withUser(async (req, _c, user) => {
    await activeTenant(user.tenantId);
    const { id, action } = await readJson(req);
    if (!GUID_STRICT.test(String(id || '')) || !['revoke', 'restore'].includes(action)) throw new HttpError(400, 'Choose a device and revoke or restore.');
    const row = await getRow('AcDevices', user.tenantId, rowKeyOf(id));
    if (!row || !row.tokenHash) throw new HttpError(404, 'That device hasn’t enrolled.');
    await putRow('AcDevices', user.tenantId, rowKeyOf(id), { status: action === 'revoke' ? 'revoked' : 'active', statusBy: user.email || user.userId, statusAt: new Date().toISOString() });
    await audit(user.tenantId, user.email || user.userId, action === 'revoke' ? 'revoked App Control agent' : 'restored App Control agent', row.name || id);
    return { id, status: action === 'revoke' ? 'revoked' : 'active' };
  }, 'admin') });

app.http('acCheck', { methods: ['POST'], authLevel: 'anonymous', route: 'appcontrol/check',
  handler: withUser(async (_r, _c, user) => {
    const t = await activeTenant(user.tenantId);
    if (t.acSource === 'defender') {
      try { const r = await pollDefender(user.tenantId, t); return { ok: true, message: `Connected to Microsoft Defender. ${r.rows} new events, ${r.stored} apps updated.` }; }
      catch (err) {
        const why = explainDefenderError(err.message);
        await saveTenant(user.tenantId, { acLastError: why.message.slice(0, 300) });
        return { ok: false, message: why.message, code: why.code, switchTo: why.needsCollector ? 'collector' : undefined };
      }
    }
    if (t.acSource === 'collector') return { ok: !!t.acLastIngestAt, message: t.acLastIngestAt ? `Last events received ${t.acLastIngestAt}.` : 'No devices have sent events yet. Deploy the installer script with Intune.' };
    return { ok: false, message: 'Choose an event source first.' };
  }, 'admin') });

app.http('acEvents', { methods: ['GET'], authLevel: 'anonymous', route: 'appcontrol/events',
  handler: withUser(async (_r, _c, user) => {
    await activeTenant(user.tenantId);
    const [events, decisions] = await Promise.all([listRows('AcEvents', user.tenantId, 3000), listRows('AcDecisions', user.tenantId, 3000)]);
    const dec = new Map(decisions.map(d => [d.rowKey, d]));
    return { events: events.map(e => ({ key: e.rowKey, action: e.action, file: e.file, path: e.path, process: e.process, policy: e.policy,
      sha256: e.sha256, sha256Flat: e.sha256Flat, publisher: e.publisher, issuer: e.issuer, hasSigner: !!e.issuerTbs,
      devices: JSON.parse(e.devices || '[]').slice(0, 10), deviceCount: e.deviceCount || 0, count: e.count || 0, firstSeen: e.firstSeen, lastSeen: e.lastSeen, lastUser: e.lastUser || '',
      decision: dec.get(e.rowKey)?.decision || '', decidedBy: dec.get(e.rowKey)?.by || '', decidedAt: dec.get(e.rowKey)?.at || null }))
      .sort((a, b) => String(b.lastSeen).localeCompare(String(a.lastSeen))) };
  }, 'viewer') });

app.http('acDecide', { methods: ['POST'], authLevel: 'anonymous', route: 'appcontrol/decisions',
  handler: withUser(async (req, _c, user) => {
    const t = await activeTenant(user.tenantId);
    const { key, decision } = await readJson(req);
    if (!['allowPublisher', 'allowFile', 'block', 'ignore', 'undo'].includes(decision)) throw new HttpError(400, 'Unknown decision.');
    const e = await getRow('AcEvents', user.tenantId, String(key || ''));
    if (!e) throw new HttpError(404, 'That app isn\u2019t in the list any more.');
    const before = await getRow('AcDecisions', user.tenantId, e.rowKey);
    if (decision === 'undo') await deleteRow('AcDecisions', user.tenantId, e.rowKey);
    else {
      if (decision === 'allowPublisher' && !(e.issuerTbs && e.publisher)) throw new HttpError(409, 'This event has no signer details, so its publisher can\u2019t be allowed. Allow the file instead.');
      if (decision === 'allowFile' && !e.sha256) throw new HttpError(409, 'This event has no Authenticode hash, so the file can\u2019t be allowed by hash.');
      await putRow('AcDecisions', user.tenantId, e.rowKey, { decision, file: e.file, publisher: e.publisher, issuer: e.issuer, issuerTbs: e.issuerTbs, sha256: e.sha256, by: user.email || user.userId, at: new Date().toISOString() }, 'Replace');
    }
    const allowChanged = [before?.decision, decision === 'undo' ? '' : decision].some(d => d === 'allowPublisher' || d === 'allowFile');
    if (allowChanged) await saveTenant(user.tenantId, { acPolicyVersion: Number(t.acPolicyVersion || 1) + 1 });
    const label = { allowPublisher: 'allowed publisher', allowFile: 'allowed file', block: 'blocked app', ignore: 'ignored app', undo: 'undid decision' }[decision];
    await audit(user.tenantId, user.email || user.userId, label, decision === 'allowPublisher' ? `${e.publisher} (${e.file})` : e.file);
    return { key: e.rowKey, decision: decision === 'undo' ? '' : decision };
  }, 'admin') });

app.http('acSupplemental', { methods: ['GET'], authLevel: 'anonymous', route: 'appcontrol/supplemental',
  handler: withUser(async (_r, _c, user) => {
    const t = await activeTenant(user.tenantId);
    if (!t.acBasePolicyId) throw new HttpError(409, 'Enter your base policy ID in the Event source panel first.');
    return buildSupplemental(user.tenantId, t);
  }, 'admin') });

// Every 15 minutes: poll Defender for organizations that chose it.
app.timer('appControlPoll', { schedule: '0 */15 * * * *',
  handler: async (_t, context) => {
    for (const t of (await listActiveTenants()).filter(x => x.acSource === 'defender')) {
      try { const r = await pollDefender(t.rowKey, t); context.log(`App Control poll ${t.rowKey}: ${r.rows} rows`); }
      catch (err) { context.warn(`App Control poll ${t.rowKey} failed: ${err.message}`); await saveTenant(t.rowKey, { acLastError: explainDefenderError(err.message).message.slice(0, 300) }).catch(() => {}); }
    }
  } });

// ---- Base policy: build and deploy to Intune without any XML download ----
import { buildBasePolicy } from '../lib/basepolicy.js';
import { planStatus } from '../lib/plan.js';
import { deployAcPolicy } from '../lib/acdeploy.js';

// Turns ids and names into real Entra groups ({ id, name }). Unknown ones stop the deploy with a clear message.
async function resolveGroups(tid, list) {
  const out = [];
  for (const g of normalizeGroupInputs(list)) {
    if (g.id) {
      const found = await graph(tid, `/v1.0/groups/${g.id}?$select=id,displayName`).catch(e => { if (/\(404\)/.test(String(e.message))) return null; throw e; });
      if (!found) throw new HttpError(409, `No Entra group with ID ${g.id} was found.`);
      out.push({ id: found.id, name: found.displayName || found.id });
    } else {
      const q = encodeURIComponent(`displayName eq '${g.name.replace(/'/g, "''")}'`);
      const found = ((await graph(tid, `/v1.0/groups?$filter=${q}&$select=id,displayName`)).value || []);
      if (!found.length) throw new HttpError(409, `No Entra group named "${g.name}" was found. Pick it from the list as you type.`);
      if (found.length > 1) throw new HttpError(409, `More than one group is named "${g.name}". Pick the right one from the list as you type.`);
      out.push({ id: found[0].id, name: found[0].displayName });
    }
  }
  return out;
}
const savedGroups = cfg => (Array.isArray(cfg?.groups) ? cfg.groups : []).map(g => typeof g === 'object' ? g : { id: g, name: g });

// GET /api/appcontrol/base – the saved base-policy settings for this organization.
app.http('acBaseGet', { methods: ['GET'], authLevel: 'anonymous', route: 'appcontrol/base',
  handler: withUser(async (_r, _c, user) => {
    const t = await activeTenant(user.tenantId);
    return { base: t.acBaseConfig ? JSON.parse(t.acBaseConfig) : null, basePolicyId: t.acBasePolicyId || '', deployedAt: t.acBaseDeployedAt || null, mode: t.acBaseMode || '' };
  }, 'viewer') });

// POST /api/appcontrol/base – build the base policy and deploy it to Intune.
app.http('acBaseDeploy', { methods: ['POST'], authLevel: 'anonymous', route: 'appcontrol/base',
  handler: withUser(async (req, _c, user) => {
    const t = await activeTenant(user.tenantId);
    if (!planStatus(t).active) throw new HttpError(402, 'Your free trial has ended. Subscribe to deploy App Control policies.');
    if (!featureOn(t, 'appControl')) throw new HttpError(403, featureMessage('appControl'));
    const cfg = await readJson(req);
    const groups = await resolveGroups(user.tenantId, cfg.groups);
    if (!groups.length && !cfg.allDevices && cfg.noAssignment !== true) throw new HttpError(400, 'Choose at least one group (or All devices) to deploy to. Without one, the policy reaches no device.');
    const groupIds = groups.map(g => g.id);
    // Keep the same policy ID across updates, and bump the version each deploy.
    const version = `10.0.0.${Number(t.acBaseVersion || 0) + 1}`;
    let built;
    try { built = await buildBasePolicy({
      base: cfg.base === 'DefaultWindows' ? 'DefaultWindows' : 'AllowMicrosoft',
      mode: cfg.mode === 'enforce' ? 'enforce' : 'audit',
      managedInstaller: cfg.managedInstaller !== false, isg: !!cfg.isg, enforceScripts: cfg.enforceScripts !== false,
      name: cfg.name || 'NexpatchOnline base policy', pathRules: Array.isArray(cfg.pathRules) ? cfg.pathRules : [], policyId: t.acBasePolicyId || null, version
    }); } catch (err) { throw new HttpError(400, err.message); }
    const { xml, policyId } = built;
    const log = [];
    await deployAcPolicy(user.tenantId, { name: cfg.name || 'NexpatchOnline base policy', xml, kind: 'base', groupIds, allDevices: !!cfg.allDevices, log: m => log.push(m) });
    await saveTenant(user.tenantId, { acBasePolicyId: policyId, acBaseConfig: JSON.stringify({ base: cfg.base, mode: cfg.mode, managedInstaller: cfg.managedInstaller !== false, isg: !!cfg.isg, enforceScripts: cfg.enforceScripts !== false, name: cfg.name, groups, allDevices: !!cfg.allDevices, pathRules: Array.isArray(cfg.pathRules) ? cfg.pathRules : [] }),
      acBaseVersion: Number(t.acBaseVersion || 0) + 1, acBaseMode: cfg.mode, acBaseDeployedAt: new Date().toISOString() });
    await audit(user.tenantId, user.email || user.userId, 'deployed base policy', `${cfg.mode} mode to ${groups.map(g => g.name).join(', ') || ''}${cfg.allDevices ? (groups.length ? ', ' : '') + 'All devices' : ''}`);
    return { basePolicyId: policyId, mode: cfg.mode, groups, allDevices: !!cfg.allDevices, log };
  }, 'admin') });

// POST /api/appcontrol/supplemental/deploy – push the current allow decisions to Intune as a supplemental policy.
app.http('acSuppDeploy', { methods: ['POST'], authLevel: 'anonymous', route: 'appcontrol/supplemental/deploy',
  handler: withUser(async (req, _c, user) => {
    const t = await activeTenant(user.tenantId);
    if (!planStatus(t).active) throw new HttpError(402, 'Your free trial has ended. Subscribe to deploy App Control policies.');
    if (!featureOn(t, 'appControl')) throw new HttpError(403, featureMessage('appControl'));
    if (!t.acBasePolicyId) throw new HttpError(409, 'Deploy the base policy first; the supplemental policy extends it.');
    const { xml } = await buildSupplemental(user.tenantId, t);
    const cfg = t.acBaseConfig ? JSON.parse(t.acBaseConfig) : {};
    const body = await readJson(req).catch(() => ({}));
    const groups = await resolveGroups(user.tenantId, Array.isArray(body.groups) && body.groups.length ? body.groups : savedGroups(cfg));
    const allDevices = body.allDevices ?? !!cfg.allDevices;
    if (!groups.length && !allDevices) throw new HttpError(400, 'The base policy has no groups to follow. Deploy the base policy to a group first.');
    const log = [];
    await deployAcPolicy(user.tenantId, { name: 'NexpatchOnline allowed apps', xml, kind: 'supplemental', groupIds: groups.map(g => g.id), allDevices, log: m => log.push(m) });
    await saveTenant(user.tenantId, { acSuppDeployedAt: new Date().toISOString() });
    await audit(user.tenantId, user.email || user.userId, 'deployed supplemental policy', groups.map(g => g.name).join(', ') + (allDevices ? (groups.length ? ', ' : '') + 'All devices' : ''));
    return { log, groups, allDevices };
  }, 'admin') });
