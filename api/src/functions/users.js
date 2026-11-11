import { app } from '@azure/functions';
import { withUser, HttpError, readJson } from '../lib/http.js';
import { listMemberRows, getMemberRow, saveMemberRow, deleteMemberRow, inviteKey, audit, listAudit } from '../lib/store.js';
import { ROLES } from '../lib/access.js';
import { emailIsConfigured, sendBrevoEmail } from '../lib/email.js';
import { escapeHtml } from '../lib/email.js';

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const shape = m => ({
  id: m.rowKey, kind: m.kind, role: m.role, name: m.name || '', email: m.email || '',
  addedBy: m.addedBy || '', addedAt: m.addedAt || null, joinedAt: m.joinedAt || null, lastSeenAt: m.lastSeenAt || null
});
const ownersLeft = (rows, exceptId) => rows.filter(m => m.kind === 'member' && m.role === 'owner' && m.rowKey !== exceptId).length;

// GET /api/users – people with access to this organization, and pending invitations.
app.http('usersList', {
  methods: ['GET'], authLevel: 'anonymous', route: 'users',
  handler: withUser(async (_req, _ctx, user) => {
    const rows = await listMemberRows(user.tenantId);
    return { you: { userId: user.userId, role: user.role, access: user.access }, people: rows.map(shape) };
  }, 'admin')
});

// POST /api/users – invite someone from the same organization by their sign-in name.
app.http('usersInvite', {
  methods: ['POST'], authLevel: 'anonymous', route: 'users',
  handler: withUser(async (req, _ctx, user) => {
    const body = await readJson(req);
    const email = String(body.email || '').trim().toLowerCase();
    const role = String(body.role || '');
    if (!EMAIL.test(email)) throw new HttpError(400, 'Enter the person\u2019s work email (their Microsoft sign-in name).');
    if (!ROLES.includes(role)) throw new HttpError(400, 'Choose Viewer, Admin or Owner.');
    const rows = await listMemberRows(user.tenantId);
    if (rows.some(m => (m.email || '').toLowerCase() === email)) throw new HttpError(409, 'This person already has access or an invitation.');
    if (rows.length >= 200) throw new HttpError(409, 'An organization can have up to 200 people in NexpatchOnline.');
    const row = await saveMemberRow(user.tenantId, inviteKey(email), {
      kind: 'invite', role, email, name: '', addedBy: user.email || user.userId, addedAt: new Date().toISOString()
    });
    await audit(user.tenantId, user.email || user.userId, 'invited', `${email} as ${role}`);
    // Invitations are email notifications; access is granted on first sign-in
    // when the Microsoft account email matches this pending invitation.
    const appUrl = String(process.env.PUBLIC_APP_URL || process.env.WEBSITE_URL || 'https://nexpatchonline.com').replace(/\/$/, '');
    const invitationUrl = `${appUrl}/`;
    const emailResult = await sendBrevoEmail({
      to: [{ email }],
      subject: `You have been invited to NexpatchOnline`,
      htmlContent: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;color:#17212b"><h2>You’re invited to NexpatchOnline</h2><p>${escapeHtml(user.name || user.email || 'An organization administrator')} invited you to join their NexpatchOnline workspace as <b>${escapeHtml(role)}</b>.</p><p>Sign in with this exact Microsoft work account: <b>${escapeHtml(email)}</b>.</p><p><a href="${invitationUrl}" style="display:inline-block;padding:12px 18px;background:#126b52;color:white;text-decoration:none;border-radius:6px">Open NexpatchOnline</a></p><p>Your access will be activated automatically after you sign in with the invited account.</p></div>`,
      textContent: `You have been invited to NexpatchOnline as ${role}. Sign in at ${invitationUrl} using ${email}. Access activates when you sign in with this exact Microsoft account.`,
      tags: ['nexpatchonline', 'user-invitation']
    });
    return { ...shape(row), emailSent: !!emailResult.sent, emailReason: emailResult.sent ? '' : (emailResult.reason || 'email-not-configured'), emailStatus: emailResult.status || null };
  }, 'owner')
});

// PATCH /api/users/{id} – change someone's role.
app.http('usersUpdate', {
  methods: ['PATCH'], authLevel: 'anonymous', route: 'users/{id}',
  handler: withUser(async (req, _ctx, user) => {
    const id = req.params.id;
    const { role } = await readJson(req);
    if (!ROLES.includes(role)) throw new HttpError(400, 'Choose Viewer, Admin or Owner.');
    const row = await getMemberRow(user.tenantId, id);
    if (!row) throw new HttpError(404, 'That person no longer has access.');
    if (row.role === 'owner' && role !== 'owner' && ownersLeft(await listMemberRows(user.tenantId), id) === 0) {
      throw new HttpError(409, 'Add another owner before changing the last owner\u2019s role.');
    }
    const updated = await saveMemberRow(user.tenantId, id, { role });
    await audit(user.tenantId, user.email || user.userId, 'changed role', `${row.email || row.name}: ${row.role} \u2192 ${role}`);
    return shape(updated);
  }, 'owner')
});

// DELETE /api/users/{id} – remove someone's access, or cancel an invitation.
app.http('usersRemove', {
  methods: ['DELETE'], authLevel: 'anonymous', route: 'users/{id}',
  handler: withUser(async (req, _ctx, user) => {
    const id = req.params.id;
    const row = await getMemberRow(user.tenantId, id);
    if (!row) return { removed: true };
    if (row.kind === 'member' && row.role === 'owner' && ownersLeft(await listMemberRows(user.tenantId), id) === 0) {
      throw new HttpError(409, 'An organization needs at least one owner. Add another owner first.');
    }
    await deleteMemberRow(user.tenantId, id);
    await audit(user.tenantId, user.email || user.userId, row.kind === 'invite' ? 'cancelled invitation' : 'removed access', row.email || row.name);
    return { removed: true };
  }, 'owner')
});

// GET /api/audit – recent activity for this organization.
app.http('auditList', {
  methods: ['GET'], authLevel: 'anonymous', route: 'audit',
  handler: withUser(async (_req, _ctx, user) => ({ events: await listAudit(user.tenantId, 50) }), 'admin')
});
