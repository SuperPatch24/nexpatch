// Device agent: cleaning what devices send, explaining results, and building fleet reports.
// No storage or network code here, so every rule can be tested.

export const AGENT_LIMITS = { maxBody: 1024 * 1024, maxApps: 2000, maxResults: 200, heartbeatSeconds: 3600, fullSeconds: 86400, staleHours: 48 };
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isGuid = v => GUID.test(String(v || ''));
const str = (v, n) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n);
const int = (v, lo = -2147483648, hi = 2147483647) => { const n = Math.trunc(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : 0; };
const iso = v => { const t = Date.parse(v); return Number.isFinite(t) ? new Date(t).toISOString() : ''; };
const PKG_ID = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;

// What a device may send. Anything else is dropped; every string is bounded.
export function cleanReport(b = {}) {
  const d = b.device || {}, os = d.os || {}, h = b.health || {}, w = h.winget || {}, vc = h.vcRuntime || {}, ag = b.agent || {};
  const kind = b.kind === 'full' ? 'full' : 'heartbeat';
  const r = {
    kind, sentAt: iso(b.sentAt) || new Date().toISOString(),
    agent: { version: str(ag.version, 20), queueSize: int(ag.queueSize, 0, 1000), logBytes: int(ag.logBytes, 0),
      recentErrors: (Array.isArray(ag.recentErrors) ? ag.recentErrors : []).slice(-10).map(e => ({ at: iso(e?.at), msg: str(e?.msg, 300) })) },
    device: { name: str(d.name, 100), intuneDeviceId: isGuid(d.intuneDeviceId) ? String(d.intuneDeviceId).toLowerCase() : '',
      manufacturer: str(d.manufacturer, 100), model: str(d.model, 100), uptimeHours: int(d.uptimeHours, 0, 100000), rebootPending: d.rebootPending === true,
      diskFreeGB: int(d.diskFreeGB, 0, 1e6), diskTotalGB: int(d.diskTotalGB, 0, 1e6),
      os: { product: str(os.product, 80), displayVersion: str(os.displayVersion, 20), build: str(os.build, 12), ubr: int(os.ubr, 0, 1e7), edition: str(os.edition, 40), arch: str(os.arch, 12) } },
    health: {
      winget: { found: w.found === true, ok: w.ok === true, version: str(w.version, 40), appInstallerVersion: str(w.appInstallerVersion, 40), exitCode: int(w.exitCode), error: str(w.error, 300) },
      vcRuntime: { installed: vc.installed === true, version: str(vc.version, 40), dlls: vc.dlls === true }
    }
  };
  if (kind === 'full') {
    r.apps = (Array.isArray(b.apps) ? b.apps : []).slice(0, AGENT_LIMITS.maxApps).map(a => ({
      name: str(a?.name, 200), version: str(a?.version, 64), publisher: str(a?.publisher, 120), scope: a?.scope === 'user' ? 'user' : 'machine',
      arch: a?.arch === 'x86' ? 'x86' : 'x64', installDate: /^\d{8}$/.test(String(a?.installDate || '')) ? a.installDate : '',
      ...(/^\{[0-9A-F-]{36}\}$/i.test(String(a?.productCode || '')) ? { productCode: String(a.productCode).toUpperCase() } : {})
    })).filter(a => a.name);
    r.results = (Array.isArray(b.results) ? b.results : []).slice(0, AGENT_LIMITS.maxResults)
      .filter(x => PKG_ID.test(String(x?.id || '')))
      .map(x => ({ id: String(x.id), action: ['install', 'upgrade', 'uninstall'].includes(x.action) ? x.action : 'install', exitCode: int(x.exitCode), at: iso(x.at) }));
  }
  return r;
}

// Exit codes from the install script, in words an admin can act on.
const hex = h => parseInt(h, 16) | 0;
const CODES = new Map([
  [0, ['ok', 'Installed']], [1707, ['ok', 'Installed']], [3010, ['ok', 'Installed, restart needed']], [1641, ['ok', 'Installed, restart started']],
  [hex('8A15002B'), ['ok', 'Already up to date']], [hex('8A150061'), ['ok', 'Already installed']], [hex('8A15010D'), ['ok', 'Already installed']],
  [hex('8A150014'), ['fail', 'Package not found in winget']], [hex('8A150011'), ['fail', 'Installer hash didn’t match (the vendor changed the file)']],
  [hex('8A150101'), ['retry', 'App was in use']], [hex('8A150102'), ['retry', 'Another install was running']], [hex('8A150103'), ['retry', 'A file was in use']],
  [hex('8A150104'), ['fail', 'A dependency is missing']], [hex('8A150105'), ['fail', 'Disk is full']], [hex('8A150106'), ['fail', 'Not enough memory']],
  [hex('8A150107'), ['retry', 'No network connection']], [hex('8A150108'), ['fail', 'Installer failed; contact the vendor']],
  [hex('8A150109'), ['ok', 'Installed, restart needed to finish']], [hex('8A15010A'), ['retry', 'Restart needed before installing']],
  [hex('8A15010B'), ['ok', 'Installed, restart started']], [hex('8A15010C'), ['fail', 'Cancelled by the user']],
  [hex('8A15010E'), ['fail', 'A newer version is already installed']], [hex('8A15010F'), ['fail', 'Blocked by policy']],
  [-1073741701, ['fail', 'winget can’t start: Visual C++ runtime missing']], [-1073741515, ['fail', 'winget can’t start: a required file is missing']],
  [1, ['fail', 'The install script failed (see the device log)']], [1603, ['fail', 'Installer failed (1603)']], [1618, ['retry', 'Another install was running (1618)']]
]);
export function explainExit(code) {
  const c = CODES.get(int(code));
  return c ? { status: c[0], text: c[1] } : { status: 'fail', text: `Exit code ${int(code)}` };
}

// One device's state at a glance: problems first, so the report can sort by them.
export function deviceHealth(row, now = Date.now()) {
  const issues = [];
  const last = Date.parse(row.lastSeenAt || '');
  const stale = !Number.isFinite(last) || now - last > AGENT_LIMITS.staleHours * 3600e3;
  if (row.status === 'revoked') return { status: 'revoked', issues: ['Revoked by an administrator'] };
  if (stale) issues.push('No report in 2 days');
  const h = row.health || {};
  if (h.winget && !h.winget.ok) issues.push(h.winget.error || (h.winget.found ? 'winget can’t run' : 'winget is missing'));
  if (h.vcRuntime && !h.vcRuntime.dlls) issues.push('Visual C++ runtime files missing');
  const dev = row.device || {};
  if (dev.diskTotalGB && dev.diskFreeGB < 10) issues.push(`Low disk space (${dev.diskFreeGB} GB free)`);
  if (dev.rebootPending) issues.push('Restart pending');
  const failed = (row.results || []).filter(x => explainExit(x.exitCode).status === 'fail');
  if (failed.length) issues.push(`${failed.length} failed install${failed.length > 1 ? 's' : ''}`);
  return { status: stale ? 'stale' : issues.length ? 'attention' : 'healthy', issues };
}

// Reports across the fleet: health counts, winget, Windows builds, app versions, install results.
export function fleetReport(rows, now = Date.now()) {
  const live = rows.filter(r => r.status !== 'revoked');
  const counts = { devices: live.length, healthy: 0, attention: 0, stale: 0, revoked: rows.length - live.length, wingetBroken: 0, vcMissing: 0, rebootPending: 0, lowDisk: 0 };
  const versions = new Map(), builds = new Map(), results = new Map(), agentVersions = new Map();
  for (const r of live) {
    const hh = deviceHealth(r, now);
    counts[hh.status]++;
    const h = r.health || {}, dev = r.device || {};
    if (h.winget && !h.winget.ok) counts.wingetBroken++;
    if (h.vcRuntime && !h.vcRuntime.dlls) counts.vcMissing++;
    if (dev.rebootPending) counts.rebootPending++;
    if (dev.diskTotalGB && dev.diskFreeGB < 10) counts.lowDisk++;
    const b = [dev.os?.product, dev.os?.displayVersion, dev.os?.build && `${dev.os.build}.${dev.os.ubr || 0}`].filter(Boolean).join(' ');
    if (b) builds.set(b, (builds.get(b) || 0) + 1);
    const av = r.agentVersion || r.agent?.version || '';
    if (av) agentVersions.set(av, (agentVersions.get(av) || 0) + 1);
    const seen = new Set();
    for (const a of r.apps || []) {
      const k = a.name.toLowerCase();
      if (!versions.has(k)) versions.set(k, { name: a.name, publisher: a.publisher || '', devices: 0, versions: new Map() });
      const e = versions.get(k);
      if (!seen.has(k)) { e.devices++; seen.add(k); }
      e.versions.set(a.version || '(none)', (e.versions.get(a.version || '(none)') || 0) + 1);
    }
    for (const x of r.results || []) {
      if (!results.has(x.id)) results.set(x.id, { id: x.id, ok: 0, fail: 0, retry: 0, reasons: new Map(), lastAt: '' });
      const e = results.get(x.id), ex = explainExit(x.exitCode);
      e[ex.status]++;
      if (ex.status !== 'ok') e.reasons.set(ex.text, (e.reasons.get(ex.text) || 0) + 1);
      if (x.at > e.lastAt) e.lastAt = x.at;
    }
  }
  const byCount = m => [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ value: k, devices: n }));
  const apps = [...versions.values()].map(e => {
    const vs = [...e.versions.entries()].sort((a, b) => compareVersions(b[0], a[0]));
    const newest = vs[0]?.[0] || '';
    const behind = vs.slice(1).reduce((n, [, c]) => n + c, 0);
    return { name: e.name, publisher: e.publisher, devices: e.devices, newest, versions: vs.map(([v, n]) => ({ version: v, devices: n })), behind };
  }).sort((a, b) => b.behind - a.behind || b.devices - a.devices || a.name.localeCompare(b.name));
  const installs = [...results.values()].map(e => ({ id: e.id, ok: e.ok, fail: e.fail, retry: e.retry, total: e.ok + e.fail + e.retry,
    successRate: e.ok + e.fail + e.retry ? Math.round(100 * e.ok / (e.ok + e.fail + e.retry)) : 0, lastAt: e.lastAt,
    reasons: byCount(e.reasons).map(x => ({ reason: x.value, devices: x.devices })) }))
    .sort((a, b) => b.fail - a.fail || b.total - a.total);
  return { counts, builds: byCount(builds).map(x => ({ build: x.value, devices: x.devices })), agentVersions: byCount(agentVersions).map(x => ({ version: x.value, devices: x.devices })), apps, installs };
}

export function compareVersions(a, b) {
  const pa = String(a).split(/[.\-+ ]/), pb = String(b).split(/[.\-+ ]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? '0', y = pb[i] ?? '0';
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
    if (nx && ny) { if (+x !== +y) return +x > +y ? 1 : -1; }
    else if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

// Table storage keeps each text value under 64 KB, so long JSON is split across numbered fields.
export const CHUNK = 30000;
export function toChunks(prefix, value, max = 24) {
  const s = JSON.stringify(value ?? null), out = {};
  const parts = Math.ceil(s.length / CHUNK) || 1;
  if (parts > max) throw new Error('Too much data for one device.');
  for (let i = 0; i < max; i++) out[`${prefix}${i}`] = i < parts ? s.slice(i * CHUNK, (i + 1) * CHUNK) : '';
  out[`${prefix}Parts`] = parts;
  return out;
}
export function fromChunks(row, prefix) {
  const n = Number(row?.[`${prefix}Parts`] || 0);
  if (!n) return null;
  let s = '';
  for (let i = 0; i < n; i++) s += row[`${prefix}${i}`] || '';
  try { return JSON.parse(s); } catch { return null; }
}

// The agent's config.json inside the Intune package.
export function agentConfig({ tenantId, key, endpoint }) {
  const e = String(endpoint || '');
  if (!isGuid(tenantId) || !key || !/^https:\/\//.test(e)) throw new Error('Agent configuration is incomplete.');
  return JSON.stringify({ endpoint: e.endsWith('/') ? e : e + '/', tenantId, enrollKey: key, logLevel: 'info' }, null, 2);
}
