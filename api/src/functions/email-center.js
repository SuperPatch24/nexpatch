import { app } from '@azure/functions';
import { randomUUID } from 'node:crypto';
import { withUser, HttpError, readJson } from '../lib/http.js';
import { getRow, putRow, listRows, audit } from '../lib/store.js';
import { emailIsConfigured, sendBrevoEmail, escapeHtml } from '../lib/email.js';
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

app.http('platformEmailCompose', { methods: ['POST'], authLevel: 'anonymous', route: 'platform/email/send', handler: withUser(async (req, ctx, user) => {
  requireEmailAdmin(user);
  if (!emailIsConfigured()) throw new HttpError(503, 'Brevo is not configured. Check the Azure Function App settings.');
  const body = await readJson(req);
  const to = cleanAddress(body.to);
  const subject = String(body.subject || '').trim().slice(0, 180);
  const text = String(body.text || '').trim().slice(0, 12000);
  if (!EMAIL_RE.test(to)) throw new HttpError(400, 'Enter a valid recipient email address.');
  if (!subject || !text) throw new HttpError(400, 'Subject and message are required.');
  const html = `<div style="font-family:Arial,sans-serif;white-space:pre-wrap">${escapeHtml(text)}</div>`;
  const result = await sendBrevoEmail({ to, subject, htmlContent: html, textContent: text, tags: ['admin-center','support'] }, ctx);
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  await putRow('EmailMessages', GLOBAL, id, { to, subject, text, status: result.sent ? 'sent' : 'failed', messageId: result.messageId || '', createdAt, createdBy: user.email || user.userId, provider: 'brevo' }, 'Replace');
  await audit(GLOBAL, user.email || user.userId, 'email.sent', `To ${to}; subject ${subject}`);
  if (!result.sent) throw new HttpError(502, 'Brevo did not accept the message. The failed attempt was recorded.');
  return { sent: true, id, messageId: result.messageId || null, createdAt };
}, 'any') });
