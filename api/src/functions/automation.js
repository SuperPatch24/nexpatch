import { app } from '@azure/functions';
import { withUser, HttpError, readJson } from '../lib/http.js';
import { getTenant, getRow, putRow, deleteRow, listRows, listActiveTenants, audit } from '../lib/store.js';
import { graphAs, graphAllAs } from '../lib/graph.js';
const graph = graphAs('automation'), graphAll = graphAllAs('automation');
import { planStatus } from '../lib/plan.js';
import { accessOf, featureOn, featureMessage } from '../lib/tenantsettings.js';
import { MAX_RULES, INTERVALS, MAX_DELAY, cleanRule, isDue, ruleId, doneKey, runRule, summarize, groupProblem, PERMISSION_HELP } from '../lib/automation.js';

const TABLE = 'AutomationRules', DONE = 'AutomationDone';
const iso = () => new Date().toISOString();

async function needTenant(user) {
  const t = await getTenant(user.tenantId);
  if (!t || t.status !== 'active') throw new HttpError(409, 'Connect your organization first.');
  if (!featureOn(t, 'automation')) throw new HttpError(403, featureMessage('automation'));
  return t;
}
// Graph calls for automation: a missing permission here is about groups and devices, not Intune apps.
const permFix = err => { if (err instanceof HttpError && err.status === 403) throw new HttpError(403, PERMISSION_HELP); throw err; };
const deps = tid => ({ graph: (p, i) => graph(tid, p, i), graphAll: p => graphAll(tid, p) });

const shape = r => ({
  id: r.rowKey, name: r.name, enabled: r.enabled !== false && r.enabled !== 'false', delayMinutes: Number(r.delayMinutes) || 0, intervalMinutes: Number(r.intervalMinutes) || 15,
  os: r.os || 'all', ownership: r.ownership || 'all', scope: r.scope || 'new', groupId: r.groupId, groupName: r.groupName || '', groupCreated: r.groupCreated === true || r.groupCreated === 'true',
  createdAt: r.createdAt, createdBy: r.createdBy || '', lastRunAt: r.lastRunAt || null, lastSummary: r.lastSummary || '', lastError: r.lastError || '', totalAdded: Number(r.totalAdded) || 0
});

async function getRule(tid, id) {
  const r = await getRow(TABLE, tid, String(id || ''));
  if (!r) throw new HttpError(404, 'Rule not found.');
  return r;
}

// Makes sure the chosen group can take devices, or creates a new security group for the rule.
async function resolveGroup(tid, body, user) {
  if (body.createGroup) {
    const name = String(body.createGroup).trim().slice(0, 120);
    if (!name) throw new HttpError(400, 'Name the new group.');
    const nick = (name.replace(/[^A-Za-z0-9]/g, '').slice(0, 40) || 'nexpatch') + Math.random().toString(36).slice(2, 7);
    const g = await graph(tid, '/v1.0/groups', { method: 'POST', body: JSON.stringify({ displayName: name, description: 'Created by NexpatchOnline automation. Devices are added automatically; edit the rule in NexpatchOnline to change that.', mailEnabled: false, mailNickname: nick, securityEnabled: true }) }).catch(permFix);
    await audit(tid, user.email || user.userId, 'created group for automation', `${name} (${g.id})`);
    return { groupId: g.id, groupName: g.displayName || name, groupCreated: true };
  }
  const id = String(body.groupId || '').trim();
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(400, 'Choose a group, or name a new one.');
  const g = await graph(tid, `/v1.0/groups/${id}?$select=id,displayName,groupTypes,securityEnabled,onPremisesSyncEnabled,isAssignableToRole`).catch(e => { if (/\(404\)/.test(e.message)) throw new HttpError(404, 'That group wasn’t found in your Entra tenant.'); return permFix(e); });
  const problem = groupProblem(g);
  if (problem) throw new HttpError(400, problem);
  return { groupId: g.id, groupName: g.displayName || '', groupCreated: false };
}

app.http('automationList', { methods: ['GET'], authLevel: 'anonymous', route: 'automation/rules',
  handler: withUser(async (_req, _c, user) => {
    const t = await getTenant(user.tenantId);
    if (!t || t.status !== 'active') throw new HttpError(409, 'Connect your organization first.');
    const rows = await listRows(TABLE, user.tenantId, 200);
    return { enabled: featureOn(t, 'automation'), rules: rows.map(shape).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))), limits: { maxRules: MAX_RULES, intervals: INTERVALS, maxDelayMinutes: MAX_DELAY } };
  }, 'viewer') });

app.http('automationCreate', { methods: ['POST'], authLevel: 'anonymous', route: 'automation/rules',
  handler: withUser(async (req, _c, user) => {
    await needTenant(user);
    const body = await readJson(req);
    const c = cleanRule(body);
    if (c.error) throw new HttpError(400, c.error);
    if ((await listRows(TABLE, user.tenantId, 200)).length >= MAX_RULES) throw new HttpError(409, `You can have up to ${MAX_RULES} rules. Delete one you no longer use.`);
    const g = await resolveGroup(user.tenantId, body, user);
    const id = ruleId();
    await putRow(TABLE, user.tenantId, id, { ...c.fields, ...g, createdAt: iso(), createdBy: user.email || user.userId, totalAdded: 0 });
    await audit(user.tenantId, user.email || user.userId, 'created automation rule', `${c.fields.name} → ${g.groupName}`);
    return { rule: shape(await getRule(user.tenantId, id)) };
  }, 'admin') });

app.http('automationUpdate', { methods: ['PUT'], authLevel: 'anonymous', route: 'automation/rules/{id}',
  handler: withUser(async (req, _c, user) => {
    await needTenant(user);
    const old = await getRule(user.tenantId, req.params.id);
    const body = await readJson(req);
    const c = cleanRule(body, { partial: true });
    if (c.error) throw new HttpError(400, c.error);
    const fields = { ...c.fields };
    if ((body.groupId && body.groupId !== old.groupId) || body.createGroup) {
      Object.assign(fields, await resolveGroup(user.tenantId, body, user));
      fields.lastRunAt = ''; fields.lastError = '';
    }
    await putRow(TABLE, user.tenantId, old.rowKey, fields);
    await audit(user.tenantId, user.email || user.userId, 'changed automation rule', fields.enabled === undefined ? old.name : `${old.name} ${fields.enabled ? 'turned on' : 'turned off'}`);
    return { rule: shape(await getRule(user.tenantId, old.rowKey)) };
  }, 'admin') });

app.http('automationDelete', { methods: ['DELETE'], authLevel: 'anonymous', route: 'automation/rules/{id}',
  handler: withUser(async (req, _c, user) => {
    const r = await getRule(user.tenantId, req.params.id);
    await deleteRow(TABLE, user.tenantId, r.rowKey);
    for (const d of await listRows(DONE, doneKey(user.tenantId, r.rowKey), 20000)) await deleteRow(DONE, d.partitionKey, d.rowKey);
    await audit(user.tenantId, user.email || user.userId, 'deleted automation rule', r.name);
    return { ok: true };
  }, 'admin') });

app.http('automationHistory', { methods: ['GET'], authLevel: 'anonymous', route: 'automation/rules/{id}/history',
  handler: withUser(async (req, _c, user) => {
    const r = await getRule(user.tenantId, req.params.id);
    const rows = await listRows(DONE, doneKey(user.tenantId, r.rowKey), 20000);
    return { history: rows.sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 100).map(x => ({ deviceId: x.rowKey, name: x.name || '', at: x.at, result: x.result || 'added' })) };
  }, 'viewer') });

// Runs one rule and stores what happened. Used by "Run now", "Preview" and the timer.
async function execute(tid, rule, { dryRun = false, by = 'timer' } = {}) {
  const key = doneKey(tid, rule.rowKey);
  if (!dryRun) await putRow(TABLE, tid, rule.rowKey, { lockUntil: new Date(Date.now() + 10 * 60000).toISOString() });
  try {
    const done = new Set((await listRows(DONE, key, 20000)).map(d => d.rowKey));
    const res = await runRule(deps(tid), rule, done, { dryRun });
    if (dryRun) return res;
    const at = iso();
    for (const d of res.added) await putRow(DONE, key, d.id, { name: d.name, at, result: 'added' });
    for (const d of res.skippedMember) await putRow(DONE, key, d.id, { name: d.name, at, result: 'already in group' });
    const summary = summarize(res);
    await putRow(TABLE, tid, rule.rowKey, { lastRunAt: at, lastSummary: summary, lastError: '', lockUntil: '', totalAdded: (Number(rule.totalAdded) || 0) + res.added.length });
    if (res.added.length) await audit(tid, by === 'timer' ? 'NexpatchOnline automation' : by, 'automation added devices to a group', `${rule.name}: ${res.added.length} → ${rule.groupName}`);
    return { ...res, summary };
  } catch (err) {
    const msg = err.status === 403 ? PERMISSION_HELP : String(err.message || err).slice(0, 300);
    if (!dryRun) await putRow(TABLE, tid, rule.rowKey, { lastRunAt: iso(), lastError: msg, lastSummary: '', lockUntil: '' });
    throw err.status === 403 ? new HttpError(403, msg) : err instanceof HttpError ? err : new HttpError(err.status || 502, msg);
  }
}

app.http('automationRun', { methods: ['POST'], authLevel: 'anonymous', route: 'automation/rules/{id}/run',
  handler: withUser(async (req, _c, user) => {
    await needTenant(user);
    const rule = await getRule(user.tenantId, req.params.id);
    const body = await readJson(req).catch(() => ({}));
    const res = await execute(user.tenantId, rule, { dryRun: body?.dryRun === true, by: user.email || user.userId });
    return { dryRun: body?.dryRun === true, ...res, summary: res.summary || summarize({ ...res, added: res.wouldAdd || [] }).replace('Added', 'Would add').replace('Nothing to add', 'Nothing to add right now') };
  }, 'admin') });

// Every 15 minutes: run every rule that is due, for every connected organization that is allowed to.
app.timer('automationTick', {
  schedule: '0 */15 * * * *',
  handler: async (_timer, context) => {
    const tenants = await listActiveTenants();
    for (const t of tenants.filter(x => planStatus(x).active && accessOf(x) === 'active' && featureOn(x, 'automation'))) {
      let rules = [];
      try { rules = await listRows(TABLE, t.rowKey, 200); } catch (e) { context.warn(`Automation: ${t.rowKey} rules unreadable – ${e.message}`); continue; }
      for (const r of rules.filter(x => isDue(x))) {
        try { const res = await execute(t.rowKey, r, { by: 'timer' }); context.log(`Automation ${t.rowKey}/${r.name}: ${res.summary}`); }
        catch (e) { context.warn(`Automation ${t.rowKey}/${r.name}: ${e.message}`); }
      }
    }
  }
});
