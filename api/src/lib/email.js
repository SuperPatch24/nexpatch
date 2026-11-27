const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

import { createHash, createHmac } from 'node:crypto';

// Email is sent through Azure Communication Services Email, which lives in the same Azure portal as the rest of the platform.
// Two settings turn it on:
//   ACS_EMAIL_CONNECTION_STRING  the resource's connection string ("endpoint=https://NAME.communication.azure.com/;accesskey=...")
//   EMAIL_SENDER                 a sender address from a verified domain (for example notifications@nexpatchonline.com)
// Brevo (BREVO_API_KEY + BREVO_SENDER_EMAIL) still works, and is used only when the Azure settings are absent.
export function parseConnectionString(cs) {
  const m = {};
  for (const part of String(cs || '').split(';')) { const i = part.indexOf('='); if (i > 0) m[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim(); }
  try { const u = new URL(m.endpoint || ''); if (u.protocol !== 'https:' || !u.hostname.endsWith('.communication.azure.com') && !u.hostname.endsWith('.communication.azure.us') && !u.hostname.endsWith('.communication.azure.cn')) return null; if (!m.accesskey) return null; return { endpoint: u.origin, host: u.host, key: m.accesskey }; } catch { return null; }
}
export function emailProvider(env = process.env) {
  if (parseConnectionString(env.ACS_EMAIL_CONNECTION_STRING) && EMAIL_RE.test(String(env.EMAIL_SENDER || ''))) return 'acs';
  if (env.BREVO_API_KEY && EMAIL_RE.test(String(env.BREVO_SENDER_EMAIL || ''))) return 'brevo';
  return '';
}
export const emailIsConfigured = () => Boolean(emailProvider());
export const emailSupportsScheduling = () => emailProvider() === 'brevo';
export const emailSenderAddress = (env = process.env) => emailProvider(env) === 'acs' ? env.EMAIL_SENDER : (env.BREVO_SENDER_EMAIL || env.EMAIL_SENDER || '');
export const emailSenderName = (env = process.env) => env.EMAIL_SENDER_NAME || env.BREVO_SENDER_NAME || 'NexpatchOnline';
export const ACS_API_VERSION = '2023-03-31';

// Azure Communication Services signs each request with HMAC-SHA256 over the method, path, date, host and body hash.
export function signAcsRequest({ method = 'POST', pathAndQuery, host, body = '', key, date = new Date().toUTCString() }) {
  const contentHash = createHash('sha256').update(body).digest('base64');
  const signature = createHmac('sha256', Buffer.from(key, 'base64')).update(`${method.toUpperCase()}\n${pathAndQuery}\n${date};${host};${contentHash}`).digest('base64');
  return { 'x-ms-date': date, 'x-ms-content-sha256': contentHash, Authorization: `HMAC-SHA256 SignedHeaders=x-ms-date;host;x-ms-content-sha256&Signature=${signature}` };
}

export async function adminEmailRecipients() {
  let configured = [];
  try { const { getRow } = await import('./store.js'); const row = await getRow('EmailConfig', 'global', 'recipients'); if (Array.isArray(row?.recipients)) configured = row.recipients; } catch { /* Storage may not be configured in local/test environments. */ }
  const source = configured.length ? configured.join(';') : String(process.env.EMAIL_ADMIN_EMAILS || process.env.BREVO_ADMIN_EMAILS || '');
  return source.split(/[;,]/).map(value => value.trim().toLowerCase()).filter(value => EMAIL_RE.test(value));
}

export function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

const cleanList = (a, max = 10) => (Array.isArray(a) ? a : []).map(x => typeof x === 'string' ? x : x?.email).filter(x => EMAIL_RE.test(String(x || ''))).slice(0, max).map(address => ({ address }));

async function sendViaAcs({ to, subject, htmlContent, textContent, replyTo, cc, bcc }, logger) {
  const conn = parseConnectionString(process.env.ACS_EMAIL_CONNECTION_STRING);
  const recipients = (Array.isArray(to) ? to : [to]).map(x => typeof x === 'string' ? { address: x } : { address: x?.email, ...(x?.name ? { displayName: String(x.name).slice(0, 100) } : {}) });
  const payload = JSON.stringify({
    senderAddress: process.env.EMAIL_SENDER,
    content: { subject: String(subject || 'NexpatchOnline notification').slice(0, 180), ...(htmlContent ? { html: String(htmlContent) } : {}), plainText: String(textContent || String(htmlContent || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || ' ') },
    recipients: { to: recipients, ...(cleanList(cc).length ? { cc: cleanList(cc) } : {}), ...(cleanList(bcc).length ? { bcc: cleanList(bcc) } : {}) },
    ...(replyTo && EMAIL_RE.test(replyTo) ? { replyTo: [{ address: replyTo }] } : {}),
    userEngagementTrackingDisabled: true
  });
  const pathAndQuery = `/emails:send?api-version=${ACS_API_VERSION}`;
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await fetch(conn.endpoint + pathAndQuery, { method: 'POST', headers: { 'content-type': 'application/json', ...signAcsRequest({ pathAndQuery, host: conn.host, body: payload, key: conn.key }) }, body: payload, signal: AbortSignal.timeout(15000) });
      if (response.status === 429 && attempt < 2) { const ra = Number(response.headers?.get?.('retry-after')); await new Promise(r => setTimeout(r, (Number.isFinite(ra) ? Math.min(10, ra) : 3) * 1000)); continue; }   // sending too fast: wait and try again
      const result = await response.json().catch(() => ({}));
      if (response.status !== 202 && !response.ok) { logger.warn?.('Email request failed', { status: response.status, code: result?.error?.code || '', message: result?.error?.message || '' }); return { sent: false, reason: 'provider-error', status: response.status }; }
      return { sent: true, messageId: result.id || null };
    }
    return { sent: false, reason: 'rate-limited' };
  } catch (error) {
    logger.warn?.('Email request could not be completed', { message: error?.message || 'Unknown error' });
    return { sent: false, reason: 'network-error' };
  }
}

// Transactional email is deliberately best-effort: an email provider outage must
// never roll back a client request, status change, or sales enquiry.
export async function sendEmail(message, logger = console) {
  const { to } = message || {};
  const recipients = (Array.isArray(to) ? to : [to]).map(item => typeof item === 'string' ? { email: item } : item).filter(item => item && EMAIL_RE.test(String(item.email || '')));
  if (!recipients.length) return { sent: false, reason: 'no-valid-recipient' };
  const provider = emailProvider();
  if (!provider) return { sent: false, reason: 'not-configured' };
  if (provider === 'acs') return sendViaAcs({ ...message, to: recipients }, logger);
  return sendViaBrevo(message, logger);
}
export const sendBrevoEmail = sendEmail;   // the old name, so nothing that already calls it breaks

async function sendViaBrevo({ to, subject, htmlContent, textContent, tags = [], replyTo, cc, bcc, scheduledAt }, logger = console) {
  const recipients = (Array.isArray(to) ? to : [to])
    .map(item => typeof item === 'string' ? { email: item } : item)
    .filter(item => item && EMAIL_RE.test(String(item.email || '')));
  if (!recipients.length) return { sent: false, reason: 'no-valid-recipient' };
  if (!emailIsConfigured()) return { sent: false, reason: 'not-configured' };

  try {
    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'api-key': process.env.BREVO_API_KEY
      },
      body: JSON.stringify({
        sender: {
          name: process.env.BREVO_SENDER_NAME || 'NexpatchOnline',
          email: process.env.BREVO_SENDER_EMAIL
        },
        to: recipients,
        subject: String(subject || 'NexpatchOnline notification').slice(0, 180),
        htmlContent: String(htmlContent || ''),
        ...(textContent ? { textContent: String(textContent) } : {}),
        ...(tags.length ? { tags: tags.map(String).slice(0, 5) } : {}),
        ...(replyTo && EMAIL_RE.test(replyTo) ? { replyTo: { email: replyTo } } : {}),
        ...(Array.isArray(cc) && cc.filter(a => EMAIL_RE.test(a)).length ? { cc: cc.filter(a => EMAIL_RE.test(a)).map(email => ({ email })) } : {}),
        ...(Array.isArray(bcc) && bcc.filter(a => EMAIL_RE.test(a)).length ? { bcc: bcc.filter(a => EMAIL_RE.test(a)).map(email => ({ email })) } : {}),
        ...(scheduledAt ? { scheduledAt: String(scheduledAt) } : {})
      }),
      signal: AbortSignal.timeout(12000)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      logger.warn?.('Brevo email request failed', { status: response.status, code: result.code || '', message: result.message || '' });
      return { sent: false, reason: 'provider-error', status: response.status };
    }
    return { sent: true, messageId: result.messageId || null };
  } catch (error) {
    logger.warn?.('Brevo email request could not be completed', { message: error?.message || 'Unknown error' });
    return { sent: false, reason: 'network-error' };
  }
}


export async function notifyPlatformAdmins(message, logger = console) {
  const recipients = await adminEmailRecipients();
  if (!recipients.length) return { sent: false, reason: 'no-admin-recipients' };
  return sendEmail({ ...message, to: recipients }, logger);
}
