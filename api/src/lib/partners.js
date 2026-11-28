// Partners (MSPs): an IT company that manages several customer organizations from its own sign-in.
// A customer's owner approves the link and chooses the access level; the partner can never do more in the customer's
// organization than that level, or than their own role at the partner. Pure, so the rules can be tested.
import { randomInt, createHash } from 'node:crypto';

export const ACCESS = { viewer: 'View only', admin: 'Manage' };
const RANK = { viewer: 1, admin: 2, owner: 3 };
export const INVITE_DAYS = 7;
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';     // no 0/O or 1/I, so codes can be read out loud

export function newInviteCode() {
  const block = () => Array.from({ length: 4 }, () => ALPHA[randomInt(ALPHA.length)]).join('');
  return `NXP-${block()}-${block()}-${block()}`;
}
export const normalizeCode = v => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^NXP/, '');
export const codeHash = v => createHash('sha256').update('nexpatch-partner:' + normalizeCode(v)).digest('hex');
export const looksLikeCode = v => normalizeCode(v).length === 12;

// The partner's effective role in a customer: the lower of their role at the partner and the access the customer granted.
export function effectiveRole(homeRole, access) {
  if (!RANK[homeRole] || !ACCESS[access]) return null;
  return RANK[homeRole] < RANK[access] ? homeRole : access;
}
export const cleanAccess = v => (v === 'admin' ? 'admin' : 'viewer');

// One customer in the partner's overview, from the stored rows only (no calls to Microsoft).
export function customerSummary(link, t, extra = {}) {
  let vuln = null;
  try { vuln = t?.vulnSummary ? JSON.parse(t.vulnSummary) : null; } catch { vuln = null; }
  const syncAge = t?.lastSyncAt ? (Date.now() - Date.parse(t.lastSyncAt)) / 36e5 : null;
  const attention = [];
  if (!t || t.status !== 'active') attention.push('Not connected to Intune');
  else if (syncAge == null || syncAge > 48) attention.push('Inventory not synced in 2 days');
  if (t?.lastSyncError) attention.push('Last sync failed');
  if (vuln?.knownExploited) attention.push(`${vuln.knownExploited} known exploited flaw${vuln.knownExploited > 1 ? 's' : ''}`);
  if (extra.failedPublishes) attention.push(`${extra.failedPublishes} failed publish${extra.failedPublishes > 1 ? 'es' : ''} in 30 days`);
  if (extra.agentAttention) attention.push(`${extra.agentAttention} device${extra.agentAttention > 1 ? 's' : ''} need attention`);
  return {
    tenantId: link.rowKey, name: t?.name || link.customerName || 'Customer', access: link.access, accessName: ACCESS[link.access] || link.access, since: link.approvedAt || null,
    connected: t?.status === 'active', lastSyncAt: t?.lastSyncAt || null, devices: extra.devices ?? null, apps: t?.lastSyncCount ?? null,
    vulnerabilities: vuln ? { knownExploited: vuln.knownExploited || 0, critical: vuln.cves?.CRITICAL || 0, high: vuln.cves?.HIGH || 0, at: vuln.at || null } : null,
    agent: extra.agentDevices != null ? { devices: extra.agentDevices, attention: extra.agentAttention || 0 } : null,
    publishing: { failed30d: extra.failedPublishes || 0, succeeded30d: extra.succeededPublishes || 0 },
    attention, status: attention.length ? 'attention' : 'ok'
  };
}

// Decides whether a partner may act in a customer's organization for one request, and with which role.
// Returns { error: { status, message } } or { role, tenantStatus }.
export function partnerDecision({ blocked = false, homeRole, link, tenant, tenantStatus = 'active', minRole = 'viewer' }) {
  const no = (status, message) => ({ error: { status, message } });
  if (blocked) return no(403, 'Partners can\u2019t do this in a customer\u2019s organization. Switch back to your own organization first.');
  if (!RANK[homeRole]) return no(403, 'You don\u2019t have access to NexpatchOnline for your organization.');
  if (!link || link.status !== 'active') return no(403, 'Your organization doesn\u2019t manage this customer (any more).');
  if (!tenant) return no(404, 'That customer organization wasn\u2019t found.');
  if (tenantStatus === 'revoked') return no(403, 'This customer\u2019s access to NexpatchOnline has been revoked.');
  const role = effectiveRole(homeRole, link.access);
  if (!role) return no(403, 'Your access to this customer isn\u2019t set up correctly.');
  const need = minRole === 'any' ? 0 : RANK[minRole] || 1;
  if (tenantStatus === 'suspended' && need > RANK.viewer) return no(403, 'This customer\u2019s organization is suspended.');
  if (need > RANK[role]) return no(403, `Your access to this customer is ${ACCESS[link.access]}. This needs more.`);
  return { role, tenantStatus };
}
