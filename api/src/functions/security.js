// Session and MFA controls, sign-in recording, and the platform dashboard.
import { app } from '@azure/functions';
import { BlobServiceClient } from '@azure/storage-blob';
import { DefaultAzureCredential } from '@azure/identity';
import { withUser, HttpError, readJson } from '../lib/http.js';
import { putRow, getRow, listRows, listAllTenants, audit } from '../lib/store.js';
import { platformRole } from '../lib/platform.js';
import { cleanPlatformPolicy } from '../lib/sessionpolicy.js';
import { policyFor, platformPolicy, clearPlatformPolicyCache, recordSignIn, signInsForDays, usageForDays, flushUsage } from '../lib/sessions.js';
import { buildDashboard, summarizeBlobs } from '../lib/dashboard.js';

const CONTAINERS = ['nexpatch-org-assets', 'nexpatch-request-installers', 'nexpatch-packaging-quarantine', 'nexpatch-packaging-manifests', 'nexpatch-packaging-artifacts'];
const MAX_BLOBS_PER_CONTAINER = 50000;
const requireRole = (user, roles) => { if (!roles.includes(platformRole(user))) throw new HttpError(403, 'Your platform administrator role does not allow this action.'); };
const describe = p => ({ maxHours: p.maxHours, idleMinutes: p.idleMinutes, requireMfa: p.requireMfa, authContext: p.authContext });

// POST /api/session/signin – the browser reports a fresh interactive sign-in (country from Cloudflare).
// Skips the session rules so a person whose session just expired can always start a new one.
app.http('sessionSignIn', { methods: ['POST'], authLevel: 'anonymous', route: 'session/signin',
  handler: withUser(async (req, _c, user) => {
    const b = await readJson(req).catch(() => ({}));
    await recordSignIn(user, b.country);
    return { policy: describe(await policyFor(user.tenantId)), authTimePresent: !!user.authTime };
  }, 'any', { skipSession: true, partner: false }) });

// GET /api/session/policy – the rules for the caller's organization, so the app can warn before an idle timeout.
app.http('sessionPolicy', { methods: ['GET'], authLevel: 'anonymous', route: 'session/policy',
  handler: withUser(async (_r, _c, user) => ({ policy: describe(await policyFor(user.tenantId)) }), 'any', { skipSession: true, partner: false }) });

// GET/PUT /api/platform/security – platform-wide defaults. These two endpoints skip the session rules
// on purpose, so a platform administrator can always undo a setting that locked people out.
app.http('platformSecurityGet', { methods: ['GET'], authLevel: 'anonymous', route: 'platform/security',
  handler: withUser(async (_r, _c, user) => {
    requireRole(user, ['superadmin']);
    const r = await getRow('SiteContent', 'global', 'security');
    return { ...describe(await platformPolicy()), updatedAt: r?.updatedAt || null, updatedBy: r?.updatedBy || '', yourSignIn: { authTimePresent: !!user.authTime, authContexts: user.acrs } };
  }, 'any', { skipSession: true }) });
app.http('platformSecuritySave', { methods: ['PUT'], authLevel: 'anonymous', route: 'platform/security',
  handler: withUser(async (req, _c, user) => {
    requireRole(user, ['superadmin']);
    let fields;
    try { fields = cleanPlatformPolicy(await readJson(req)); } catch (e) { throw new HttpError(400, e.message); }
    await putRow('SiteContent', 'global', 'security', { ...fields, updatedAt: new Date().toISOString(), updatedBy: user.email || user.userId }, 'Replace');
    clearPlatformPolicyCache();
    await audit(user.tenantId, `NexpatchOnline (${user.email || user.userId})`, 'changed platform session defaults',
      `max ${fields.maxHours || 'none'} h, idle ${fields.idleMinutes || 'none'} min, MFA ${fields.requireMfa ? 'required (' + fields.authContext + ')' : 'not required'}`);
    return { saved: true, ...fields };
  }, 'any', { skipSession: true }) });

// ---- Dashboard ----
let blobs;
function blobService() {
  if (blobs) return blobs;
  if (process.env.BLOB_STORAGE_CONNECTION) blobs = BlobServiceClient.fromConnectionString(process.env.BLOB_STORAGE_CONNECTION);
  else if (process.env.BLOB_STORAGE_URL) blobs = new BlobServiceClient(process.env.BLOB_STORAGE_URL, new DefaultAzureCredential());
  return blobs;
}
let storageCache = { at: 0, v: null };
async function storageUsage(force) {
  if (!force && storageCache.v && Date.now() - storageCache.at < 15 * 60e3) return storageCache.v;
  const svc = blobService(); if (!svc) return null;
  const containers = [];
  for (const name of CONTAINERS) {
    const list = [];
    let truncated = false;
    try {
      for await (const b of svc.getContainerClient(name).listBlobsFlat()) {
        list.push({ name: b.name, size: b.properties.contentLength });
        if (list.length >= MAX_BLOBS_PER_CONTAINER) { truncated = true; break; }
      }
    } catch (e) { if (e.statusCode !== 404) truncated = true; }
    containers.push({ name, blobs: list, truncated });
  }
  storageCache = { at: Date.now(), v: { ...summarizeBlobs(containers), measuredAt: new Date().toISOString() } };
  return storageCache.v;
}

let dashCache = { at: 0, key: '', v: null };
app.http('platformDashboard', { methods: ['GET'], authLevel: 'anonymous', route: 'platform/dashboard',
  handler: withUser(async (req, _c, user) => {
    requireRole(user, ['superadmin', 'support']);
    const days = [7, 30, 90].includes(Number(req.query.get('days'))) ? Number(req.query.get('days')) : 30;
    const force = req.query.get('refresh') === '1';
    if (!force && dashCache.v && dashCache.key === String(days) && Date.now() - dashCache.at < 5 * 60e3) return dashCache.v;
    await flushUsage();
    const tenants = await listAllTenants();
    const perTenant = {};
    for (const t of tenants) {
      const [members, inventory, publishJobs, packagingJobs, installReports, appRequests] = await Promise.all([
        listRows('Members', t.rowKey, 500), listRows('Inventory', t.rowKey, 20000), listRows('PublishJobs', t.rowKey, 5000),
        listRows('PackagingJobs', t.rowKey, 5000), listRows('InstallReports', t.rowKey, 5000), listRows('AppRequests', t.rowKey, 2000)]);
      perTenant[t.rowKey] = { members, inventory, publishJobs, packagingJobs, installReports, appRequests };
    }
    const [signIns, usage, storage] = await Promise.all([signInsForDays(days), usageForDays(days), storageUsage(force).catch(() => null)]);
    const v = buildDashboard({ tenants, perTenant, signIns, usage, storage, days });
    dashCache = { at: Date.now(), key: String(days), v };
    return v;
  }, 'any') });
