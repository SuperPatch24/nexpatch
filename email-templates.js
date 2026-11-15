// Branded HTML email templates for the Communications Center. Pure functions, no network.
// Everything the admin types is HTML-escaped; only https links and #rrggbb colors are accepted.
import { escapeHtml } from './email.js';

export const TEMPLATES = {
  plain:        { label: 'Plain message',      accent: '#3B4FD8', subject: '',                                   headline: '',                          body: '' },
  announcement: { label: 'Announcement',       accent: '#3B4FD8', subject: 'News from NexpatchOnline',           headline: 'What’s new',           body: 'Hello {{name}},\n\nWe have an update to share with you.\n\n- Point one\n- Point two' },
  outage:       { label: 'Service outage',     accent: '#C2410C', subject: 'Service disruption: we are investigating', headline: 'We are investigating a service disruption', body: 'Hello {{name}},\n\nSome features of NexpatchOnline are currently unavailable. Our team is working on it.\n\n- What is affected: \n- Started at: \n\nWe will send another update as soon as there is progress.' },
  maintenance:  { label: 'Planned maintenance', accent: '#B45309', subject: 'Planned maintenance on {{date}}',    headline: 'Planned maintenance',       body: 'Hello {{name}},\n\nWe will perform maintenance on {{date}}. During this time some features may be briefly unavailable.\n\nNo action is needed on your side.' },
  resolved:     { label: 'Service restored',   accent: '#15803D', subject: 'Resolved: service is back to normal', headline: 'Service restored',        body: 'Hello {{name}},\n\nThe earlier disruption has been resolved and everything is working normally again. Thank you for your patience.' },
  welcome:      { label: 'Welcome',            accent: '#3B4FD8', subject: 'Welcome to NexpatchOnline',          headline: 'Welcome aboard',            body: 'Hello {{name}},\n\nYour organization is ready. Here is how to get started:\n\n- Connect to Intune\n- Browse the app catalog\n- Package your first app' },
  billing:      { label: 'Billing notice',     accent: '#475569', subject: 'Your NexpatchOnline subscription',  headline: 'About your subscription',   body: 'Hello {{name}},\n\nThis is a notice about your NexpatchOnline subscription.' },
};

const HEX = /^#[0-9a-f]{6}$/i;
export const safeColor = (c, fallback = '#3B4FD8') => (HEX.test(String(c || '')) ? c : fallback);
export function safeUrl(u) { try { const x = new URL(String(u || '').trim()); return x.protocol === 'https:' ? x.toString() : ''; } catch { return ''; } }

// {{name}} style variables; values are escaped later with the rest of the text.
export const fillVars = (text, vars = {}) => String(text || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, k) => (vars[k] ?? ''));

// Plain text -> paragraphs and bullet lists. "- item" lines become a list; blank lines separate paragraphs.
function bodyHtml(text) {
  return String(text || '').split(/\r?\n\s*\r?\n/).map(block => {
    const lines = block.split(/\r?\n/).filter(l => l.trim());
    if (!lines.length) return '';
    if (lines.every(l => /^\s*-\s+/.test(l))) return `<ul style="margin:0 0 16px 20px;padding:0">${lines.map(l => `<li style="margin:0 0 6px">${escapeHtml(l.replace(/^\s*-\s+/, ''))}</li>`).join('')}</ul>`;
    return `<p style="margin:0 0 16px;line-height:1.55">${lines.map(escapeHtml).join('<br>')}</p>`;
  }).join('');
}

export function renderEmail({ template = 'plain', headline = '', body = '', ctaText = '', ctaUrl = '', brand = {}, vars = {} } = {}) {
  const t = TEMPLATES[template] || TEMPLATES.plain;
  const color = safeColor(brand.color, t.accent);
  const h = fillVars(headline, vars), b = fillVars(body, vars);
  const url = safeUrl(ctaUrl), cta = String(ctaText || '').trim().slice(0, 60);
  const footer = escapeHtml(fillVars(brand.footer || '', vars)), sig = fillVars(brand.signature || '', vars);
  const html = `<!doctype html><html><body style="margin:0;background:#f3f5fa;font-family:Segoe UI,Arial,sans-serif;color:#161b2e">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f5fa;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden">
<tr><td style="background:${color};padding:18px 28px;color:#ffffff;font-size:18px;font-weight:700">${escapeHtml(String(brand.name || 'NexpatchOnline').slice(0, 80))}</td></tr>
<tr><td style="padding:28px">${h ? `<h1 style="margin:0 0 16px;font-size:22px;line-height:1.3;color:${color}">${escapeHtml(h)}</h1>` : ''}${bodyHtml(b)}${url && cta ? `<p style="margin:24px 0"><a href="${escapeHtml(url)}" style="background:${color};color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:8px;display:inline-block;font-weight:600">${escapeHtml(cta)}</a></p>` : ''}${sig ? `<p style="margin:24px 0 0;line-height:1.55">${escapeHtml(sig).replace(/\r?\n/g, '<br>')}</p>` : ''}</td></tr>
<tr><td style="padding:16px 28px;background:#f7f8fc;color:#555e78;font-size:12px;line-height:1.5">${footer || 'You are receiving this message because your organization uses NexpatchOnline.'}</td></tr>
</table></td></tr></table></body></html>`;
  const text = [h, '', b, url && cta ? `\n${cta}: ${url}` : '', sig ? `\n${sig}` : '', '\n--', brand.footer ? fillVars(brand.footer, vars) : 'You are receiving this message because your organization uses NexpatchOnline.'].join('\n').trim();
  return { html, text };
}
