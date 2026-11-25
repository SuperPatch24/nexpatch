// Removing a deployment also removes the app NexpatchOnline created in Intune.
// Only apps that carry NexpatchOnline's own mark are deleted, so an app the company made or owned before is never touched.

export const APPS = '/v1.0/deviceAppManagement/mobileApps';

// Apps made by NexpatchOnline say so in their description (Win32 and Store apps both do).
export const isOurApp = app => /nexpatchonline/i.test(String(app?.description || '')) || /nexpatchonline/i.test(String(app?.notes || ''));

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const validAppId = id => GUID.test(String(id || ''));

// deps = { graph } for the customer's tenant. Returns { status, name? } where status is one of:
//   removed      the app was deleted in Intune
//   already-gone the app was not in Intune any more (deleted by someone, or never created)
//   not-ours     the app exists but NexpatchOnline did not make it, so it was left alone
//   no-app       the job never produced an Intune app
export async function removeIntuneApp({ graph }, appId) {
  if (!appId) return { status: 'no-app' };
  if (!validAppId(appId)) return { status: 'no-app' };
  let app;
  try { app = await graph(`${APPS}/${appId}?$select=id,displayName,description,notes`); }
  catch (e) { if (e.status === 404 || /\(404\)/.test(String(e.message))) return { status: 'already-gone' }; throw e; }
  if (!isOurApp(app)) return { status: 'not-ours', name: app?.displayName || '' };
  try { await graph(`${APPS}/${appId}`, { method: 'DELETE' }); }
  catch (e) { if (e.status === 404 || /\(404\)/.test(String(e.message))) return { status: 'already-gone', name: app.displayName || '' }; throw e; }
  return { status: 'removed', name: app.displayName || '' };
}

export const REMOVAL_TEXT = {
  removed: 'Removed from Intune and from NexpatchOnline.',
  'already-gone': 'It was already gone from Intune. Removed from NexpatchOnline.',
  'not-ours': 'NexpatchOnline didn’t create this app, so it was left in Intune. Removed from NexpatchOnline only.',
  'no-app': 'Removed from NexpatchOnline. Nothing had been created in Intune.'
};
