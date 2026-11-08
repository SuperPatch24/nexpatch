// Who can use Nexpatch for an organization, and with which role.
import { getMemberRow, saveMemberRow, deleteMemberRow, inviteKey, memberKey, audit } from './store.js';

export const ROLES = ['viewer', 'admin', 'owner'];
export const rank = role => ROLES.indexOf(role);

// Entra Global Administrator and Intune Administrator always have owner access,
// so an organization can never lock itself out.
const ENTRA_ADMIN_ROLE_IDS = new Set([
  '62e90394-69f5-4237-9190-012177145e10', // Global Administrator
  '3a2c62db-5318-420d-8d74-23affee5d9d5'  // Intune Administrator
]);
export const isEntraAdmin = user => user.directoryRoles.some(r => ENTRA_ADMIN_ROLE_IDS.has(r));

export async function resolveAccess(user) {
  const tid = user.tenantId;

  // 1. Already a member
  const member = await getMemberRow(tid, memberKey(user.userId));
  if (member) {
    if (!member.lastSeenAt || Date.now() - Date.parse(member.lastSeenAt) > 60 * 60 * 1000) {
      await saveMemberRow(tid, member.rowKey, { lastSeenAt: new Date().toISOString(), name: user.name || member.name, email: user.email || member.email });
    }
    return { role: member.role, source: 'member' };
  }

  // 2. Invited by sign-in name: the first sign-in turns the invitation into a membership
  if (user.email) {
    const invite = await getMemberRow(tid, inviteKey(user.email));
    if (invite) {
      await saveMemberRow(tid, memberKey(user.userId), {
        kind: 'member', role: invite.role, name: user.name, email: user.email,
        addedBy: invite.addedBy, addedAt: invite.addedAt, joinedAt: new Date().toISOString(), lastSeenAt: new Date().toISOString()
      });
      await deleteMemberRow(tid, invite.rowKey);
      await audit(tid, user.email, 'joined', `Accepted invitation as ${invite.role}`);
      return { role: invite.role, source: 'invite' };
    }
  }

  // 3. Entra administrators
  if (isEntraAdmin(user)) return { role: 'owner', source: 'entra-admin' };

  return { role: null, source: 'none' };
}
