import { app } from '@azure/functions';
import { randomUUID } from 'node:crypto';
import { withUser, HttpError, readJson } from '../lib/http.js';
import { getRow, putRow, listRows, audit, listActiveTenants, listMemberRows } from '../lib/store.js';
import { emailIsConfigured, sendBrevoEmail, adminEmailRecipients } from '../lib/email.js';
import { TEMPLATES, renderEmail, safeColor, safeUrl } from '../lib/email-templates.js';
import { platformRole } from '../lib/platform.js';

const GLOBAL = 'global';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function requireEmailAdmin(user) {
  const role = platformRole(user);
  if (!['superadmin', 'support'].includes(role)) throw new HttpError(403, 'Your platform role cannot access Communications Center.');
}
function cleanAddress(value) { return String(value || '').trim().toLowerCase(); }
function shapeMessage(row) { return { id: row.rowKey, to: row.to || '', subject: row.subject || '', text: row.text || '', html: row.html || '', status: row.status || 'sent', messageId: row.messageId || '', createdAt: row.createdAt || '', createdBy: row.createdBy || '' }; }

app.http('platformEmailRecipientsGet', { methods: ['GET'], authLevel: 'anonymous', route: 'platform/email/recipients', handler: withUser(async (_req, _ctx, user) => {
  requireEmailAdmin(user);
  const row = await getRow('EmailConfig', GLOBAL, 'recipients');
  return { recipients: Array.isArray(row?.recipients) ? row.recipients : [] };
}, 'any') });

app.http('platformEmailRecipientsSave', { methods: ['PUT'], authLevel: 'anonymous', route: 'platform/email/recipients', handler: withUser(async (req, _ctx, user) => {
  requireEmailAdmin(user);
  const body = await readJson(req);
  const raw = Array.isArray(body.recipients) ? body.recipients : [];
  if (raw.length > 30) throw new HttpError(400, 'You can save up to 30 admin recipients.');
  const recipients = [...new Set(raw.map(cleanAddress).filter(x => EMAIL_RE.test(x)))];
  if (recipients.length !== raw.length) throw new HttpError(400, 'Every recipient must be a valid email address; duplicates are not allowed.');
  await putRow('EmailConfig', GLOBAL, 'recipients', { recipients, updatedAt: new Date().toISOString(), updatedBy: user.email || user.userId }, 'Replace');
  await audit(GLOBAL, user.email || user.userId, 'email.recipients.updated', `${recipients.length} recipients`);
  return { recipients };
}, 'any') });

app.http('platformEmailSentList', { methods: ['GET'], authLevel: 'anonymous', route: 'platform/email/sent', handler: withUser(async (_req, _ctx, user) => {
  requireEmailAdmin(user);
  const rows = await listRows('EmailMessages', GLOBAL, 500);
  return { messages: rows.sort((a,b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0,100).map(shapeMessage) };
}, 'any') });

const BULK_CAP = 50;
async function getBranding() { const r = await getRow('EmailConfig', GLOBAL, 'branding'); return { color: r?.color || '', footer: r?.footer || '', signature: r?.signature || '' }; }
const firstName = e => { const p = String(e).split('@')[0].split(/[._-]/)[0]; return p ? p[0].toUpperCase() + p.slice(1) : 'there'; };

app.http('platformEmailTemplates', { methods: ['GET'], authLevel: 'anonymous', route: 'platform/email/templates', handler: withUser(async (_req, _ctx, user) => {
  requireEmailAdmin(user);
  return { templates: Object.entries(TEMPLATES).map(([id, t]) => ({ id, label: t.label, accent: t.accent, subject: t.subject, headline: t.headline, body: t.body })), branding: await getBranding(), bulkCap: BULK_CAP };
}, 'any') });

app.http('platformEmailBrandingSave', { methods: ['PUT'], authLevel: 'anonymous', route: 'platform/email/branding', handler: withUser(async (req, _ctx, user) => {
  requireEmailAdmin(user);
  const b = await readJson(req);
  const color = b.color ? safeColor(b.color, '') : '';
  if (b.color && !color) throw new HttpError(400, 'The brand color must look like #3B4FD8.');
  const row = { color, footer: String(b.footer || '').slice(0, 500), signature: String(b.signature || '').slice(0, 300), updatedAt: new Date().toISOString(), updatedBy: user.email || user.userId };
  await putRow('EmailConfig', GLOBAL, 'branding', row, 'Replace');
  await audit(GLOBAL, user.email || user.userId, 'email.branding.updated', '');
  return { branding: { color: row.color, footer: row.footer, signature: row.signature } };
}, 'any') });

function mailParts(body) {
  const ctaUrl = String(body.ctaUrl || '').trim();
  if (ctaUrl && !safeUrl(ctaUrl)) throw new HttpError(400, 'The button link must be a valid https:// address.');
  return { template: TEMPLATES[body.template] ? body.template : 'plain', headline: String(body.headline || '').slice(0, 160), body: String(body.text || '').slice(0, 12000), ctaText: String(body.ctaText || '').slice(0, 60), ctaUrl };
}

app.http('platformEmailPreview', { methods: ['POST'], authLevel: 'anonymous', route: 'platform/email/preview', handler: withUser(async (req, _ctx, user) => {
  requireEmailAdmin(user);
  const parts = mailParts(await readJson(req));
  return renderEmail({ ...parts, brand: await getBranding(), vars: { name: 'Alex', company: 'Contoso', date: 'a date you choose' } });
}, 'any') });

// Audiences: one address, the saved admin list, or every owner/admin of an active organization. Each person gets their own copy
// (never a shared To line), so customers can't see each other's addresses.
async function resolveAudience(body, user) {
  if (body.testOnly) return [{ email: cleanAddress(user.email) }];
  if (body.audience === 'saved') return (await adminEmailRecipients()).map(email => ({ email }));
  if (body.audience === 'tenant-admins') {
    const seen = new Set(), out = [];
    for (const t of await listActiveTenants()) for (const m of await listMemberRows(t.rowKey)) {
      const email = cleanAddress(m.email);
      if (m.kind === 'member' && ['owner', 'admin'].includes(m.role) && EMAIL_RE.test(email) && !seen.has(email)) { seen.add(email); out.push({ email, name: m.name || '' }); }
    }
    return out;
  }
  const to = cleanAddress(body.to);
  if (!EMAIL_RE.test(to)) throw new HttpError(400, 'Enter a valid recipient email address.');
  return [{ email: to }];
}

app.http('platformEmailCompose', { methods: ['POST'], authLevel: 'anonymous', route: 'platform/email/send', handler: withUser(async (req, ctx, user) => {
  requireEmailAdmin(user);
  if (!emailIsConfigured()) throw new HttpError(503, 'Brevo is not configured. Check the Azure Function App settings.');
  const body = await readJson(req);
  const parts = mailParts(body);
  const subject = String(body.subject || '').trim().slice(0, 180);
  if (!subject || (!parts.body && !parts.headline)) throw new HttpError(400, 'Subject and message are required.');
  const replyTo = cleanAddress(body.replyTo), cc = String(body.cc || '').split(/[,;\s]+/).map(cleanAddress).filter(Boolean).slice(0, 5), bcc = String(body.bcc || '').split(/[,;\s]+/).map(cleanAddress).filter(Boolean).slice(0, 5);
  if (replyTo && !EMAIL_RE.test(replyTo)) throw new HttpError(400, 'The reply-to address is not valid.');
  if ([...cc, ...bcc].some(a => !EMAIL_RE.test(a))) throw new HttpError(400, 'Every CC and BCC address must be valid.');
  let scheduledAt = '';
  if (body.scheduleAt) {
    const when = Date.parse(body.scheduleAt);
    if (!Number.isFinite(when) || when < Date.now() + 60e3 || when > Date.now() + 72 * 3600e3) throw new HttpError(400, 'Schedule the email between 1 minute and 72 hours from now.');
    scheduledAt = new Date(when).toISOString();
  }
  const audience = await resolveAudience(body, user);
  if (!audience.length) throw new HttpError(400, 'No recipients found for that audience.');
  if (audience.length > BULK_CAP) throw new HttpError(400, `This audience has ${audience.length} people; sends are limited to ${BULK_CAP} at a time. Send it in smaller groups.`);
  const brand = await getBranding();
  let sent = 0, failed = 0;
  for (let i = 0; i < audience.length; i += 5) {
    await Promise.all(audience.slice(i, i + 5).map(async r => {
      const { html, text } = renderEmail({ ...parts, brand, vars: { name: r.name ? r.name.split(' ')[0] : firstName(r.email), company: '', date: '' } });
      const result = await sendBrevoEmail({ to: r.email, subject: (body.testOnly ? '[TEST] ' : '') + subject, htmlContent: html, textContent: text, tags: ['admin-center', parts.template], replyTo, cc, bcc, scheduledAt }, ctx);
      result.sent ? sent++ : failed++;
      await putRow('EmailMessages', GLOBAL, randomUUID(), { to: r.email, subject, text: parts.body, template: parts.template, status: result.sent ? (scheduledAt ? 'scheduled' : 'sent') : 'failed', scheduledAt, messageId: result.messageId || '', createdAt: new Date().toISOString(), createdBy: user.email || user.userId, provider: 'brevo' }, 'Replace');
    }));
  }
  await audit(GLOBAL, user.email || user.userId, 'email.sent', `${sent} sent, ${failed} failed; template ${parts.template}; subject ${subject}`);
  if (!sent) throw new HttpError(502, 'Brevo did not accept the message. The failed attempts were recorded.');
  return { sent, failed, total: audience.length, scheduledAt: scheduledAt || null };
}, 'any') });
