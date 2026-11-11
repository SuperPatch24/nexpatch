import { app } from '@azure/functions';
import { withUser, HttpError, readJson } from '../lib/http.js';
import { emailIsConfigured, sendBrevoEmail } from '../lib/email.js';
import { platformRole } from '../lib/platform.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function requireSuperAdmin(user) {
  if (platformRole(user) !== 'superadmin') throw new HttpError(403, 'Only a NexpatchOnline Super Admin can test email delivery.');
}

app.http('platformEmailStatus', {
  methods: ['GET'], authLevel: 'anonymous', route: 'platform/email/status',
  handler: withUser(async (_req, _ctx, user) => {
    requireSuperAdmin(user);
    return {
      configured: emailIsConfigured(),
      senderEmail: process.env.BREVO_SENDER_EMAIL || '',
      senderName: process.env.BREVO_SENDER_NAME || 'NexpatchOnline',
      adminRecipientsConfigured: Boolean(String(process.env.BREVO_ADMIN_EMAILS || '').trim())
    };
  }, 'any')
});

app.http('platformEmailTest', {
  methods: ['POST'], authLevel: 'anonymous', route: 'platform/email/test',
  handler: withUser(async (req, ctx, user) => {
    requireSuperAdmin(user);
    if (!emailIsConfigured()) throw new HttpError(503, 'Email is not configured. Add BREVO_API_KEY and BREVO_SENDER_EMAIL to the Azure Function App settings.');
    const body = await readJson(req);
    const recipient = String(body.to || user.email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(recipient)) throw new HttpError(400, 'Enter a valid recipient email address.');
    const result = await sendBrevoEmail({
      to: [{ email: recipient, name: String(body.name || '').trim().slice(0, 100) }],
      subject: 'NexpatchOnline email test',
      htmlContent: '<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto"><h2>NexpatchOnline email is connected</h2><p>This is a test message from your NexpatchOnline platform.</p><p>Your Brevo integration can send transactional email from the configured sender.</p></div>',
      textContent: 'NexpatchOnline email is connected. This is a test message from your NexpatchOnline platform.',
      tags: ['nexpatchonline', 'email-test']
    }, ctx);
    if (!result.sent) throw new HttpError(502, 'Brevo did not accept the test email. Check the sender, API key and Brevo transactional email status.');
    return { sent: true, recipient, messageId: result.messageId };
  }, 'any')
});
