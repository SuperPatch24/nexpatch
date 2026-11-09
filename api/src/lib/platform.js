// Platform operators (you) are listed in the PLATFORM_ADMINS app setting:
// comma-separated sign-in names or object IDs. Optionally restrict them to one tenant with PLATFORM_TENANT_ID.
export function isPlatformAdmin(user) {
  const list = String(process.env.PLATFORM_ADMINS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (!list.length) return false;
  if (process.env.PLATFORM_TENANT_ID && user.tenantId !== process.env.PLATFORM_TENANT_ID) return false;
  return list.includes(String(user.email || '').toLowerCase()) || list.includes(String(user.userId || '').toLowerCase());
}
