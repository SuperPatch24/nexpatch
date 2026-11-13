// Organization profile helpers: sync schedule, logo validation, name cleaning.
export const SYNC_SCHEDULE = { cron: '0 0 7 * * *', hourUtc: 7, label: 'Every day at 07:00 UTC' };
export const MAX_LOGO_BYTES = 256 * 1024;

// The next time the daily sync runs after `now` (UTC).
export function nextDailyRun(now = new Date(), hourUtc = SYNC_SCHEDULE.hourUtc) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hourUtc, 0, 0));
  if (d.getTime() <= now.getTime()) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString();
}

// Only PNG, JPEG and WebP logos are accepted (checked by file signature, not by what the browser claims).
// SVG is refused on purpose: it can carry scripts.
export function sniffImage(buf) {
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return '';
}

export function cleanProfile(b = {}) {
  const companyName = String(b.companyName || '').trim().replace(/\s+/g, ' ').slice(0, 120);
  if (!companyName) return { error: 'Enter your company name.' };
  return { value: { companyName } };
}
