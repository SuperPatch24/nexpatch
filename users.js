import { app } from '@azure/functions';
import { withUser, HttpError, readJson } from '../lib/http.js';
import { listMemberRows, getMemberRow, saveMemberRow, deleteMemberRow, inviteKey, audit, listAudit } from '../lib/store.js';
import { ROLES, GROUP_ROLES, clearAccessCache } from '../lib/access.js';
import { emailDomainAllowed, parseDomains } from '../lib/tenantsettings.js';
import { getTenant } from '../lib/store.js';
import { emailIsConfigured, sendBrevoEmail } from '../lib/email.js';
import { escapeHtml } from '../lib/email.js';

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const shape = m => ({
  id: m.rowKey, kind: m.kind, role: m.role, name: m.name || '', email: m.email || '',
  addedBy: m.addedBy || '', addedAt: m.addedAt || null, joinedAt: m.joinedAt || null, lastSeenAt: m.lastSeenAt || null,
  groupId: m.groupId || '', groupName: m.groupName || ''
});
// Admins and owners can both manage everything, so at least one of them must remain a named person.
const adminsLeft = (rows, exceptId) => rows.filter(m => m.kind === 'member' && (m.role === 'owner' || m.role === 'admin') && m.rowKey !== exceptId).length;
const isAdminRole = r => r === 'owner' || r === 'admin';
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// GET /api/users – people with access to this organization, and pending invitations.
app.http('usersList', {
  methods: ['GET'], authLevel: 'anonymous', route: 'users',
  handler: withUser(async (_req, _ctx, user) => {
    const rows = await listMemberRows(user.tenantId);
    return { you: { userId: user.userId, role: user.role, access: user.access }, people: rows.map(shape) };
  }, 'viewer')
});

// POST /api/users – invite someone from the same organization by their sign-in name.
app.http('usersInvite', {
  methods: ['POST'], authLevel: 'anonymous', route: 'users',
  handler: withUser(async (req, _ctx, user) => {
    const body = await readJson(req);
    const email = String(body.email || '').trim().toLowerCase();
    const role = String(body.role || '');
    if (!EMAIL.test(email)) throw new HttpError(400, 'Enter the person\u2019s work email (their Microsoft sign-in name).');
    if (!ROLES.includes(role)) throw new HttpError(400, 'Choose Viewer or Admin.');
    const t = await getTenant(user.tenantId);
    if (!emailDomainAllowed(email, t?.allowedDomains)) throw new HttpError(400, 'Invitations are limited to these email domains: ' + parseDomains(t.allowedDomains).join(', ') + '.');
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
  }, 'admin')
});

// PATCH /api/users/{id} – change someone's role.
app.http('usersUpdate', {
  methods: ['PATCH'], authLevel: 'anonymous', route: 'users/{id}',
  handler: withUser(async (req, _ctx, user) => {
    const id = req.params.id;
    const { role } = await readJson(req);
    if (!ROLES.includes(role)) throw new HttpError(400, 'Choose Viewer or Admin.');
    const row = await getMemberRow(user.tenantId, id);
    if (!row) throw new HttpError(404, 'That person no longer has access.');
    if (row.kind === 'group' && !GROUP_ROLES.includes(role)) throw new HttpError(400, 'A group can be Viewer or Admin.');
    if (row.kind === 'member' && isAdminRole(row.role) && !isAdminRole(role) && adminsLeft(await listMemberRows(user.tenantId), id) === 0) {
      throw new HttpError(409, 'Add another admin before changing the last admin\u2019s role.');
    }
    const updated = await saveMemberRow(user.tenantId, id, { role });
    clearAccessCache(user.tenantId);
    await audit(user.tenantId, user.email || user.userId, 'changed role', `${row.email || row.name}: ${row.role} \u2192 ${role}`);
    return shape(updated);
  }, 'admin')
});

// DELETE /api/users/{id} – remove someone's access, or cancel an invitation.
app.http('usersRemove', {
  methods: ['DELETE'], authLevel: 'anonymous', route: 'users/{id}',
  handler: withUser(async (req, _ctx, user) => {
    const id = req.params.id;
    const row = await getMemberRow(user.tenantId, id);
    if (!row) return { removed: true };
    if (row.kind === 'member' && isAdminRole(row.role) && adminsLeft(await listMemberRows(user.tenantId), id) === 0) {
      throw new HttpError(409, 'An organization needs at least one admin. Add another admin first.');
    }
    await deleteMemberRow(user.tenantId, id);
    clearAccessCache(user.tenantId);
    await audit(user.tenantId, user.email || user.userId, row.kind === 'invite' ? 'cancelled invitation' : row.kind === 'group' ? 'removed group access' : 'removed access', row.email || row.name || row.groupName);
    return { removed: true };
  }, 'admin')
});

// GET /api/audit – recent activity for this organization.
app.http('auditList', {
  methods: ['GET'], authLevel: 'anonymous', route: 'audit',
  handler: withUser(async (_req, _ctx, user) => ({ events: await listAudit(user.tenantId, 50) }), 'viewer')
});

// POST /api/users/groups – give everyone in an Entra group a role (Viewer or Admin). Membership is checked at sign-in,
// so adding or removing someone in Entra changes their access without any change here.
app.http('usersGroupAdd', {
  methods: ['POST'], authLevel: 'anonymous', route: 'access-groups',
  handler: withUser(async (req, _ctx, user) => {
    const body = await readJson(req);
    const groupId = String(body.groupId || '').trim(), role = String(body.role || '');
    const groupName = String(body.groupName || '').replace(/[\r\n]/g, ' ').trim().slice(0, 120);
    if (!GUID.test(groupId)) throw new HttpError(400, 'Choose a group from the search results.');
    if (!GROUP_ROLES.includes(role)) throw new HttpError(400, 'A group can be Viewer or Admin.');
    const rows = await listMemberRows(user.tenantId);
    if (rows.some(m => m.kind === 'group' && String(m.groupId).toLowerCase() === groupId.toLowerCase())) throw new HttpError(409, 'This group already has access. Change its role in the list instead.');
    if (rows.length >= 200) throw new HttpError(409, 'An organization can have up to 200 people and groups in NexpatchOnline.');
    const row = await saveMemberRow(user.tenantId, 'g_' + groupId.toLowerCase(), { kind: 'group', role, groupId: groupId.toLowerCase(), groupName, name: groupName, email: '', addedBy: user.email || user.userId, addedAt: new Date().toISOString() });
    clearAccessCache(user.tenantId);
    await audit(user.tenantId, user.email || user.userId, 'gave a group access', `${groupName || groupId} as ${role}`);
    return shape(row);
  }, 'admin')
});
