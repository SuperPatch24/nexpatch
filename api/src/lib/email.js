const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function emailIsConfigured() {
  return Boolean(process.env.BREVO_API_KEY && process.env.BREVO_SENDER_EMAIL && EMAIL_RE.test(process.env.BREVO_SENDER_EMAIL));
}

export async function adminEmailRecipients() {
  let configured = [];
  try { const { getRow } = await import('./store.js'); const row = await getRow('EmailConfig', 'global', 'recipients'); if (Array.isArray(row?.recipients)) configured = row.recipients; } catch { /* Storage may not be configured in local/test environments. */ }
  const source = configured.length ? configured.join(';') : String(process.env.BREVO_ADMIN_EMAILS || '');
  return source.split(/[;,]/).map(value => value.trim().toLowerCase()).filter(value => EMAIL_RE.test(value));
}

export function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

// Transactional email is deliberately best-effort: an email provider outage must
// never roll back a client request, status change, or sales enquiry.
export async function sendBrevoEmail({ to, subject, htmlContent, textContent, tags = [] }, logger = console) {
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
        ...(tags.length ? { tags: tags.map(String).slice(0, 5) } : {})
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
  return sendBrevoEmail({ ...message, to: recipients }, logger);
}
