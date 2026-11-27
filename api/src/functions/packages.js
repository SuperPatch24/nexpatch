import { app } from '@azure/functions';
import { randomBytes } from 'node:crypto';
import { withUser, HttpError, readJson } from '../lib/http.js';
import { getRow, putRow, deleteRow, listRows, audit } from '../lib/store.js';
import { platformRole } from '../lib/platform.js';
import { analyzeInstaller, verdict, FRAMEWORKS } from '../lib/pkganalyze.js';
import { PKG_CONTAINER, PKG_LIMITS, cleanUploadList, pickMain, defenderResult, cleanPackageSettings, catalogIdFor } from '../lib/pkgcatalog.js';
import { toChunks, fromChunks } from '../lib/deviceagent.js';
import { uploadUrl, blobInfo, sha256Of, download, remove } from '../lib/blobs.js';

const T = 'CatalogPackages', P = 'global';
const requireCatalog = user => { if (!['superadmin', 'catalog'].includes(platformRole(user))) throw new HttpError(403, 'Your platform administrator role does not allow this action.'); };
const parse = (v, d) => { try { return v ? JSON.parse(v) : d; } catch { return d; } };
const shape = (r, full = false) => {
  const out = { id: r.rowKey, name: r.name || '', version: r.version || '', status: r.status || 'draft', verdict: r.verdict || '', framework: r.framework || '', frameworkName: FRAMEWORKS[r.framework] || r.framework || '', catalogId: r.catalogId || '',
    createdBy: r.createdBy || '', createdAt: r.createdAt || null, updatedAt: r.updatedAt || null, files: parse(r.files, []), mainFile: r.mainFile || '' };
  if (full) { out.analysis = fromChunks(r, 'an') || null; out.settings = parse(r.settings, null); out.checks = parse(r.checks, null); }
  return out;
};
async function getPkg(id) {
  const r = await getRow(T, P, String(id || ''));
  if (!r) throw new HttpError(404, 'That package wasn’t found.');
  return r;
}
const storageError = e => { if (e.status === 503) throw new HttpError(503, e.message); throw e; };

app.http('pkgList', { methods: ['GET'], authLevel: 'anonymous', route: 'platform/packages',
  handler: withUser(async (_r, _c, user) => { requireCatalog(user); return { packages: (await listRows(T, P, 1000)).map(r => shape(r)).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))), limits: PKG_LIMITS }; }, 'any') });

app.http('pkgGet', { methods: ['GET'], authLevel: 'anonymous', route: 'platform/packages/{id}',
  handler: withUser(async (req, _c, user) => { requireCatalog(user); return { package: shape(await getPkg(req.params.id), true) }; }, 'any') });

// Step 1: say which files will be uploaded; get one upload address per file.
app.http('pkgCreate', { methods: ['POST'], authLevel: 'anonymous', route: 'platform/packages',
  handler: withUser(async (req, _c, user) => {
    requireCatalog(user);
    const b = await readJson(req);
    const list = cleanUploadList(b.files);
    if (list.error) throw new HttpError(400, list.error);
    const id = 'p' + randomBytes(6).toString('hex'), now = new Date().toISOString(), uploads = [];
    for (const f of list.files) {
      const u = await uploadUrl(PKG_CONTAINER, `${id}/${f.name}`, 60).catch(storageError);
      uploads.push({ name: f.name, size: f.size, url: u.url, expiresAt: u.expiresAt });
    }
    await putRow(T, P, id, { status: 'uploading', files: JSON.stringify(list.files), mainFile: pickMain(list.files, b.mainFile), createdBy: user.email || user.userId, createdAt: now, updatedAt: now });
    await audit(P, user.email || user.userId, 'package.created', `${id}: ${list.files.map(f => f.name).join(', ')}`);
    return { id, uploads, headers: { 'x-ms-blob-type': 'BlockBlob', 'Content-Type': 'application/octet-stream' } };
  }, 'any') });

// VirusTotal (optional): looks up the file's SHA-256 only. The file itself is never sent.
async function virusTotal(sha256) {
  const key = process.env.VIRUSTOTAL_API_KEY;
  if (!key) return null;
  try {
    const r = await fetch(`https://www.virustotal.com/api/v3/files/${sha256}`, { headers: { 'x-apikey': key }, signal: AbortSignal.timeout(10000) });
    if (r.status === 404) return { known: false, malicious: 0, suspicious: 0 };
    if (!r.ok) return { error: `VirusTotal answered ${r.status}` };
    const s = (await r.json())?.data?.attributes?.last_analysis_stats || {};
    return { known: true, malicious: s.malicious || 0, suspicious: s.suspicious || 0, harmless: s.harmless || 0, undetected: s.undetected || 0 };
  } catch (e) { return { error: 'VirusTotal didn’t answer' }; }
}

// Step 2: check the uploaded files and read the installer.
app.http('pkgAnalyze', { methods: ['POST'], authLevel: 'anonymous', route: 'platform/packages/{id}/analyze',
  handler: withUser(async (req, _c, user) => {
    requireCatalog(user);
    const r = await getPkg(req.params.id), files = parse(r.files, []), b = await readJson(req).catch(() => ({}));
    const mainFile = pickMain(files, b.mainFile || r.mainFile);
    const checked = [];
    for (const f of files) {
      const info = await blobInfo(PKG_CONTAINER, `${r.rowKey}/${f.name}`).catch(storageError);
      if (!info) throw new HttpError(409, `${f.name} hasn’t finished uploading.`);
      if (info.size !== f.size) throw new HttpError(409, `${f.name} is ${info.size} bytes, not the ${f.size} bytes expected. Upload it again.`);
      checked.push({ name: f.name, size: info.size, sha256: await sha256Of(PKG_CONTAINER, `${r.rowKey}/${f.name}`), defender: defenderResult(info) });
    }
    const main = checked.find(f => f.name === mainFile);
    if (main.size > PKG_LIMITS.mainBytes) throw new HttpError(413, 'The installer is too large to analyze here.');
    const a = analyzeInstaller(main.name, await download(PKG_CONTAINER, `${r.rowKey}/${main.name}`));
    a.virustotal = await virusTotal(a.sha256);
    const worstDefender = checked.find(f => f.defender.result === 'malicious')?.defender || main.defender;
    const v = verdict({ kind: a.kind, signature: a.signature, defender: worstDefender, virustotal: a.virustotal, framework: a.framework, sizeOk: main.size > 20 * 1024 || a.kind === 'script' });
    for (const f of checked) if (f.defender.result === 'malicious' && f.name !== main.name) v.block.push(`Microsoft Defender found malware in ${f.name}.`);
    if (v.block.length) v.level = 'block';
    const opt = a.options[0] || {};
    const prev = parse(r.settings, null);
    const settings = prev || { name: a.suggested.name, vendor: a.suggested.vendor, version: a.suggested.version, arch: a.suggested.arch, mainFile: main.name, install: opt.install || '', uninstall: opt.uninstall || '',
      detection: opt.detection || { type: 'registry', displayName: a.suggested.name }, uninstallName: a.suggested.name, restart: 'suppress', maxRunTime: 60, category: '', notes: '', returnCodes: [] };
    await putRow(T, P, r.rowKey, { status: v.level === 'block' ? 'blocked' : 'analyzed', mainFile: main.name, name: settings.name, version: settings.version, framework: a.framework, verdict: v.level,
      checks: JSON.stringify({ files: checked, verdict: v }), settings: JSON.stringify(settings), ...toChunks('an', a, 4), updatedAt: new Date().toISOString() });
    await audit(P, user.email || user.userId, 'package.analyzed', `${r.rowKey} ${main.name}: ${v.level}`);
    return { package: shape(await getPkg(r.rowKey), true), frameworks: FRAMEWORKS };
  }, 'any') });

// Step 3: save the commands and detection the admin chose.
app.http('pkgSave', { methods: ['PUT'], authLevel: 'anonymous', route: 'platform/packages/{id}',
  handler: withUser(async (req, _c, user) => {
    requireCatalog(user);
    const r = await getPkg(req.params.id), c = cleanPackageSettings(await readJson(req), parse(r.files, []));
    if (c.error) throw new HttpError(400, c.error);
    await putRow(T, P, r.rowKey, { settings: JSON.stringify(c.settings), name: c.settings.name, version: c.settings.version, updatedAt: new Date().toISOString() });
    return { package: shape(await getPkg(r.rowKey), true) };
  }, 'any') });

// Step 4: put it in the catalog every company sees.
app.http('pkgToCatalog', { methods: ['POST'], authLevel: 'anonymous', route: 'platform/packages/{id}/catalog',
  handler: withUser(async (req, _c, user) => {
    requireCatalog(user);
    const r = await getPkg(req.params.id), b = await readJson(req).catch(() => ({}));
    const checks = parse(r.checks, null), s = parse(r.settings, null);
    if (!checks) throw new HttpError(409, 'Check the files first.');
    if (checks.verdict.level === 'block') throw new HttpError(409, 'This package failed the safety checks and can’t go in the catalog.');
    if (checks.verdict.level === 'review' && b.acknowledge !== true) throw new HttpError(409, 'Confirm you reviewed the warnings first.');
    const c = cleanPackageSettings(s || {}, parse(r.files, []));
    if (c.error) throw new HttpError(400, c.error);
    const id = r.catalogId || (b.catalogId && /^[a-z0-9-]{2,80}$/.test(b.catalogId) ? b.catalogId : catalogIdFor(c.settings.name));
    const existing = await getRow('Catalog', 'global', id);
    if (existing && existing.source !== 'package') throw new HttpError(409, `The catalog already has "${existing.name}" (${id}) from WinGet or the Store. Choose another catalog ID.`);
    if (existing && existing.packageId && existing.packageId !== r.rowKey && b.replace !== true) throw new HttpError(409, `${existing.name} ${existing.packageVersion || ''} is already in the catalog. Confirm to replace it with this version.`);
    const now = new Date().toISOString();
    await putRow('Catalog', 'global', id, { name: c.settings.name, vendor: c.settings.vendor, source: 'package', winget: '', storeProductId: '', appStoreUrl: '', storeType: '', verificationStatus: 'verified',
      reg: c.settings.detection.displayName || c.settings.name, procs: '', exe: '', category: c.settings.category || 'Packaged', enabled: true, packageId: r.rowKey, packageVersion: c.settings.version,
      latestVersion: c.settings.version, latestCheckedAt: now, latestChangedAt: existing?.packageVersion !== c.settings.version ? now : (existing?.latestChangedAt || now), previousVersion: existing?.packageVersion || '',
      versionSource: 'none', updatedBy: user.email || user.userId, updatedAt: now }, 'Replace');
    if (existing?.packageId && existing.packageId !== r.rowKey) await putRow(T, P, existing.packageId, { status: 'replaced', updatedAt: now });
    await putRow(T, P, r.rowKey, { status: 'in-catalog', catalogId: id, settings: JSON.stringify(c.settings), updatedAt: now });
    await audit(P, user.email || user.userId, 'package.added-to-catalog', `${c.settings.name} ${c.settings.version} as ${id}`);
    return { catalogId: id, package: shape(await getPkg(r.rowKey), true) };
  }, 'any') });

app.http('pkgDelete', { methods: ['DELETE'], authLevel: 'anonymous', route: 'platform/packages/{id}',
  handler: withUser(async (req, _c, user) => {
    requireCatalog(user);
    const r = await getPkg(req.params.id);
    if (r.catalogId) {
      const entry = await getRow('Catalog', 'global', r.catalogId);
      if (entry?.packageId === r.rowKey && entry.enabled !== false) throw new HttpError(409, 'This package is live in the catalog. Turn the catalog entry off first.');
    }
    for (const f of parse(r.files, [])) await remove(PKG_CONTAINER, `${r.rowKey}/${f.name}`).catch(() => {});
    await deleteRow(T, P, r.rowKey);
    await audit(P, user.email || user.userId, 'package.deleted', `${r.rowKey} ${r.name || ''}`);
    return { ok: true };
  }, 'any') });
