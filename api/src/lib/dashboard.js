// Builds the platform dashboard from raw rows. Pure: no storage access, so it is unit-tested.
const DAY = 864e5;
const dayOf = v => { const t = Date.parse(v); return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : ''; };
const lastDays = (n, now) => Array.from({ length: n }, (_, i) => new Date(now - (n - 1 - i) * DAY).toISOString().slice(0, 10));
const PACKAGE_OK = new Set(['test-passed', 'packaged-awaiting-test']);
const PACKAGE_BAD = new Set(['scan-failed', 'signature-rejected', 'test-failed', 'worker-error']);

export function buildDashboard({ tenants = [], perTenant = {}, signIns = [], usage = [], storage = null, days = 30, now = Date.now() }) {
  const axis = lastDays(days, now), inRange = new Set(axis);
  const blank = () => Object.fromEntries(axis.map(d => [d, 0]));
  const daily = { signIns: blank(), activeUsers: {}, requests: blank(), publishes: blank(), packages: blank(), appRequests: blank() };
  for (const d of axis) daily.activeUsers[d] = new Set();

  const countries = {}, tenantSignIns = {}, mfaByTenant = {};
  let missingAuthTime = 0;
  for (const s of signIns) {
    const d = dayOf(s.at); if (!inRange.has(d)) continue;
    daily.signIns[d]++; daily.activeUsers[d].add(s.tenantId + ':' + s.userId);
    const c = s.country || 'Unknown'; countries[c] = (countries[c] || 0) + 1;
    tenantSignIns[s.tenantId] = (tenantSignIns[s.tenantId] || 0) + 1;
    const m = (mfaByTenant[s.tenantId] ||= { total: 0, mfa: 0 }); m.total++; if (s.mfa === true) m.mfa++;
    if (!s.authTime) missingAuthTime++;
  }
  for (const u of usage) if (inRange.has(u.day)) daily.requests[u.day] += u.requests;

  const totals = { organizations: tenants.length, activeOrganizations: 0, members: 0, devices: 0, publishes: 0, publishFailed: 0,
    packages: 0, packagesSucceeded: 0, packagesFailed: 0, installs: 0, installFailures: 0, installPending: 0, appRequests: 0 };
  const plans = {}, orgRows = [], appInstalls = {};
  const weekAgo = now - 7 * DAY;
  for (const t of tenants) {
    const x = perTenant[t.rowKey] || {};
    const plan = t.plan || 'trial'; plans[plan] = (plans[plan] || 0) + 1;
    const active = (Date.parse(t.lastSyncAt) || 0) > weekAgo || (tenantSignIns[t.rowKey] || 0) > 0;
    if (active) totals.activeOrganizations++;
    const members = (x.members || []).filter(m => m.kind === 'member').length;
    const devices = (x.inventory || []).reduce((m, r) => Math.max(m, Number(r.deviceCount) || 0), 0);
    totals.members += members; totals.devices += devices;
    let pub = 0, pubFail = 0, pkg = 0, inst = 0, instFail = 0;
    for (const j of x.publishJobs || []) {
      pub++; if (j.status === 'failed') pubFail++;
      const d = dayOf(j.createdAt); if (inRange.has(d)) daily.publishes[d]++;
    }
    for (const j of x.packagingJobs || []) {
      if (j.status === 'upload-pending') continue;
      pkg++; if (PACKAGE_OK.has(j.status)) totals.packagesSucceeded++; else if (PACKAGE_BAD.has(j.status)) totals.packagesFailed++;
      const d = dayOf(j.createdAt); if (inRange.has(d)) daily.packages[d]++;
    }
    for (const r of x.installReports || []) {
      const ok = Number(r.installed) || 0, bad = Number(r.failed) || 0;
      inst += ok; instFail += bad; totals.installPending += Number(r.pending) || 0;
      const name = r.app || 'Unknown app'; appInstalls[name] = (appInstalls[name] || 0) + ok;
    }
    for (const r of x.appRequests || []) { totals.appRequests++; const d = dayOf(r.createdAt); if (inRange.has(d)) daily.appRequests[d]++; }
    totals.publishes += pub; totals.publishFailed += pubFail; totals.packages += pkg; totals.installs += inst; totals.installFailures += instFail;
    const m = mfaByTenant[t.rowKey];
    orgRows.push({ tenantId: t.rowKey, name: t.label || t.rowKey, plan, active, members, devices, publishes: pub, packages: pkg, installs: inst,
      signIns: tenantSignIns[t.rowKey] || 0, mfaSignIns: m ? m.mfa : 0, lastSyncAt: t.lastSyncAt || null,
      storageBytes: storage?.byTenant?.[t.rowKey] || 0 });
  }

  const series = k => axis.map(d => ({ day: d, value: k === 'activeUsers' ? daily.activeUsers[d].size : daily[k][d] }));
  const top = (obj, n) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n).map(([name, value]) => ({ name, value }));
  return {
    generatedAt: new Date(now).toISOString(), days,
    totals: { ...totals, signIns: signIns.filter(s => inRange.has(dayOf(s.at))).length, storageBytes: storage?.totalBytes ?? null },
    daily: { signIns: series('signIns'), activeUsers: series('activeUsers'), requests: series('requests'), publishes: series('publishes'), packages: series('packages'), appRequests: series('appRequests') },
    countries: top(countries, 25), plans, topApps: top(appInstalls, 10),
    organizations: orgRows.sort((a, b) => b.signIns - a.signIns || b.devices - a.devices),
    storage, warnings: missingAuthTime ? [`${missingAuthTime} recent sign-ins had no auth_time claim, so session length and idle limits can’t be enforced for them. Add the auth_time optional claim to the API app registration.`] : []
  };
}

// Sum blob sizes per container and per tenant (blob names that start with a tenant GUID).
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function summarizeBlobs(containers) {
  const out = { totalBytes: 0, totalBlobs: 0, containers: [], byTenant: {} };
  for (const c of containers) {
    let bytes = 0, count = 0;
    for (const b of c.blobs) {
      const size = Number(b.size) || 0; bytes += size; count++;
      const first = String(b.name || '').split('/')[0];
      if (GUID.test(first)) out.byTenant[first.toLowerCase()] = (out.byTenant[first.toLowerCase()] || 0) + size;
    }
    out.containers.push({ name: c.name, bytes, blobs: count, truncated: !!c.truncated });
    out.totalBytes += bytes; out.totalBlobs += count;
  }
  out.containers.sort((a, b) => b.bytes - a.bytes);
  return out;
}
