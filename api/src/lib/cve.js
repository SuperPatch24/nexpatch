// Vulnerabilities (CVEs) for installed app versions, from the U.S. National Vulnerability Database (NVD).
// NVD lists, for each CVE, which product versions are affected (CPE match criteria with version ranges). We download
// each product's CVEs once a day and decide here, locally, which installed versions they hit. Pure and testable.

export const NVD_CVES = 'https://services.nvd.nist.gov/rest/json/cves/2.0';
export const NVD_CPES = 'https://services.nvd.nist.gov/rest/json/cpes/2.0';
export const CVE_CONTAINER = 'nexpatch-cve-cache';
export const REFRESH_HOURS = 24;

// A catalog app is linked to one CPE product, written "vendor:product" as NVD spells it (e.g. google:chrome).
const PART = /^[a-z0-9][a-z0-9._~!-]*(\\[^\s:]|[a-z0-9._~!-])*$/i;
export function cleanCpeProduct(v) {
  const s = String(v || '').trim().toLowerCase().replace(/^cpe:2\.3:a:/, '').split(':').slice(0, 2).join(':');
  if (!s) return { value: '' };
  const [vendor, product] = s.split(':');
  if (!vendor || !product || !PART.test(vendor) || !PART.test(product) || s.length > 120) return { error: 'Write the CPE product as vendor:product, for example google:chrome. Use Find to look it up.' };
  return { value: `${vendor}:${product}` };
}
export const blobNameFor = cpe => cpe.replace(/[^a-z0-9._-]/gi, c => '_' + c.charCodeAt(0).toString(16)) + '.json';

// CPE 2.3 formatted string: cpe:2.3:part:vendor:product:version:update:... ; "\:" escapes a colon.
export function splitCpe(s) {
  const out = []; let cur = '';
  for (let i = 0; i < s.length; i++) { const c = s[i]; if (c === '\\' && i + 1 < s.length) { cur += c + s[++i]; continue; } if (c === ':') { out.push(cur); cur = ''; } else cur += c; }
  out.push(cur);
  return out;
}

const unesc = v => String(v || '').replace(/\\(.)/g, '$1');
// Dotted versions compared part by part (numbers as numbers). Letters sort after numbers within a part.
export function cmpVersion(a, b) {
  const pa = String(a).toLowerCase().split(/[.\-_+ ]/), pb = String(b).toLowerCase().split(/[.\-_+ ]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? '0', y = pb[i] ?? '0';
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
    if (nx && ny) { const d = Number(x) - Number(y); if (d) return d > 0 ? 1 : -1; continue; }
    const mx = /^(\d+)(.*)$/.exec(x), my = /^(\d+)(.*)$/.exec(y);
    if (mx && my && mx[1] !== my[1]) return Number(mx[1]) > Number(my[1]) ? 1 : -1;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

// Severity from the newest CVSS version NVD has for the CVE.
export function scoreOf(metrics = {}) {
  for (const k of ['cvssMetricV40', 'cvssMetricV31', 'cvssMetricV30', 'cvssMetricV2']) {
    const m = (metrics[k] || []).find(x => x.type === 'Primary') || (metrics[k] || [])[0];
    if (m?.cvssData?.baseScore != null) return { score: Number(m.cvssData.baseScore), severity: String(m.cvssData.baseSeverity || m.baseSeverity || severityFor(m.cvssData.baseScore)).toUpperCase(), version: k.replace('cvssMetricV', '') };
  }
  return { score: null, severity: 'UNKNOWN', version: '' };
}
export const severityFor = s => s >= 9 ? 'CRITICAL' : s >= 7 ? 'HIGH' : s >= 4 ? 'MEDIUM' : s > 0 ? 'LOW' : 'NONE';

// One NVD CVE reduced to what we need: id, score, known-exploited flag and the affected version rules for our product.
export function compactCve(cve, cpe) {
  const [vendor, product] = cpe.split(':');
  const rules = [];
  for (const conf of cve.configurations || []) for (const node of conf.nodes || []) {
    if (node.negate) continue;
    for (const m of node.cpeMatch || []) {
      if (!m.vulnerable) continue;
      const p = splitCpe(String(m.criteria || ''));
      if (p[2] !== 'a' || unesc(p[3]).toLowerCase() !== unesc(vendor) || unesc(p[4]).toLowerCase() !== unesc(product)) continue;
      const v = unesc(p[5]);
      const r = {};
      if (v && v !== '*' && v !== '-') r.v = v;
      if (m.versionStartIncluding) r.si = m.versionStartIncluding;
      if (m.versionStartExcluding) r.se = m.versionStartExcluding;
      if (m.versionEndIncluding) r.ei = m.versionEndIncluding;
      if (m.versionEndExcluding) r.ee = m.versionEndExcluding;
      if (v === '-') r.none = true;
      rules.push(r);
    }
  }
  if (!rules.length) return null;
  const s = scoreOf(cve.metrics);
  const desc = (cve.descriptions || []).find(d => d.lang === 'en')?.value || '';
  return { id: cve.id, score: s.score, sev: s.severity, pub: String(cve.published || '').slice(0, 10), kev: cve.cisaExploitAdd ? String(cve.cisaExploitAdd).slice(0, 10) : '',
    kevDue: cve.cisaActionDue ? String(cve.cisaActionDue).slice(0, 10) : '', sum: desc.slice(0, 240), rules };
}

// Does this rule cover this installed version?
export function ruleHits(r, version) {
  if (!version) return false;
  if (r.none) return false;                                  // "-": no version applies
  if (r.v) return cmpVersion(version, r.v) === 0;          // one exact version
  if (!r.si && !r.se && !r.ei && !r.ee) return true;          // every version
  if (r.si && cmpVersion(version, r.si) < 0) return false;
  if (r.se && cmpVersion(version, r.se) <= 0) return false;
  if (r.ei && cmpVersion(version, r.ei) > 0) return false;
  if (r.ee && cmpVersion(version, r.ee) >= 0) return false;
  return true;
}
export const affects = (c, version) => c.rules.some(r => ruleHits(r, version));

// Merges a fresh download into the cached list (newer copies win), newest CVE first.
export function mergeCves(old = [], fresh = []) {
  const m = new Map(old.map(c => [c.id, c]));
  for (const c of fresh) m.set(c.id, c);
  return [...m.values()].sort((a, b) => String(b.pub).localeCompare(String(a.pub)) || String(b.id).localeCompare(String(a.id)));
}

const SEV_RANK = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1, NONE: 0, UNKNOWN: 0 };
export const sevRank = s => SEV_RANK[String(s).toUpperCase()] ?? 0;

// Which inventory rows belong to a catalog app: the same rule the website uses (the name in Installed apps
// starts with the catalog app's name).
export const belongsTo = (row, app) => String(row.displayName || '').toLowerCase().startsWith(String(app.reg || app.name || '').toLowerCase());

// The company report. catalog: [{id,name,vendor,reg,cpe,latestVersion}], inventory: [{displayName,version,deviceCount}],
// caches: Map(cpe -> {fetchedAt, cves}).
export function vulnerabilityReport({ catalog, inventory, caches, now = Date.now() }) {
  const exposures = [], notChecked = [];
  let kevDevices = 0;
  const totals = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, UNKNOWN: 0 };
  const deviceSum = { exposed: 0 }, seenCve = new Set();
  for (const app of catalog || []) {
    const rows = (inventory || []).filter(r => belongsTo(r, app) && r.version);
    if (!rows.length) continue;
    if (!app.cpe) { notChecked.push({ app: app.name, reason: 'not-linked', devices: rows.reduce((n, r) => n + (Number(r.deviceCount) || 0), 0) }); continue; }
    const cache = caches.get(app.cpe);
    if (!cache) { notChecked.push({ app: app.name, reason: 'not-downloaded', devices: rows.reduce((n, r) => n + (Number(r.deviceCount) || 0), 0) }); continue; }
    const latest = app.latestVersion || '';
    const latestHits = latest ? cache.cves.filter(c => affects(c, latest)) : null;
    const byVersion = new Map();
    for (const r of rows) byVersion.set(r.version, (byVersion.get(r.version) || 0) + (Number(r.deviceCount) || 0));
    for (const [version, devices] of byVersion) {
      const hits = cache.cves.filter(c => affects(c, version));
      if (!hits.length) continue;
      const counts = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, UNKNOWN: 0 };
      for (const c of hits) { counts[c.sev in counts ? c.sev : 'UNKNOWN']++; if (!seenCve.has(c.id)) { seenCve.add(c.id); totals[c.sev in totals ? c.sev : 'UNKNOWN']++; } }
      const kev = hits.filter(c => c.kev);
      const maxScore = Math.max(...hits.map(c => c.score ?? 0));
      deviceSum.exposed += devices;
      if (kev.length) kevDevices += devices;
      exposures.push({
        appId: app.id, app: app.name, vendor: app.vendor || '', version, devices, cveCount: hits.length, counts, maxScore,
        maxSeverity: hits.reduce((m, c) => sevRank(c.sev) > sevRank(m) ? c.sev : m, 'NONE'), knownExploited: kev.length,
        fix: latestHits == null ? { status: 'unknown' } : latestHits.length === 0 ? { status: 'fixed', version: latest } : { status: 'partial', version: latest, remaining: latestHits.length },
        top: [...hits].sort((a, b) => (b.kev ? 1 : 0) - (a.kev ? 1 : 0) || (b.score ?? 0) - (a.score ?? 0)).slice(0, 15).map(c => ({ id: c.id, score: c.score, sev: c.sev, kev: c.kev, kevDue: c.kevDue, pub: c.pub, sum: c.sum }))
      });
    }
  }
  exposures.sort((a, b) => b.knownExploited - a.knownExploited || sevRank(b.maxSeverity) - sevRank(a.maxSeverity) || b.maxScore - a.maxScore || b.devices - a.devices);
  const oldest = [...caches.values()].reduce((m, c) => (!m || c.fetchedAt < m ? c.fetchedAt : m), '');
  return { summary: { appsAffected: new Set(exposures.map(e => e.appId)).size, versionsAffected: exposures.length, deviceInstallsExposed: deviceSum.exposed, knownExploitedInstalls: kevDevices,
    knownExploited: new Set(exposures.flatMap(e => e.top.filter(c => c.kev).map(c => c.id))).size, cves: totals }, exposures, notChecked, dataAsOf: oldest || null };
}

// For the catalog admin: CPE products found by NVD's own search, so a link is never made up.
export function cpeCandidates(json) {
  const out = new Map();
  for (const p of json?.products || []) {
    const name = String(p?.cpe?.cpeName || ''), parts = splitCpe(name);
    if (parts[2] !== 'a' || !parts[3] || !parts[4]) continue;
    const key = `${parts[3]}:${parts[4]}`.toLowerCase();
    const title = (p.cpe.titles || []).find(t => t.lang === 'en')?.title || '';
    if (!out.has(key)) out.set(key, { cpe: key, title: title.replace(/\s+\S*\d[\d.]*\S*\s*$/, '').trim() || title, examples: 0, deprecated: true });
    const e = out.get(key); e.examples++; if (!p.cpe.deprecated) e.deprecated = false;
  }
  return [...out.values()].sort((a, b) => a.deprecated - b.deprecated || b.examples - a.examples).slice(0, 15);
}
