import { app } from '@azure/functions';
import { withUser, HttpError, readJson } from '../lib/http.js';
import { getRow, putRow, deleteRow, listRows, listAllTenants, saveTenant, getTenant, getJob, audit } from '../lib/store.js';
import { planStatus, TRIAL_DAYS } from '../lib/plan.js';
import { isPlatformAdmin } from '../lib/platform.js';
import { latestWingetVersion } from '../lib/winget.js';

const WINGET_ID = /^[A-Za-z0-9][A-Za-z0-9.+_-]{1,100}$/;
const ID = /^[a-z0-9-]{2,80}$/;
const GLOBAL = 'global';
const shape = r => ({ id: r.rowKey, name: r.name, vendor: r.vendor || '', winget: r.winget, reg: r.reg || r.name, procs: r.procs || '', exe: r.exe || '',
  category: r.category || '', enabled: r.enabled !== false, updatedBy: r.updatedBy || '', updatedAt: r.updatedAt || null });
function requirePlatform(user) { if (!isPlatformAdmin(user)) throw new HttpError(403, 'Only platform administrators can do this.'); }

// GET /api/catalog – the shared app catalog every organization sees (enabled apps only).
app.http('catalogList', { methods: ['GET'], authLevel: 'anonymous', route: 'catalog',
  handler: withUser(async () => ({ apps: (await listRows('Catalog', GLOBAL)).map(shape).filter(a => a.enabled) }), 'any') });

// Platform administration
app.http('platformCatalogList', { methods: ['GET'], authLevel: 'anonymous', route: 'platform/catalog',
  handler: withUser(async (_r, _c, user) => { requirePlatform(user); return { apps: (await listRows('Catalog', GLOBAL)).map(shape).sort((a, b) => a.name.localeCompare(b.name)) }; }, 'any') });

app.http('platformCatalogSave', { methods: ['PUT'], authLevel: 'anonymous', route: 'platform/catalog/{id}',
  handler: withUser(async (req, _c, user) => {
    requirePlatform(user);
    const id = String(req.params.id || '').toLowerCase();
    if (!ID.test(id)) throw new HttpError(400, 'The app ID can only use lowercase letters, numbers and dashes.');
    const b = await readJson(req);
    const name = String(b.name || '').trim().slice(0, 120), winget = String(b.winget || '').trim();
    if (!name) throw new HttpError(400, 'Enter the app name.');
    if (!WINGET_ID.test(winget)) throw new HttpError(400, 'Enter a valid winget ID, for example Google.Chrome.');
    await putRow('Catalog', GLOBAL, id, {
      name, winget, vendor: String(b.vendor || '').slice(0, 120), reg: String(b.reg || name).slice(0, 200),
      procs: String(b.procs || '').slice(0, 300), exe: String(b.exe || '').slice(0, 400), category: String(b.category || '').slice(0, 60),
      enabled: b.enabled !== false, updatedBy: user.email || user.userId, updatedAt: new Date().toISOString()
    }, 'Replace');
    return shape(await getRow('Catalog', GLOBAL, id));
  }, 'any') });

app.http('platformCatalogDelete', { methods: ['DELETE'], authLevel: 'anonymous', route: 'platform/catalog/{id}',
  handler: withUser(async (req, _c, user) => { requirePlatform(user); await deleteRow('Catalog', GLOBAL, String(req.params.id || '')); return { removed: true }; }, 'any') });

app.http('platformCatalogCheck', { methods: ['POST'], authLevel: 'anonymous', route: 'platform/catalog-check',
  handler: withUser(async (req, _c, user) => {
    requirePlatform(user);
    const { winget } = await readJson(req);
    if (!WINGET_ID.test(String(winget || ''))) throw new HttpError(400, 'Enter a valid winget ID.');
    try { return { ok: true, version: await latestWingetVersion(winget) }; }
    catch (err) { return { ok: false, message: err.message }; }
  }, 'any') });

app.http('platformTenants', { methods: ['GET'], authLevel: 'anonymous', route: 'platform/tenants',
  handler: withUser(async (_r, _c, user) => {
    requirePlatform(user);
    const since = Date.now() - 30 * 864e5;
    const rows = [];
    for (const t of await listAllTenants()) {
      const [members, inventory, jobs, acEvents] = await Promise.all([
        listRows('Members', t.rowKey, 500), listRows('Inventory', t.rowKey, 20000), listRows('PublishJobs', t.rowKey, 2000), listRows('AcEvents', t.rowKey, 5000)]);
      const recent = jobs.filter(j => Date.parse(j.createdAt) > since);
      rows.push({ tenantId: t.rowKey, status: t.status || '', activatedAt: t.activatedAt || null, activatedBy: t.activatedBy || '', lastSyncAt: t.lastSyncAt || null,
        lastSyncCount: t.lastSyncCount || 0, lastSyncError: t.lastSyncError || '', acSource: t.acSource || '',
        members: members.filter(m => m.kind === 'member').length, invites: members.filter(m => m.kind === 'invite').length,
        appVersions: inventory.length, devicesSeen: inventory.reduce((m, r) => Math.max(m, r.deviceCount || 0), 0),
        publishes30d: recent.length, failed30d: recent.filter(j => j.status === 'failed').length, acApps: acEvents.length,
        plan: planStatus(t), planNote: t.planNote || '' });
    }
    return { tenants: rows.sort((a, b) => String(b.activatedAt).localeCompare(String(a.activatedAt))) };
  }, 'any') });

// Change an organization's plan: activate a paid plan, extend or restart the trial, or end it.
app.http('platformTenantPlan', { methods: ['PUT'], authLevel: 'anonymous', route: 'platform/tenants/{id}/plan',
  handler: withUser(async (req, _c, user) => {
    requirePlatform(user);
    const tid = String(req.params.id || '');
    const t = await getTenant(tid);
    if (!t) throw new HttpError(404, 'Organization not found.');
    const { action, days, note } = await readJson(req);
    const fields = { planNote: String(note || t.planNote || '').slice(0, 200), planChangedBy: user.email || user.userId, planChangedAt: new Date().toISOString() };
    if (action === 'activate') fields.plan = 'active';
    else if (action === 'extend') { const base = Math.max(Date.now(), Date.parse(t.trialEndsAt || 0) || 0); fields.plan = 'trial'; fields.trialEndsAt = new Date(base + (Math.min(Math.max(+days || 14, 1), 365)) * 864e5).toISOString(); }
    else if (action === 'restart') { fields.plan = 'trial'; fields.trialStartedAt = new Date().toISOString(); fields.trialEndsAt = new Date(Date.now() + TRIAL_DAYS * 864e5).toISOString(); }
    else if (action === 'expire') fields.plan = 'expired';
    else throw new HttpError(400, 'Choose activate, extend, restart or expire.');
    const saved = await saveTenant(tid, fields);
    await audit(tid, `NexpatchOnline (${user.email || user.userId})`, 'changed plan', `${action}${action === 'extend' ? ' ' + (days || 14) + ' days' : ''}`);
    return { tenantId: tid, plan: planStatus(saved) };
  }, 'any') });

// Publishing jobs across every organization, newest first.
app.http('platformJobs', { methods: ['GET'], authLevel: 'anonymous', route: 'platform/jobs',
  handler: withUser(async (_r, _c, user) => {
    requirePlatform(user);
    const all = [];
    for (const t of await listAllTenants()) {
      for (const j of await listRows('PublishJobs', t.rowKey, 2000)) all.push({ tenantId: t.rowKey, id: j.rowKey, status: j.status, appName: j.appName, version: j.version || null,
        summary: j.summary || '', createdBy: j.createdBy, createdAt: j.createdAt, finishedAt: j.finishedAt || null, error: j.error || '', step: j.step || '' });
    }
    return { jobs: all.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 200) };
  }, 'any') });

app.http('platformJobGet', { methods: ['GET'], authLevel: 'anonymous', route: 'platform/jobs/{tid}/{id}',
  handler: withUser(async (req, _c, user) => {
    requirePlatform(user);
    const j = await getJob(String(req.params.tid || ''), String(req.params.id || ''));
    if (!j) throw new HttpError(404, 'Job not found.');
    return { tenantId: req.params.tid, id: j.rowKey, status: j.status, appName: j.appName, version: j.version || null, error: j.error || '', log: JSON.parse(j.log || '[]') };
  }, 'any') });

// GET /api/platform/sales-leads – public website quote and demo enquiries.
app.http('platformSalesLeads', { methods: ['GET'], authLevel: 'anonymous', route: 'platform/sales-leads',
  handler: withUser(async (_r, _c, user) => { requirePlatform(user); const rows = await listRows('SalesLeads', 'sales', 500); return { leads: rows.sort((a,b) => String(b.createdAt).localeCompare(String(a.createdAt))).map(x => ({ id:x.rowKey, name:x.name, email:x.email, company:x.company, country:x.country, devices:x.devices, message:x.message, createdAt:x.createdAt, status:x.status })) }; }, 'any') });
