import { app } from '@azure/functions';
import { withUser, HttpError, readJson } from '../lib/http.js';
import { getRow, putRow, deleteRow, listRows, listAllTenants, saveTenant, getTenant, getJob, audit } from '../lib/store.js';
import { planStatus, TRIAL_DAYS } from '../lib/plan.js';
import { isTier, TIERS } from '../lib/plans.js';
import { platformRole } from '../lib/platform.js';
import { latestWingetVersion } from '../lib/winget.js';
import { findApps, verifyStore, verifyWinget } from '../lib/appfinder.js';
import { cleanVersionSource } from '../lib/versionwatch.js';
import { ACCESS, FEATURES, accessOf, featureOn, overrideNumber, parseDomains } from '../lib/tenantsettings.js';
import { clearAccessCache } from '../lib/access.js';

const WINGET_ID = /^[A-Za-z0-9][A-Za-z0-9.+_-]{1,100}$/;
const STORE_ID = /^[A-Z0-9]{8,16}$/i;
const ID = /^[a-z0-9-]{2,80}$/;
const GLOBAL = 'global';
const shape = r => ({ id: r.rowKey, name: r.name, vendor: r.vendor || '', winget: r.winget || '', reg: r.reg || r.name, procs: r.procs || '', exe: r.exe || '',
  category: r.category || '', source: r.source === 'msstore' ? 'msstore' : 'winget',
  storeProductId: r.storeProductId || '', appStoreUrl: r.appStoreUrl || '', storeType: r.storeType || '',
  verificationStatus: r.verificationStatus || (r.source === 'msstore' ? 'candidate' : 'verified'),
  deployable: r.source === 'msstore' ? !!(r.storeProductId && r.appStoreUrl && r.verificationStatus === 'verified') : !!r.winget,
  enabled: r.enabled !== false, updatedBy: r.updatedBy || '', updatedAt: r.updatedAt || null,
  versionSource: r.versionSource || 'auto', versionRepo: r.versionRepo || '', versionFeed: r.versionFeed || '', versionPattern: r.versionPattern || '',
  latestVersion: r.latestVersion || '', latestCheckedAt: r.latestCheckedAt || null, latestChangedAt: r.latestChangedAt || null, previousVersion: r.previousVersion || '', latestError: r.latestError || '' });
function requirePlatform(user, roles = ['superadmin']) { const role = platformRole(user); if (!role || !roles.includes(role)) throw new HttpError(403, 'Your platform administrator role does not allow this action.'); }

// GET /api/catalog – the shared app catalog every organization sees (enabled apps only).
app.http('catalogList', { methods: ['GET'], authLevel: 'anonymous', route: 'catalog',
  handler: withUser(async () => ({ apps: (await listRows('Catalog', GLOBAL)).map(shape).filter(a => a.enabled) }), 'any') });

// Platform administration
app.http('platformCatalogList', { methods: ['GET'], authLevel: 'anonymous', route: 'platform/catalog',
  handler: withUser(async (_r, _c, user) => { requirePlatform(user, ['superadmin','catalog']); return { apps: (await listRows('Catalog', GLOBAL)).map(shape).sort((a, b) => a.name.localeCompare(b.name)) }; }, 'any') });

app.http('platformCatalogSave', { methods: ['PUT'], authLevel: 'anonymous', route: 'platform/catalog/{id}',
  handler: withUser(async (req, _c, user) => {
    requirePlatform(user, ['superadmin','catalog']);
    const id = String(req.params.id || '').toLowerCase();
    if (!ID.test(id)) throw new HttpError(400, 'The app ID can only use lowercase letters, numbers and dashes.');
    const b = await readJson(req);
    const name = String(b.name || '').trim().slice(0, 120), source = b.source === 'msstore' ? 'msstore' : 'winget';
    const winget = String(b.winget || '').trim();
    const storeProductId = String(b.storeProductId || '').trim().toUpperCase();
    const vendor = String(b.vendor || '').trim().slice(0, 120);
    let appStoreUrl = String(b.appStoreUrl || '').trim();
    const verificationStatus = source === 'msstore' && b.storeVerified === true && STORE_ID.test(storeProductId) ? 'verified' : (source === 'msstore' ? 'candidate' : 'verified');
    if (!name) throw new HttpError(400, 'Enter the app name.');
    if (source === 'winget' && !WINGET_ID.test(winget)) throw new HttpError(400, 'Enter a valid WinGet ID, for example Google.Chrome.');
    if (source === 'msstore' && storeProductId && !STORE_ID.test(storeProductId)) throw new HttpError(400, 'Enter a valid Microsoft Store product ID.');
    if (source === 'msstore' && storeProductId && !appStoreUrl) appStoreUrl = `https://apps.microsoft.com/detail/${storeProductId}`;
    if (source === 'msstore' && appStoreUrl) {
      let u; try { u = new URL(appStoreUrl); } catch { throw new HttpError(400, 'Enter a valid Microsoft Store URL.'); }
      if (u.protocol !== 'https:' || !['apps.microsoft.com','www.microsoft.com','microsoft.com'].includes(u.hostname)) throw new HttpError(400, 'The Store URL must be an HTTPS Microsoft Store URL.');
    }
    if (source === 'msstore' && b.storeVerified === true && (!storeProductId || !appStoreUrl || !vendor)) throw new HttpError(400, 'A verified Store entry needs a product ID, Microsoft Store URL and verified publisher.');
    if (source === 'msstore' && storeProductId && appStoreUrl && !appStoreUrl.toUpperCase().includes(storeProductId)) throw new HttpError(400, 'The Store URL must contain the same Product ID entered above.');
    const vs = cleanVersionSource(b); if (vs.error) throw new HttpError(400, vs.error);
    const prev = (await getRow('Catalog', GLOBAL, id)) || {};
    await putRow('Catalog', GLOBAL, id, {
      ...vs.value, latestVersion: prev.latestVersion || '', latestCheckedAt: prev.latestCheckedAt || '', latestChangedAt: prev.latestChangedAt || '', previousVersion: prev.previousVersion || '', latestError: prev.latestError || '',
      name, source, winget: source === 'winget' ? winget : '', storeProductId, appStoreUrl,
      storeType: String(b.storeType || '').slice(0, 40), verificationStatus,
      vendor, reg: String(b.reg || name).slice(0, 200),
      procs: String(b.procs || '').slice(0, 300), exe: String(b.exe || '').slice(0, 400), category: String(b.category || '').slice(0, 60),
      enabled: b.enabled !== false, updatedBy: user.email || user.userId, updatedAt: new Date().toISOString()
    }, 'Replace');
    return shape(await getRow('Catalog', GLOBAL, id));
  }, 'any') });

// Find an app by name on WinGet and the Microsoft Store; every match is verified against live manifests (see lib/appfinder.js).
app.http('platformCatalogLookup', { methods: ['POST'], authLevel: 'anonymous', route: 'platform/catalog/lookup', handler: withUser(async (req, _c, user) => {
  requirePlatform(user, ['superadmin','catalog']);
  const { query } = await readJson(req);
  try { return await findApps(query); } catch (err) { throw new HttpError(400, err.message); }
}, 'any') });

// Adds ONE app. The server re-verifies it itself; the client's claim that it was verified is never trusted.
app.http('platformCatalogAddVerified', { methods: ['POST'], authLevel: 'anonymous', route: 'platform/catalog/add-verified', handler: withUser(async (req, _c, user) => {
  requirePlatform(user, ['superadmin','catalog']);
  const b = await readJson(req);
  const source = b.source === 'msstore' ? 'msstore' : 'winget';
  const pid = String(b.id || '').trim();
  const v = source === 'msstore' ? await verifyStore(pid) : await verifyWinget(pid);
  if (v.status !== 'verified') throw new HttpError(422, 'Verification failed, so nothing was added: ' + v.checks.filter(c => !c.ok).map(c => c.name + (c.detail ? ' (' + c.detail + ')' : '')).join('; '));
  const slug = (source === 'msstore' ? 'msstore-' + pid : pid).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
  if (await getRow('Catalog', GLOBAL, slug)) throw new HttpError(409, 'This app is already in the catalog.');
  const category = String(b.category || v.category || '').slice(0, 60);
  await putRow('Catalog', GLOBAL, slug, {
    name: v.name.slice(0, 120), source, winget: source === 'winget' ? pid : '', storeProductId: source === 'msstore' ? pid.toUpperCase() : '',
    appStoreUrl: source === 'msstore' ? v.url : '', storeType: source === 'msstore' ? 'msstore' : '', verificationStatus: 'verified',
    vendor: v.publisher.slice(0, 120), reg: v.name.slice(0, 200), procs: '', exe: '', category, enabled: true,
    versionSource: 'auto', latestVersion: v.version || '', latestCheckedAt: v.version ? new Date().toISOString() : '',
    updatedBy: user.email || user.userId, updatedAt: new Date().toISOString() }, 'Replace');
  await audit(GLOBAL, user.email || user.userId, 'catalog.added-verified', `${v.name} (${source}:${pid})`);
  return { added: shape(await getRow('Catalog', GLOBAL, slug)), checks: v.checks };
}, 'any') });

// Removes every unverified Store candidate (e.g. left over from the old 250-app list).
app.http('platformCatalogRemoveCandidates', { methods: ['POST'], authLevel: 'anonymous', route: 'platform/catalog/remove-candidates', handler: withUser(async (_req, _c, user) => {
  requirePlatform(user, ['superadmin','catalog']);
  const rows = (await listRows('Catalog', GLOBAL, 5000)).filter(r => r.source === 'msstore' && (r.verificationStatus || 'candidate') !== 'verified');
  for (const r of rows) await deleteRow('Catalog', GLOBAL, r.rowKey);
  await audit(GLOBAL, user.email || user.userId, 'catalog.removed-candidates', `${rows.length} unverified Store candidates`);
  return { removed: rows.length };
}, 'any') });

app.http('platformCatalogDelete', { methods: ['DELETE'], authLevel: 'anonymous', route: 'platform/catalog/{id}',
  handler: withUser(async (req, _c, user) => { requirePlatform(user, ['superadmin','catalog']); const id = String(req.params.id || ''); await deleteRow('Catalog', GLOBAL, id); await audit(GLOBAL, user.email || user.userId, 'catalog.removed', id); return { removed: true }; }, 'any') });

app.http('platformCatalogCheck', { methods: ['POST'], authLevel: 'anonymous', route: 'platform/catalog-check',
  handler: withUser(async (req, _c, user) => {
    requirePlatform(user, ['superadmin','catalog']);
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
        plan: planStatus(t), planNote: t.planNote || '', tier: t.tier || '', billing: t.billing || '', appControl: t.appControl === true, interestTier: t.interestTier || '',
        ...tenantSettings(t) });
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
    const { action, days, note, tier, billing, appControl, paidUntil } = await readJson(req);
    const fields = { planNote: String(note || t.planNote || '').slice(0, 200), planChangedBy: user.email || user.userId, planChangedAt: new Date().toISOString() };
    if (action === 'activate') {
      if (!isTier(tier)) throw new HttpError(400, 'Choose a plan: Starter, Pro, Pro Plus or Enterprise.');
      if (billing === 'annual' && !TIERS[tier].annual) throw new HttpError(400, `${TIERS[tier].label} is billed monthly only.`);
      Object.assign(fields, { plan: 'active', tier, billing: billing === 'annual' ? 'annual' : 'monthly', appControl: appControl === true });
      if (paidUntil !== undefined) fields.paidUntil = cleanDate(paidUntil);
    }
    else if (action === 'extend') { const base = Math.max(Date.now(), Date.parse(t.trialEndsAt || 0) || 0); fields.plan = 'trial'; fields.trialEndsAt = new Date(base + (Math.min(Math.max(+days || 14, 1), 365)) * 864e5).toISOString(); }
    else if (action === 'restart') { fields.plan = 'trial'; fields.trialStartedAt = new Date().toISOString(); fields.trialEndsAt = new Date(Date.now() + TRIAL_DAYS * 864e5).toISOString(); }
    else if (action === 'expire') fields.plan = 'expired';
    else throw new HttpError(400, 'Choose activate, extend, restart or expire.');
    const saved = await saveTenant(tid, fields);
    await audit(tid, `NexpatchOnline (${user.email || user.userId})`, 'changed plan', `${action}${action === 'extend' ? ' ' + (days || 14) + ' days' : ''}`);
    return { tenantId: tid, plan: planStatus(saved) };
  }, 'any') });

// What the operator has set for one organization (multi-tenant administration).
function tenantSettings(t) {
  const features = {}; for (const k of Object.keys(FEATURES)) features[k] = featureOn(t, k);
  const ps = planStatus(t);
  const subscriptionEnded = !!(t.paidUntil && Date.parse(t.paidUntil) + 864e5 <= Date.now()) || ps.plan === 'expired';
  return { label: t.label || '', billingContact: t.billingContact || '', paidUntil: t.paidUntil || '', allowedDomains: t.allowedDomains || '',
    accessStatus: accessOf(t), accessReason: t.accessReason || '', accessChangedAt: t.accessChangedAt || null, accessChangedBy: t.accessChangedBy || '',
    limitDevices: t.limitDevices ?? '', limitCustomApps: t.limitCustomApps ?? '', limitPackageRequests: t.limitPackageRequests ?? '', features,
    subscriptionEnded, revokeDue: subscriptionEnded && accessOf(t) === 'active' };
}
const cleanDate = v => { if (!v) return ''; const d = new Date(v); if (isNaN(d)) throw new HttpError(400, 'Enter a valid date.'); return d.toISOString().slice(0, 10); };
const cleanText = (v, n) => String(v ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, n);

// Revoke, suspend or restore an organization's access, for example when its subscription has ended.
// Revoked: nobody in the organization can use NexpatchOnline. Suspended: people can view but not change anything.
app.http('platformTenantAccess', { methods: ['PUT'], authLevel: 'anonymous', route: 'platform/tenants/{id}/access',
  handler: withUser(async (req, _c, user) => {
    requirePlatform(user);
    const tid = String(req.params.id || '');
    const t = await getTenant(tid);
    if (!t) throw new HttpError(404, 'Organization not found.');
    const { action, reason } = await readJson(req);
    const status = { revoke: 'revoked', suspend: 'suspended', restore: 'active' }[action];
    if (!status) throw new HttpError(400, 'Choose revoke, suspend or restore.');
    if (tid === user.tenantId && status !== 'active') throw new HttpError(409, 'You can’t revoke or suspend your own organization.');
    await saveTenant(tid, { accessStatus: status, accessReason: status === 'active' ? '' : cleanText(reason, 120), accessChangedAt: new Date().toISOString(), accessChangedBy: user.email || user.userId });
    clearAccessCache(tid);
    await audit(tid, `NexpatchOnline (${user.email || user.userId})`, status === 'active' ? 'restored access' : status === 'revoked' ? 'revoked access' : 'suspended access', cleanText(reason, 120));
    return { tenantId: tid, accessStatus: status };
  }, 'any') });

// Per-organization settings: label, billing contact, subscription end, limit overrides, feature switches, allowed invitation domains.
app.http('platformTenantSettings', { methods: ['PUT'], authLevel: 'anonymous', route: 'platform/tenants/{id}/settings',
  handler: withUser(async (req, _c, user) => {
    requirePlatform(user);
    const tid = String(req.params.id || '');
    const t = await getTenant(tid);
    if (!t) throw new HttpError(404, 'Organization not found.');
    const b = await readJson(req);
    const fields = { label: cleanText(b.label, 80), billingContact: cleanText(b.billingContact, 120), paidUntil: cleanDate(b.paidUntil),
      allowedDomains: parseDomains(b.allowedDomains).join(', ') };
    if (fields.billingContact && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(fields.billingContact)) throw new HttpError(400, 'Enter a valid billing contact email, or leave it blank.');
    for (const [k, src] of [['limitDevices', b.limitDevices], ['limitCustomApps', b.limitCustomApps], ['limitPackageRequests', b.limitPackageRequests]]) {
      const n = overrideNumber(src);
      if (src !== '' && src != null && n == null) throw new HttpError(400, 'Limits must be whole numbers, or blank to use the plan limit.');
      fields[k] = n == null ? '' : n;
    }
    for (const k of Object.keys(FEATURES)) fields['feat_' + k] = b.features && b.features[k] === false ? 'off' : 'on';
    await saveTenant(tid, fields);
    clearAccessCache(tid);
    await audit(tid, `NexpatchOnline (${user.email || user.userId})`, 'changed organization settings', Object.keys(FEATURES).filter(k => fields['feat_' + k] === 'off').map(k => FEATURES[k] + ' off').join(', ') || 'settings updated');
    return { tenantId: tid, ...tenantSettings({ ...t, ...fields }) };
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


// Global website settings are editable only by platform administrators.
app.http('platformSiteContentGet', { methods:['GET'], authLevel:'anonymous', route:'platform/site-content', handler:withUser(async(_req,_ctx,user)=>{
  requirePlatform(user); const r=await getRow('SiteContent',GLOBAL,'website'); return {announcement:r?.announcement||'',supportEmail:r?.supportEmail||'',heroTitle:r?.heroTitle||'',heroSubtitle:r?.heroSubtitle||'',updatedAt:r?.updatedAt||null};
},'any') });
app.http('platformSiteContentSave', { methods:['PUT'], authLevel:'anonymous', route:'platform/site-content', handler:withUser(async(req,_ctx,user)=>{
  requirePlatform(user); const b=await readJson(req); const fields={announcement:String(b.announcement||'').trim().slice(0,500),supportEmail:String(b.supportEmail||'').trim().slice(0,254),heroTitle:String(b.heroTitle||'').trim().slice(0,180),heroSubtitle:String(b.heroSubtitle||'').trim().slice(0,500),updatedAt:new Date().toISOString(),updatedBy:user.email||user.userId};
  if(fields.supportEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fields.supportEmail)) throw new HttpError(400,'Enter a valid support email address.');
  await putRow('SiteContent',GLOBAL,'website',fields,'Merge'); return {saved:true,...fields};
},'any') });
app.http('publicSiteContent', { methods:['GET'], authLevel:'anonymous', route:'site-content', handler:async()=>{
  try { const r=await getRow('SiteContent',GLOBAL,'website'); return {status:200,jsonBody:{announcement:r?.announcement||'',supportEmail:r?.supportEmail||'',heroTitle:r?.heroTitle||'',heroSubtitle:r?.heroSubtitle||''}}; }
  catch { return {status:200,jsonBody:{announcement:'',supportEmail:''}}; }
} });
