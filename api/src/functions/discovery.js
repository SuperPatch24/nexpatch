// WinGet discovery for the Admin Center catalog: scans trusted vendors' apps in the WinGet repository,
// checks each one (lib/discovery.js) and lists them for a platform admin to add. Nothing is added automatically.
import { app } from '@azure/functions';
import { withUser, HttpError, readJson } from '../lib/http.js';
import { getRow, putRow, deleteRow, listRows, audit } from '../lib/store.js';
import { platformRole } from '../lib/platform.js';
import { listVendorPackages, verifyWinget } from '../lib/appfinder.js';
import { DEFAULT_VENDORS, VENDOR_RE, WINGET_ID, discoverPackage, packagesDue, summarize, RateLimited } from '../lib/discovery.js';

const GLOBAL = 'global', VP = 'v', RP = 'r';
const vkey = v => String(v).toLowerCase();
const requireCatalogAdmin = user => { if (!['superadmin', 'catalog'].includes(platformRole(user))) throw new HttpError(403, 'Your platform administrator role does not allow this action.'); };
const parseChecks = r => { try { return JSON.parse(r.checks || '[]'); } catch { return []; } };

async function vendors() {
  let rows = await listRows('DiscoveryVendors', VP, 500);
  if (!rows.length) {   // first run: start from the default list
    const now = new Date().toISOString();
    for (const v of DEFAULT_VENDORS) await putRow('DiscoveryVendors', VP, vkey(v), { vendor: v, enabled: true, addedBy: 'default', addedAt: now }, 'Replace');
    rows = await listRows('DiscoveryVendors', VP, 500);
  }
  return rows;
}
const catalogIds = async () => new Set((await listRows('Catalog', GLOBAL, 5000)).map(x => String(x.winget || '').toLowerCase()).filter(Boolean));

// Checks one vendor: lists its packages, then (re)checks up to `perVendor` that are due. Stops at the deadline.
async function runVendor(row, { perVendor, deadline, inCatalog, context }) {
  const now = new Date().toISOString();
  let list;
  try { list = await listVendorPackages(row.vendor); }
  catch (err) { await putRow('DiscoveryVendors', VP, row.rowKey, { lastRunAt: now, error: err.message.slice(0, 300) }, 'Merge'); if (/rate limit/i.test(err.message)) throw new RateLimited(err.message); return { vendor: row.vendor, checked: 0, error: err.message }; }
  if (!list.vendor) { await putRow('DiscoveryVendors', VP, row.rowKey, { lastRunAt: now, error: 'Not found in WinGet' + (list.suggestions?.length ? '. Did you mean ' + list.suggestions.slice(0, 5).join(', ') + '?' : '.') }, 'Merge'); return { vendor: row.vendor, checked: 0, error: 'not found' }; }
  const existing = (await listRows('DiscoveryResults', RP, 5000)).filter(r => r.vendor === list.vendor).map(r => ({ id: r.id, checkedAt: r.checkedAt }));
  let checked = 0;
  for (const p of packagesDue(list.packages, existing, { limit: perVendor })) {
    if (Date.now() > deadline) break;
    try {
      const r = await discoverPackage(p.id);
      await putRow('DiscoveryResults', RP, vkey(p.id), { id: p.id, vendor: list.vendor, verdict: r.verdict, name: r.name, publisher: r.publisher || '', version: r.version || '',
        license: r.license || '', description: r.description || '', category: r.category || '', installerType: r.installerType || '', arch: r.arch || '',
        displayName: r.displayName || '', vendorSite: r.vendorSite || '', reason: (r.reason || '').slice(0, 400), checks: JSON.stringify(r.checks || []).slice(0, 8000),
        inCatalog: inCatalog.has(p.id.toLowerCase()), checkedAt: new Date().toISOString() }, 'Replace');
      checked++;
    } catch (err) { if (err instanceof RateLimited) throw err; context?.warn?.(`Discovery ${p.id}: ${err.message}`); }
  }
  const all = (await listRows('DiscoveryResults', RP, 5000)).filter(r => r.vendor === list.vendor);
  const s = summarize(all);
  await putRow('DiscoveryVendors', VP, row.rowKey, { vendor: list.vendor, lastRunAt: now, error: '', packages: list.packages.length, ready: s.ready, review: s.review, skip: s.skip, checked: s.total }, 'Merge');
  return { vendor: list.vendor, checked, packages: list.packages.length, remaining: Math.max(0, list.packages.length - s.total) };
}

export async function runDiscovery({ only = null, budgetMs = 8 * 60e3, perVendor = 40, context } = {}) {
  const deadline = Date.now() + budgetMs, inCatalog = await catalogIds();
  const rows = (await vendors()).filter(r => r.enabled !== false && (!only || r.rowKey === vkey(only)))
    .sort((a, b) => String(a.lastRunAt || '').localeCompare(String(b.lastRunAt || '')));
  const out = [];
  for (const row of rows) {
    if (Date.now() > deadline) break;
    try { out.push(await runVendor(row, { perVendor, deadline, inCatalog, context })); }
    catch (err) { if (err instanceof RateLimited) { out.push({ vendor: row.vendor, error: err.message }); break; } throw err; }
  }
  return out;
}

// Every three hours: the vendors checked longest ago, 40 apps each, for up to 8 minutes. Each app is rechecked weekly.
app.timer('catalogDiscovery', { schedule: '0 25 1-23/3 * * *', handler: async (_t, context) => {
  const out = await runDiscovery({ context });
  context.log(`Discovery: ${out.map(o => `${o.vendor} ${o.checked ?? 0}${o.error ? ' (' + o.error + ')' : ''}`).join(', ')}`);
} });

// GET /api/platform/discovery – vendors and results, with what is already in the catalog.
app.http('platformDiscoveryList', { methods: ['GET'], authLevel: 'anonymous', route: 'platform/discovery', handler: withUser(async (_req, _c, user) => {
  requireCatalogAdmin(user);
  const [vrows, rrows, have] = await Promise.all([vendors(), listRows('DiscoveryResults', RP, 5000), catalogIds()]);
  const results = rrows.map(r => ({ id: r.id, vendor: r.vendor, verdict: r.verdict, name: r.name, publisher: r.publisher, version: r.version, license: r.license,
    description: r.description, category: r.category, installerType: r.installerType, arch: r.arch, vendorSite: r.vendorSite, reason: r.reason,
    checks: parseChecks(r), inCatalog: have.has(String(r.id).toLowerCase()), checkedAt: r.checkedAt }))
    .sort((a, b) => a.vendor.localeCompare(b.vendor) || a.name.localeCompare(b.name));
  return {
    vendors: vrows.map(v => ({ vendor: v.vendor, enabled: v.enabled !== false, lastRunAt: v.lastRunAt || null, error: v.error || '', packages: v.packages ?? null,
      ready: v.ready ?? 0, review: v.review ?? 0, skip: v.skip ?? 0, checked: v.checked ?? 0, addedBy: v.addedBy || '' })).sort((a, b) => a.vendor.localeCompare(b.vendor)),
    results, counts: summarize(results.map(r => ({ ...r }))), githubToken: !!process.env.GITHUB_TOKEN
  };
}, 'any') });

// POST /api/platform/discovery/run {vendor} – check one vendor now (about a minute at most).
app.http('platformDiscoveryRun', { methods: ['POST'], authLevel: 'anonymous', route: 'platform/discovery/run', handler: withUser(async (req, ctx, user) => {
  requireCatalogAdmin(user);
  const { vendor } = await readJson(req);
  if (!VENDOR_RE.test(String(vendor || ''))) throw new HttpError(400, 'Choose a vendor from the list.');
  if (!(await getRow('DiscoveryVendors', VP, vkey(vendor)))) throw new HttpError(404, 'That vendor isn’t on the discovery list. Add it first.');
  const [r] = await runDiscovery({ only: vendor, budgetMs: 70e3, perVendor: 25, context: ctx });
  if (r?.error && !r.checked) throw new HttpError(r.error === 'not found' ? 404 : 502, r.error === 'not found' ? `WinGet has no publisher named ${vendor}.` : r.error);
  return r || { vendor, checked: 0 };
}, 'any') });

// PUT /api/platform/discovery/vendors {vendor} – add a vendor (exact WinGet publisher folder name). DELETE removes it and its results.
app.http('platformDiscoveryVendorAdd', { methods: ['PUT'], authLevel: 'anonymous', route: 'platform/discovery/vendors', handler: withUser(async (req, _c, user) => {
  requireCatalogAdmin(user);
  const vendor = String((await readJson(req)).vendor || '').trim().replace(/\s+/g, '');
  if (!VENDOR_RE.test(vendor)) throw new HttpError(400, 'Enter the vendor as it appears in WinGet IDs, for example Mozilla or VideoLAN.');
  await vendors();
  if (await getRow('DiscoveryVendors', VP, vkey(vendor))) throw new HttpError(409, 'That vendor is already on the list.');
  let list; try { list = await listVendorPackages(vendor); } catch (err) { throw new HttpError(502, err.message); }
  if (!list.vendor) throw new HttpError(404, `WinGet has no publisher named ${vendor}.` + (list.suggestions?.length ? ' Did you mean ' + list.suggestions.slice(0, 5).join(', ') + '?' : ''));
  await putRow('DiscoveryVendors', VP, vkey(list.vendor), { vendor: list.vendor, enabled: true, addedBy: user.email || user.userId, addedAt: new Date().toISOString(), packages: list.packages.length }, 'Replace');
  await audit(GLOBAL, user.email || user.userId, 'discovery.vendor-added', list.vendor);
  return { vendor: list.vendor, packages: list.packages.length };
}, 'any') });

app.http('platformDiscoveryVendorRemove', { methods: ['DELETE'], authLevel: 'anonymous', route: 'platform/discovery/vendors/{vendor}', handler: withUser(async (req, _c, user) => {
  requireCatalogAdmin(user);
  const key = vkey(req.params.vendor || '');
  const row = await getRow('DiscoveryVendors', VP, key);
  if (!row) throw new HttpError(404, 'That vendor isn’t on the list.');
  await deleteRow('DiscoveryVendors', VP, key);
  for (const r of (await listRows('DiscoveryResults', RP, 5000)).filter(x => vkey(x.vendor) === key)) await deleteRow('DiscoveryResults', RP, r.rowKey);
  await audit(GLOBAL, user.email || user.userId, 'discovery.vendor-removed', row.vendor);
  return { removed: row.vendor };
}, 'any') });

// POST /api/platform/discovery/add {ids:[...]} – adds checked apps to the catalog. Each one is verified again on the server first.
app.http('platformDiscoveryAdd', { methods: ['POST'], authLevel: 'anonymous', route: 'platform/discovery/add', handler: withUser(async (req, _c, user) => {
  requireCatalogAdmin(user);
  const ids = [...new Set((await readJson(req)).ids || [])].map(String).filter(id => WINGET_ID.test(id)).slice(0, 25);
  if (!ids.length) throw new HttpError(400, 'Choose at least one app.');
  const out = [];
  for (const id of ids) {
    const d = await getRow('DiscoveryResults', RP, vkey(id));
    if (!d) { out.push({ id, ok: false, error: 'Not found in discovery. Check the vendor again.' }); continue; }
    if (d.verdict === 'skip') { out.push({ id, ok: false, error: 'Intune can’t deploy this app as it is: ' + d.reason }); continue; }
    const slug = id.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
    if (await getRow('Catalog', GLOBAL, slug)) { out.push({ id, ok: false, error: 'Already in the catalog.' }); continue; }
    const v = await verifyWinget(id);
    if (v.status !== 'verified') { out.push({ id, ok: false, error: 'Verification failed: ' + v.checks.filter(c => !c.ok).map(c => c.name).join('; ') }); continue; }
    await putRow('Catalog', GLOBAL, slug, {
      name: (d.name || v.name).slice(0, 120), source: 'winget', winget: id, storeProductId: '', appStoreUrl: '', storeType: '', verificationStatus: 'verified',
      vendor: (d.publisher || v.publisher).slice(0, 120), reg: (d.displayName || d.name || v.name).slice(0, 200), procs: '', exe: '', category: d.category || v.category || '',
      enabled: true, versionSource: 'auto', latestVersion: v.version || d.version || '', latestCheckedAt: new Date().toISOString(),
      discoveredVerdict: d.verdict, updatedBy: user.email || user.userId, updatedAt: new Date().toISOString() }, 'Replace');
    await putRow('DiscoveryResults', RP, vkey(id), { inCatalog: true }, 'Merge');
    out.push({ id, ok: true, name: d.name, reviewed: d.verdict === 'review' });
  }
  const added = out.filter(o => o.ok);
  if (added.length) await audit(GLOBAL, user.email || user.userId, 'catalog.added-from-discovery', added.map(o => o.id).join(', ').slice(0, 900));
  return { results: out, added: added.length };
}, 'any') });
