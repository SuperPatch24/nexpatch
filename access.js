// Who can use NexpatchOnline for an organization, and with which role.
import { getMemberRow, saveMemberRow, deleteMemberRow, listMemberRows, getTenant, inviteKey, memberKey, audit } from './store.js';
import { graph } from './graph.js';
import { accessOf, accessMessage, highestGrantedRole } from './tenantsettings.js';

export const ROLES = ['viewer', 'admin', 'owner'];
export const rank = role => ROLES.indexOf(role);
// Roles an Entra group can grant. Owner is reserved for people and Entra administrators.
export const GROUP_ROLES = ['viewer', 'admin'];

// Short in-memory caches keep sign-in fast: group grants per organization (1 min), group membership per person (5 min).
const grantCache = new Map(), memberCache = new Map(), tenantCache = new Map();
export function clearAccessCache(tenantId) {
  grantCache.delete(tenantId); tenantCache.delete(tenantId);
  for (const k of [...memberCache.keys()]) if (k.startsWith(tenantId + ':')) memberCache.delete(k);
}
const fresh = (c, k, ms) => { const v = c.get(k); return v && Date.now() - v.at < ms ? v : null; };

export async function accessTenant(tenantId) {
  const hit = fresh(tenantCache, tenantId, 30000); if (hit) return hit.v;
  const v = await getTenant(tenantId).catch(() => null); tenantCache.set(tenantId, { at: Date.now(), v }); return v;
}
async function grantsFor(tenantId) {
  const hit = fresh(grantCache, tenantId, 60000); if (hit) return hit.v;
  const v = (await listMemberRows(tenantId)).filter(r => r.kind === 'group' && GROUP_ROLES.includes(r.role) && r.groupId);
  grantCache.set(tenantId, { at: Date.now(), v }); return v;
}
// Highest role the person gets through Entra groups (nested groups count). Failures never block sign-in.
export async function groupRole(user, check = checkMemberGroups) {
  try {
    const grants = await grantsFor(user.tenantId); if (!grants.length) return null;
    const key = user.tenantId + ':' + user.userId + ':' + grants.map(g => g.groupId).sort().join(',');
    let hit = fresh(memberCache, key, 300000);
    if (!hit) { hit = { at: Date.now(), v: new Set(await check(user.tenantId, user.userId, grants.map(g => g.groupId))) }; memberCache.set(key, hit); }
    return highestGrantedRole(grants, hit.v, GROUP_ROLES);
  } catch { return null; }
}
async function checkMemberGroups(tenantId, userId, ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += 20) {
    const res = await graph(tenantId, `/v1.0/users/${encodeURIComponent(userId)}/checkMemberGroups`, { method: 'POST', body: JSON.stringify({ groupIds: ids.slice(i, i + 20) }) });
    out.push(...(res.value || []));
  }
  return out;
}
const higher = (a, b) => (rank(a) >= rank(b) ? a : b);

// Entra Global Administrator and Intune Administrator always have owner access,
// so an organization can never lock itself out.
const ENTRA_ADMIN_ROLE_IDS = new Set([
  '62e90394-69f5-4237-9190-012177145e10', // Global Administrator
  '3a2c62db-5318-420d-8d74-23affee5d9d5'  // Intune Administrator
]);
export const isEntraAdmin = user => user.directoryRoles.some(r => ENTRA_ADMIN_ROLE_IDS.has(r));

export async function resolveAccess(user) {
  const tid = user.tenantId;
  const tenant = await accessTenant(tid);
  const status = accessOf(tenant);
  const wrap = r => ({ ...r, tenantStatus: status, tenantMessage: accessMessage(tenant) });
  if (status === 'revoked') return wrap({ role: null, source: 'revoked', revoked: true });

  // 1. Already a member, or invited by sign-in name (the first sign-in turns the invitation into a membership)
  let explicit = null, source = 'none';
  const member = await getMemberRow(tid, memberKey(user.userId));
  if (member) {
    if (!member.lastSeenAt || Date.now() - Date.parse(member.lastSeenAt) > 60 * 60 * 1000) {
      await saveMemberRow(tid, member.rowKey, { lastSeenAt: new Date().toISOString(), name: user.name || member.name, email: user.email || member.email });
    }
    explicit = member.role; source = 'member';
  } else if (user.email) {
    const invite = await getMemberRow(tid, inviteKey(user.email));
    if (invite) {
      await saveMemberRow(tid, memberKey(user.userId), {
        kind: 'member', role: invite.role, name: user.name, email: user.email,
        addedBy: invite.addedBy, addedAt: invite.addedAt, joinedAt: new Date().toISOString(), lastSeenAt: new Date().toISOString()
      });
      await deleteMemberRow(tid, invite.rowKey);
      await audit(tid, user.email, 'joined', `Accepted invitation as ${invite.role}`);
      explicit = invite.role; source = 'invite';
    }
  }

  // 2. Entra groups the organization assigned a role to; the highest of the person's own role and group role wins
  const viaGroup = await groupRole(user);
  if (viaGroup) { if (!explicit || rank(viaGroup) > rank(explicit)) source = 'group'; explicit = explicit ? higher(explicit, viaGroup) : viaGroup; }
  if (explicit) return wrap({ role: explicit, source });

  // 3. Entra administrators
  if (isEntraAdmin(user)) return wrap({ role: 'owner', source: 'entra-admin' });

  return wrap({ role: null, source: 'none' });
}
