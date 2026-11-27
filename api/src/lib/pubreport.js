// Publishing report: how each app's NexpatchOnline publishes went. Pure, built from the PublishJobs rows.
const DAY = 864e5;
const median = a => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
// The first sentence of an error, without IDs or numbers that differ per run, so the same problem groups together.
export const errorKey = e => String(e || 'Unknown error').split(/(?<=[.!?])\s/)[0].replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, '…').replace(/\b\d{3,}\b/g, '…').slice(0, 160);

export function publishingReport(jobs, { now = Date.now(), days = 90 } = {}) {
  const since = now - days * DAY;
  const list = (jobs || []).filter(j => Date.parse(j.createdAt || 0) >= since && j.status !== 'cancelled');
  const finished = list.filter(j => j.status === 'succeeded' || j.status === 'failed');
  const ok = finished.filter(j => j.status === 'succeeded');
  const minutes = j => (Date.parse(j.finishedAt) - Date.parse(j.startedAt || j.createdAt)) / 60000;
  const durations = ok.map(minutes).filter(m => Number.isFinite(m) && m >= 0);
  const apps = new Map(), errors = new Map(), weeks = new Map();
  for (const j of list) {
    const k = j.appName || '(unknown)';
    if (!apps.has(k)) apps.set(k, { app: k, total: 0, succeeded: 0, failed: 0, running: 0, updates: 0, lastAt: '', lastVersion: '', lastError: '', durations: [] });
    const a = apps.get(k);
    a.total++;
    if (j.status === 'succeeded') { a.succeeded++; const m = minutes(j); if (Number.isFinite(m) && m >= 0) a.durations.push(m); }
    else if (j.status === 'failed') { a.failed++; if (!a.lastError || String(j.createdAt) > a.lastErrorAt) { a.lastError = String(j.error || '').slice(0, 300); a.lastErrorAt = j.createdAt; } errors.set(errorKey(j.error), (errors.get(errorKey(j.error)) || 0) + 1); }
    else a.running++;
    if (j.operationType === 'update') a.updates++;
    if (String(j.createdAt) > a.lastAt) { a.lastAt = j.createdAt; if (j.version) a.lastVersion = j.version; }
    const wk = new Date(Math.floor(Date.parse(j.createdAt) / (7 * DAY)) * 7 * DAY).toISOString().slice(0, 10);
    if (!weeks.has(wk)) weeks.set(wk, { week: wk, succeeded: 0, failed: 0 });
    if (j.status === 'succeeded') weeks.get(wk).succeeded++; else if (j.status === 'failed') weeks.get(wk).failed++;
  }
  return {
    days, total: list.length, succeeded: ok.length, failed: finished.length - ok.length, running: list.length - finished.length,
    successRate: finished.length ? Math.round(100 * ok.length / finished.length) : null, medianMinutes: Math.round(median(durations) * 10) / 10,
    apps: [...apps.values()].map(({ durations: d, lastErrorAt, ...a }) => ({ ...a, successRate: a.succeeded + a.failed ? Math.round(100 * a.succeeded / (a.succeeded + a.failed)) : null, medianMinutes: Math.round(median(d) * 10) / 10 }))
      .sort((x, y) => y.failed - x.failed || y.total - x.total || x.app.localeCompare(y.app)),
    errors: [...errors.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([error, count]) => ({ error, count })),
    weeks: [...weeks.values()].sort((a, b) => a.week.localeCompare(b.week)),
    failures: list.filter(j => j.status === 'failed').sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 25)
      .map(j => ({ app: j.appName || '', at: j.createdAt, by: j.createdBy || '', error: String(j.error || '').slice(0, 300) }))
  };
}
