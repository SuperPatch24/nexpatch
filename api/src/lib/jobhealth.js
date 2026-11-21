// Flags publishing jobs that look stuck, so the page can tell people instead of leaving them waiting.
export const QUEUED_LIMIT_MIN = 5;   // a queued job normally starts within a minute
export const RUNNING_LIMIT_MIN = 30; // a normal publish takes a few minutes

export function stuckKind(job, now = Date.now()) {
  const age = ts => { const t = Date.parse(ts || ''); return Number.isFinite(t) ? (now - t) / 60000 : 0; };
  if (job.status === 'queued' && age(job.createdAt) > QUEUED_LIMIT_MIN) return 'not-started';
  if (job.status === 'running' && age(job.startedAt || job.createdAt) > RUNNING_LIMIT_MIN) return 'slow';
  return '';
}
export const stuckMessage = kind => kind === 'not-started'
  ? 'This hasn’t started after several minutes. NexpatchOnline’s background service may be down. Try again in a few minutes, and contact support if it stays like this.'
  : kind === 'slow' ? 'This is taking much longer than usual. Open the log to see the last step. If nothing changes, start it again or contact support.' : '';
