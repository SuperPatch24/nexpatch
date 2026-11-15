// Platform roles are configured as comma-separated Entra sign-in names or object IDs.
// PLATFORM_ADMINS is the super-admin allowlist retained for backward compatibility.
const values = name => String(process.env[name] || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
function matches(user, list) {
  return list.includes(String(user.email || '').toLowerCase()) || list.includes(String(user.userId || '').toLowerCase());
}
export function platformRole(user) {
  if (process.env.PLATFORM_TENANT_ID && user.tenantId !== process.env.PLATFORM_TENANT_ID) return null;
  if (matches(user, values('PLATFORM_ADMINS'))) return 'superadmin';
  if (matches(user, values('PLATFORM_CATALOG_MANAGERS'))) return 'catalog';
  if (matches(user, values('PLATFORM_SUPPORT_ADMINS'))) return 'support';
  return null;
}
export function isPlatformAdmin(user) { return !!platformRole(user); }
