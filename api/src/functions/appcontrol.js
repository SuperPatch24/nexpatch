import { app } from '@azure/functions';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { withUser, HttpError, readJson, json } from '../lib/http.js';
import { getTenant, saveTenant, listActiveTenants, getRow, putRow, deleteRow, listRows, audit } from '../lib/store.js';
import { normalize, storeEvents, pollDefender, buildSupplemental } from '../lib/appcontrol.js';
import { installerFor, UNINSTALLER } from '../lib/collector.js';
import { graph } from '../lib/graph.js';

const GUID = /^\{?[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}\}?$/;
const sha = v => createHash('sha256').update(v).digest();
async function activeTenant(tid) {
  const t = await getTenant(tid);
  if (!t || t.status !== 'active') throw new HttpError(409, 'Connect your organization on the Connect page first.');
  return t;
}
const settingsOf = t => ({ source: t.acSource || '', basePolicyId: t.acBasePolicyId || '', hasKey: !!t.acKeyHash, keyCreatedAt: t.acKeyCreatedAt || null,
  lastPollAt: t.acLastPollAt || null, lastIngestAt: t.acLastIngestAt || null, lastError: t.acLastError || '', policyVersion: Number(t.acPolicyVersion || 1) });

app.http('acSettingsGet', { methods: ['GET'], authLevel: 'anonymous', route: 'appcontrol/settings',
  handler: withUser(async (_r, _c, user) => {
    const t = await activeTenant(user.tenantId);
    const devices = (await listRows('AcDevices', user.tenantId)).filter(d => Date.now() - Date.parse(d.lastSeen) < 24 * 3600 * 1000).length;
    return { ...settingsOf(t), devicesLast24h: devices };
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
    await saveTenant(user.tenantId, { acKeyHash: sha(key).toString('hex'), acKeyCreatedAt: new Date().toISOString() });
    await audit(user.tenantId, user.email || user.userId, 'created collector key', 'Previous key, if any, stopped working');
    const endpoint = new URL('/api/appcontrol/ingest', req.url).toString();
    return { key, installer: installerFor(user.tenantId, key, endpoint), uninstaller: UNINSTALLER };
  }, 'owner') });

// Collector devices send events here (no user sign-in; authenticated by the organization's key).
app.http('acIngest', { methods: ['POST'], authLevel: 'anonymous', route: 'appcontrol/ingest',
  handler: async (req, context) => {
    try {
      const tid = req.headers.get('x-nexpatch-tenant') || '', key = req.headers.get('x-nexpatch-key') || '';
      if (!GUID.test(tid) || !key) return json(401, { error: 'Missing tenant or key.' });
      const t = await getTenant(tid);
      if (!t || t.status !== 'active' || !t.acKeyHash) return json(401, { error: 'Unknown organization or key.' });
      const given = sha(key), expected = Buffer.from(t.acKeyHash, "hex");
      if (expected.length !== given.length || !timingSafeEqual(expected, given)) return json(401, { error: 'Unknown organization or key.' });
      if (t.acSource !== 'collector') return json(409, { error: 'This organization uses Microsoft Defender for App Control events.' });
      const text = await req.text();
      if (text.length > 1024 * 1024) return json(413, { error: 'Send at most 1 MB per call.' });
      let body; try { body = JSON.parse(text); } catch { return json(400, { error: 'Body must be JSON.' }); }
      const list = Array.isArray(body.events) ? body.events.slice(0, 500) : [];
      const device = String(body.device || '').slice(0, 100);
      const events = list.map(e => normalize(e || {}, device)).filter(Boolean);
      const stored = events.length ? await storeEvents(tid, events) : 0;
      if (device) await putRow('AcDevices', tid, createHash('sha1').update(device.toLowerCase()).digest('hex'), { name: device, lastSeen: new Date().toISOString() });
      await saveTenant(tid, { acLastIngestAt: new Date().toISOString() });
      return json(200, { received: events.length, apps: stored });
    } catch (err) {
      context.error('Ingest failed', err);
      return json(500, { error: 'Could not store the events.' });
    }
  } });

app.http('acCheck', { methods: ['POST'], authLevel: 'anonymous', route: 'appcontrol/check',
  handler: withUser(async (_r, _c, user) => {
    const t = await activeTenant(user.tenantId);
    if (t.acSource === 'defender') {
      try { const r = await pollDefender(user.tenantId, t); return { ok: true, message: `Connected to Microsoft Defender. ${r.rows} new events, ${r.stored} apps updated.` }; }
      catch (err) {
        await saveTenant(user.tenantId, { acLastError: String(err.message).slice(0, 300) });
        const hint = /403|permission/i.test(err.message) ? ' Approve NexpatchOnline again so it gets the ThreatHunting.Read.All permission, and check the tenant has advanced hunting.' : '';
        return { ok: false, message: `Couldn\u2019t query Microsoft Defender: ${err.message}${hint}` };
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
      catch (err) { context.warn(`App Control poll ${t.rowKey} failed: ${err.message}`); await saveTenant(t.rowKey, { acLastError: String(err.message).slice(0, 300) }).catch(() => {}); }
    }
  } });

// ---- Base policy: build and deploy to Intune without any XML download ----
import { buildBasePolicy } from '../lib/basepolicy.js';
import { planStatus } from '../lib/plan.js';
import { deployAcPolicy } from '../lib/acdeploy.js';

async function resolveGroupIds(tid, names) {
  const ids = [];
  for (const n of names || []) {
    const v = String(n).trim();
    if (!v) continue;
    if (/^\{?[0-9a-f-]{36}\}?$/i.test(v)) { ids.push(v.replace(/[{}]/g, '')); continue; }
    const q = encodeURIComponent(`displayName eq '${v.replace(/'/g, "''")}'`);
    const found = ((await graph(tid, `/v1.0/groups?$filter=${q}&$select=id`)).value || [])[0];
    if (found) ids.push(found.id); else throw new HttpError(409, `No group named "${v}" was found.`);
  }
  return ids;
}

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
    const cfg = await readJson(req);
    const groups = Array.isArray(cfg.groups) ? cfg.groups : [];
    const groupIds = await resolveGroupIds(user.tenantId, groups);
    // Keep the same policy ID across updates, and bump the version each deploy.
    const version = `10.0.0.${Number(t.acBaseVersion || 0) + 1}`;
    const { xml, policyId } = await buildBasePolicy({
      base: cfg.base === 'DefaultWindows' ? 'DefaultWindows' : 'AllowMicrosoft',
      mode: cfg.mode === 'enforce' ? 'enforce' : 'audit',
      managedInstaller: cfg.managedInstaller !== false, isg: !!cfg.isg,
      name: cfg.name || 'NexpatchOnline base policy', policyId: t.acBasePolicyId || null, version
    });
    const log = [];
    await deployAcPolicy(user.tenantId, { name: cfg.name || 'NexpatchOnline base policy', xml, kind: 'base', groupIds, allDevices: !!cfg.allDevices, log: m => log.push(m) });
    await saveTenant(user.tenantId, { acBasePolicyId: policyId, acBaseConfig: JSON.stringify({ base: cfg.base, mode: cfg.mode, managedInstaller: cfg.managedInstaller !== false, isg: !!cfg.isg, name: cfg.name, groups, allDevices: !!cfg.allDevices }),
      acBaseVersion: Number(t.acBaseVersion || 0) + 1, acBaseMode: cfg.mode, acBaseDeployedAt: new Date().toISOString() });
    await audit(user.tenantId, user.email || user.userId, 'deployed base policy', `${cfg.mode} mode`);
    return { basePolicyId: policyId, mode: cfg.mode, log };
  }, 'admin') });

// POST /api/appcontrol/supplemental/deploy – push the current allow decisions to Intune as a supplemental policy.
app.http('acSuppDeploy', { methods: ['POST'], authLevel: 'anonymous', route: 'appcontrol/supplemental/deploy',
  handler: withUser(async (req, _c, user) => {
    const t = await activeTenant(user.tenantId);
    if (!planStatus(t).active) throw new HttpError(402, 'Your free trial has ended. Subscribe to deploy App Control policies.');
    if (!t.acBasePolicyId) throw new HttpError(409, 'Deploy the base policy first; the supplemental policy extends it.');
    const { xml } = await buildSupplemental(user.tenantId, t);
    const cfg = t.acBaseConfig ? JSON.parse(t.acBaseConfig) : {};
    const body = await readJson(req).catch(() => ({}));
    const groups = Array.isArray(body.groups) && body.groups.length ? body.groups : (cfg.groups || []);
    const groupIds = await resolveGroupIds(user.tenantId, groups);
    const log = [];
    await deployAcPolicy(user.tenantId, { name: 'NexpatchOnline allowed apps', xml, kind: 'supplemental', groupIds, allDevices: body.allDevices ?? cfg.allDevices, log: m => log.push(m) });
    await saveTenant(user.tenantId, { acSuppDeployedAt: new Date().toISOString() });
    await audit(user.tenantId, user.email || user.userId, 'deployed supplemental policy', '');
    return { log };
  }, 'admin') });
