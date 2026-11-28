import { app } from '@azure/functions';
import { withUser, HttpError, readJson } from '../lib/http.js';
import { getRow, putRow, listRows, saveTenant, getTenant } from '../lib/store.js';
import { platformRole } from '../lib/platform.js';
import { container, blobClient } from '../lib/blobs.js';
import { NVD_CVES, NVD_CPES, CVE_CONTAINER, REFRESH_HOURS, cleanCpeProduct, blobNameFor, compactCve, mergeCves, vulnerabilityReport, cpeCandidates } from '../lib/cve.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
// NVD allows about 5 requests per 30 seconds without a key and 50 with one (free: NVD_API_KEY).
const gap = () => process.env.NVD_API_KEY ? 800 : 6500;
const nvdTime = d => new Date(d).toISOString().replace('Z', '+00:00');
const requireCatalog = user => { if (!['superadmin', 'catalog'].includes(platformRole(user))) throw new HttpError(403, 'Your platform administrator role does not allow this action.'); };

async function nvd(url) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch(url, { headers: { ...(process.env.NVD_API_KEY ? { apiKey: process.env.NVD_API_KEY } : {}), 'User-Agent': 'NexpatchOnline' }, signal: AbortSignal.timeout(60000) }).catch(() => null);
    if (r?.ok) return r.json();
    if (r && ![403, 429, 500, 502, 503, 504].includes(r.status)) throw new Error(`NVD answered ${r.status}`);
    await sleep(gap() * (attempt + 2));
  }
  throw new Error('NVD is busy or unreachable. It will be tried again later.');
}

async function readCache(cpe) {
  try { return JSON.parse((await blobClient(CVE_CONTAINER, blobNameFor(cpe)).downloadToBuffer()).toString('utf8')); }
  catch (e) { if (e.statusCode === 404) return null; throw e; }
}
async function writeCache(cache) {
  const body = Buffer.from(JSON.stringify(cache));
  await (await container(CVE_CONTAINER)).getBlockBlobClient(blobNameFor(cache.cpe)).uploadData(body, { blobHTTPHeaders: { blobContentType: 'application/json' } });
}

// Downloads one product's CVEs: everything the first time and weekly, otherwise only what changed since the last run.
export async function refreshProduct(cpe, { full = false } = {}) {
  const old = await readCache(cpe), now = Date.now();
  const incremental = !full && old?.fullAt && now - Date.parse(old.fullAt) < 7 * 864e5 && old.fetchedAt;
  const params = new URLSearchParams({ virtualMatchString: `cpe:2.3:a:${cpe}`, resultsPerPage: '2000' });
  if (incremental) { params.set('lastModStartDate', nvdTime(Date.parse(old.fetchedAt) - 3600e3)); params.set('lastModEndDate', nvdTime(now)); }
  const fresh = [];
  let start = 0, total = 0, pages = 0;
  do {
    params.set('startIndex', String(start));
    const j = await nvd(`${NVD_CVES}?${params}`);
    total = Number(j.totalResults) || 0;
    for (const v of j.vulnerabilities || []) { const c = compactCve(v.cve || {}, cpe); if (c) fresh.push(c); }
    start += Number(j.resultsPerPage) || 2000; pages++;
    if (start < total) await sleep(gap());
  } while (start < total && pages < 20);
  const cves = incremental ? mergeCves(old.cves, fresh) : mergeCves([], fresh);
  const cache = { cpe, fetchedAt: new Date(now).toISOString(), fullAt: incremental ? old.fullAt : new Date(now).toISOString(), count: cves.length, cves };
  await writeCache(cache);
  await putRow('CveStatus', 'global', blobNameFor(cpe), { cpe, lastOkAt: cache.fetchedAt, lastError: '', count: cves.length, kev: cves.filter(c => c.kev).length });
  return cache;
}

const catalogWithCpe = async () => (await listRows('Catalog', 'global', 5000)).filter(r => r.enabled !== false && r.cpe)
  .map(r => ({ id: r.rowKey, name: r.name, vendor: r.vendor || '', reg: r.reg || r.name, cpe: r.cpe, latestVersion: r.latestVersion || r.packageVersion || '' }));

// Every hour: refresh the products whose data is oldest, within a time budget.
app.timer('cveSync', { schedule: '0 40 * * * *',
  handler: async (_t, context) => {
    const status = new Map((await listRows('CveStatus', 'global', 5000)).map(r => [r.cpe, r]));
    const due = [...new Set((await catalogWithCpe()).map(a => a.cpe))]
      .filter(c => { const s = status.get(c); return !s?.lastOkAt || Date.now() - Date.parse(s.lastOkAt) > REFRESH_HOURS * 3600e3; })
      .sort((a, b) => String(status.get(a)?.lastOkAt || '').localeCompare(String(status.get(b)?.lastOkAt || '')));
    const until = Date.now() + 8 * 60e3;
    for (const cpe of due) {
      if (Date.now() > until) break;
      try { const c = await refreshProduct(cpe); context.log(`CVE sync ${cpe}: ${c.count}`); }
      catch (e) { context.warn(`CVE sync ${cpe}: ${e.message}`); await putRow('CveStatus', 'global', blobNameFor(cpe), { cpe, lastError: String(e.message).slice(0, 300), lastErrorAt: new Date().toISOString() }).catch(() => {}); }
      await sleep(gap());
    }
  } });

// The company report (also saves a one-line summary for the partner overview).
export async function tenantVulnerabilities(tenantId) {
  const catalog = await catalogWithCpe(), inventory = await listRows('Inventory', tenantId, 20000);
  const caches = new Map();
  const needed = [...new Set(catalog.filter(a => inventory.some(r => String(r.displayName || '').toLowerCase().startsWith(String(a.reg).toLowerCase()))).map(a => a.cpe))];
  for (let i = 0; i < needed.length; i += 6) await Promise.all(needed.slice(i, i + 6).map(async c => { const x = await readCache(c).catch(() => null); if (x) caches.set(c, x); }));
  const r = vulnerabilityReport({ catalog: await allCatalog(), inventory, caches });
  await saveTenant(tenantId, { vulnSummary: JSON.stringify({ ...r.summary, at: new Date().toISOString() }) }).catch(() => {});
  return r;
}
// The report also lists apps that are in the catalog but not linked to NVD yet.
const allCatalog = async () => (await listRows('Catalog', 'global', 5000)).filter(r => r.enabled !== false)
  .map(r => ({ id: r.rowKey, name: r.name, vendor: r.vendor || '', reg: r.reg || r.name, cpe: r.cpe || '', latestVersion: r.latestVersion || r.packageVersion || '' }));

app.http('vulnReport', { methods: ['GET'], authLevel: 'anonymous', route: 'reports/vulnerabilities',
  handler: withUser(async (_r, _c, user) => {
    const t = await getTenant(user.tenantId);
    if (!t || t.status !== 'active') throw new HttpError(409, 'Connect your organization first.');
    return { ...(await tenantVulnerabilities(user.tenantId)), inventorySyncedAt: t.lastSyncAt || null, source: 'National Vulnerability Database (NVD), including CISA known-exploited flags' };
  }, 'viewer') });

// ---- Catalog administration ----
app.http('cveCpeSearch', { methods: ['POST'], authLevel: 'anonymous', route: 'platform/cve/cpe-search',
  handler: withUser(async (req, _c, user) => {
    requireCatalog(user);
    const q = String((await readJson(req)).query || '').trim().slice(0, 80);
    if (q.length < 2) throw new HttpError(400, 'Type at least two letters.');
    const j = await nvd(`${NVD_CPES}?${new URLSearchParams({ keywordSearch: q, resultsPerPage: '200' })}`).catch(e => { throw new HttpError(502, e.message); });
    return { candidates: cpeCandidates(j) };
  }, 'any') });

app.http('cveRefresh', { methods: ['POST'], authLevel: 'anonymous', route: 'platform/cve/refresh',
  handler: withUser(async (req, _c, user) => {
    requireCatalog(user);
    const c = cleanCpeProduct((await readJson(req)).cpe);
    if (c.error || !c.value) throw new HttpError(400, c.error || 'Choose a CPE product.');
    try { const x = await refreshProduct(c.value, { full: true }); return { cpe: x.cpe, count: x.count, knownExploited: x.cves.filter(v => v.kev).length, fetchedAt: x.fetchedAt }; }
    catch (e) { await putRow('CveStatus', 'global', blobNameFor(c.value), { cpe: c.value, lastError: String(e.message).slice(0, 300), lastErrorAt: new Date().toISOString() }).catch(() => {}); throw new HttpError(502, e.message); }
  }, 'any') });

app.http('cveStatus', { methods: ['GET'], authLevel: 'anonymous', route: 'platform/cve/status',
  handler: withUser(async (_r, _c, user) => {
    requireCatalog(user);
    const st = new Map((await listRows('CveStatus', 'global', 5000)).map(r => [r.cpe, r]));
    const apps = await allCatalog();
    return { apiKey: !!process.env.NVD_API_KEY, linked: apps.filter(a => a.cpe).length, total: apps.length,
      apps: apps.map(a => ({ id: a.id, name: a.name, cpe: a.cpe, lastOkAt: st.get(a.cpe)?.lastOkAt || null, count: st.get(a.cpe)?.count ?? null, kev: st.get(a.cpe)?.kev ?? null, lastError: st.get(a.cpe)?.lastError || '' })) };
  }, 'any') });
