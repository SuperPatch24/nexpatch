import { app } from '@azure/functions';
import { withUser, HttpError, readJson } from '../lib/http.js';
import { listMemberRows, getMemberRow, saveMemberRow, deleteMemberRow, inviteKey, audit, listAudit } from '../lib/store.js';
import { ROLES } from '../lib/access.js';

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
    if (rows.length >= 200) throw new HttpError(409, 'An organization can have up to 200 people in Nexpatch.');
    const row = await saveMemberRow(user.tenantId, inviteKey(email), {
      kind: 'invite', role, email, name: '', addedBy: user.email || user.userId, addedAt: new Date().toISOString()
    });
    await audit(user.tenantId, user.email || user.userId, 'invited', `${email} as ${role}`);
    return shape(row);
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
