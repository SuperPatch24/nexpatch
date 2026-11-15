// How update-only deployments are named in Intune and in the Deployments list.
export const updateAppName = (name, version) => `Update for ${name}${version ? ' ' + version : ''}`;
const esc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// "Update for Chrome 130.0" belongs to "Chrome" but "Update for Chrome Remote Desktop 1.0" does not: a version must follow the name.
export const isUpdateAppName = (displayName, name) => new RegExp(`^Update for ${esc(name)} \\d`).test(String(displayName || ''));
// Used for the Deployments list: update-only jobs read "Update for <app> <version>" (version appears once it is known).
export const jobDisplayName = j => (j.operationType === 'update' ? updateAppName(j.appName, j.version && /^\d/.test(j.version) ? j.version : '') : j.appName);
