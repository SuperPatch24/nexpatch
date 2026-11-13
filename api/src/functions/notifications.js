import { app } from '@azure/functions';
import { randomUUID } from 'node:crypto';
import { withUser, HttpError, readJson } from '../lib/http.js';
import { getRow, putRow, listRows, getTenant, listMemberRows, audit } from '../lib/store.js';
import { graphAll } from '../lib/graph.js';
import { emailIsConfigured, sendBrevoEmail } from '../lib/email.js';
import { renderEmail } from '../lib/email-templates.js';
import { SEVERITIES, NOTICE_TEMPLATES, cleanNotice, cleanSettings, buildToastScript } from '../lib/notifications.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SEND_CAP = 100;
const table = 'Notices';
const shape = r => ({ id: r.rowKey, title: r.title, message: r.message, severity: r.severity, template: r.template, status: r.status, audience: r.audienceLabel || '', channels: (r.channels || '').split(',').filter(Boolean),
  recipients: r.recipients || 0, emailsSent: r.emailsSent || 0, emailsFailed: r.emailsFailed || 0, expiresAt: r.expiresAt, createdAt: r.createdAt, createdBy: r.createdBy, resolvedAt: r.resolvedAt || null });
const isLive = r => r.status === 'active' && Date.parse(r.expiresAt) > Date.now();
const getSettings = async tid => { const r = await getRow(table, tid, 'settings'); return { orgName: r?.orgName || '', supportEmail: r?.supportEmail || '', footer: r?.footer || '', color: r?.color || '' }; };

// Who receives the email. Group members come from Microsoft Graph and need the group-read permission; if it is missing the admin gets a clear message.
async function resolveRecipients(tid, a = {}) {
  const set = new Map(), add = (email, name = '') => { const e = String(email || '').trim().toLowerCase(); if (EMAIL_RE.test(e) && !set.has(e)) set.set(e, name); };
  if (a.type === 'emails') String(a.emails || '').split(/[,;\s]+/).forEach(e => add(e));
  else if (a.type === 'admins' || a.type === 'members') for (const m of await listMemberRows(tid)) { if (m.kind === 'member' && (a.type === 'members' || ['owner', 'admin'].includes(m.role))) add(m.email, m.name); }
  else if (a.type === 'group') {
    if (!/^[0-9a-f-]{36}$/i.test(String(a.groupId || ''))) throw new HttpError(400, 'Choose a group.');
    try { for (const u of await graphAll(tid, `/v1.0/groups/${a.groupId}/transitiveMembers/microsoft.graph.user?$select=mail,displayName&$top=999`)) add(u.mail, u.displayName); }
    catch { throw new HttpError(502, 'Couldn’t read that group’s members. Your Intune connection may need the GroupMember.Read.All permission.'); }
  } else throw new HttpError(400, 'Choose who should receive the notice.');
  return [...set].map(([email, name]) => ({ email, name }));
}
const label = a => ({ emails: 'Listed email addresses', admins: 'Organization admins', members: 'Everyone with portal access', group: 'Entra group' }[a?.type] || '');

app.http('noticeTemplates', { methods: ['GET'], authLevel: 'anonymous', route: 'notifications/templates', handler: withUser(async (_r, _c, user) => ({
  templates: Object.entries(NOTICE_TEMPLATES).map(([id, t]) => ({ id, ...t })), severities: Object.entries(SEVERITIES).map(([id, s]) => ({ id, ...s })), settings: await getSettings(user.tenantId), sendCap: SEND_CAP, emailReady: emailIsConfigured() }), 'admin') });

app.http('noticeSettingsSave', { methods: ['PUT'], authLevel: 'anonymous', route: 'notifications/settings', handler: withUser(async (req, _c, user) => {
  const c = cleanSettings(await readJson(req)); if (c.error) throw new HttpError(400, c.error);
  await putRow(table, user.tenantId, 'settings', { ...c.value, updatedAt: new Date().toISOString(), updatedBy: user.email || user.userId }, 'Replace');
  await audit(user.tenantId, user.email || user.userId, 'notifications.settings', ''); return { settings: c.value };
}, 'admin') });

app.http('noticeList', { methods: ['GET'], authLevel: 'anonymous', route: 'notifications', handler: withUser(async (_r, _c, user) => ({
  notices: (await listRows(table, user.tenantId, 500)).filter(r => r.rowKey !== 'settings').sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 50).map(shape) }), 'admin') });

// Everyone signed in sees active notices as a banner in the portal.
app.http('noticeActive', { methods: ['GET'], authLevel: 'anonymous', route: 'notifications/active', handler: withUser(async (_r, _c, user) => ({
  notices: (await listRows(table, user.tenantId, 500)).filter(r => r.rowKey !== 'settings' && isLive(r) && (r.channels || '').includes('banner')).map(r => ({ id: r.rowKey, title: r.title, message: r.message, severity: r.severity, ctaText: r.ctaText || '', ctaUrl: r.ctaUrl || '' })) }), 'viewer') });

async function sendEmails(ctx, user, n, recipients, settings, tenantName) {
  if (!emailIsConfigured()) throw new HttpError(503, 'Email isn’t set up on this platform yet, so email delivery is unavailable.');
  let sent = 0, failed = 0;
  const brand = { name: settings.orgName || tenantName || 'Your IT team', color: settings.color || SEVERITIES[n.severity].color, footer: settings.footer || 'You are receiving this because your IT team uses NexpatchOnline to keep you informed.' };
  for (let i = 0; i < recipients.length; i += 5) await Promise.all(recipients.slice(i, i + 5).map(async r => {
    const { html, text } = renderEmail({ template: 'plain', headline: n.title, body: n.message, ctaText: n.ctaText, ctaUrl: n.ctaUrl, brand, vars: { name: r.name ? r.name.split(' ')[0] : 'there' } });
    const res = await sendBrevoEmail({ to: r.email, subject: `${n.severity === 'resolved' ? 'Resolved: ' : n.severity === 'critical' ? 'Outage: ' : ''}${n.title}`.slice(0, 180), htmlContent: html, textContent: text, tags: ['tenant-notice', n.severity], replyTo: settings.supportEmail || undefined }, ctx);
    res.sent ? sent++ : failed++;
  }));
  return { sent, failed };
}

app.http('noticeSend', { methods: ['POST'], authLevel: 'anonymous', route: 'notifications', handler: withUser(async (req, ctx, user) => {
  const b = await readJson(req);
  const c = cleanNotice(b); if (c.error) throw new HttpError(400, c.error);
  const channels = ['email', 'banner'].filter(k => b.channels?.[k]);
  if (!channels.length) throw new HttpError(400, 'Choose at least one way to deliver the notice (email or portal banner).');
  const t = await getTenant(user.tenantId); if (!t || t.status !== 'active') throw new HttpError(409, 'Connect your organization first.');
  const settings = await getSettings(user.tenantId);
  let recipients = [];
  if (channels.includes('email')) {
    recipients = await resolveRecipients(user.tenantId, b.audience);
    if (!recipients.length) throw new HttpError(400, 'That audience has no email addresses.');
    if (recipients.length > SEND_CAP) throw new HttpError(400, `That audience has ${recipients.length} people. Email notices are limited to ${SEND_CAP} at a time; choose a smaller group.`);
  }
  const id = randomUUID(), now = new Date(), expiresAt = new Date(now.getTime() + c.value.expiresInHours * 3600e3).toISOString();
  const result = channels.includes('email') ? await sendEmails(ctx, user, c.value, recipients, settings, t.displayName || '') : { sent: 0, failed: 0 };
  await putRow(table, user.tenantId, id, { ...c.value, status: 'active', channels: channels.join(','), audienceLabel: channels.includes('email') ? label(b.audience) : '', audienceJson: JSON.stringify(b.audience || {}).slice(0, 2000),
    recipients: recipients.length, emailsSent: result.sent, emailsFailed: result.failed, expiresAt, createdAt: now.toISOString(), createdBy: user.email || user.userId }, 'Replace');
  await audit(user.tenantId, user.email || user.userId, 'notice.sent', `${c.value.severity}: ${c.value.title} (${result.sent} emails)`);
  return { notice: shape(await getRow(table, user.tenantId, id)) };
}, 'admin') });

// Marks a notice resolved (banner disappears) and can send the "restored" follow-up to the same audience.
app.http('noticeResolve', { methods: ['POST'], authLevel: 'anonymous', route: 'notifications/{id}/resolve', handler: withUser(async (req, ctx, user) => {
  const id = String(req.params.id || ''), row = await getRow(table, user.tenantId, id);
  if (!row || id === 'settings') throw new HttpError(404, 'That notice wasn’t found.');
  const b = await readJson(req).catch(() => ({}));
  let followUp = { sent: 0, failed: 0 };
  if (b.sendFollowUp && (row.channels || '').includes('email')) {
    const recipients = await resolveRecipients(user.tenantId, JSON.parse(row.audienceJson || '{}'));
    const t = await getTenant(user.tenantId);
    followUp = await sendEmails(ctx, user, { severity: 'resolved', title: `Resolved: ${row.title}`.slice(0, 100), message: String(b.followUpMessage || 'The issue described in our earlier notice has been resolved. Thank you for your patience.').slice(0, 2000), ctaText: '', ctaUrl: '' }, recipients.slice(0, SEND_CAP), await getSettings(user.tenantId), t?.displayName || '');
  }
  await putRow(table, user.tenantId, id, { status: 'resolved', resolvedAt: new Date().toISOString(), resolvedBy: user.email || user.userId }, 'Merge');
  await audit(user.tenantId, user.email || user.userId, 'notice.resolved', row.title);
  return { resolved: true, followUp };
}, 'admin') });

app.http('noticeToastScript', { methods: ['GET'], authLevel: 'anonymous', route: 'notifications/{id}/toast-script', handler: withUser(async (req, _c, user) => {
  const row = await getRow(table, user.tenantId, String(req.params.id || ''));
  if (!row || row.rowKey === 'settings') throw new HttpError(404, 'That notice wasn’t found.');
  const settings = await getSettings(user.tenantId);
  return { filename: `nexpatch-notice-${row.rowKey.slice(0, 8)}.ps1`, script: buildToastScript({ title: row.title, message: row.message, severity: row.severity, ctaText: row.ctaText, ctaUrl: row.ctaUrl, expiresAt: row.expiresAt, orgName: settings.orgName }) };
}, 'admin') });
