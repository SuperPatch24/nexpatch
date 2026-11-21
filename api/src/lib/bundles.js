// Permission bundles. Microsoft Entra approves ALL of an app registration's permissions at once, so "only approve
// what you use" needs one app registration per bundle. Core is the existing app (CLIENT_ID). Each add-on has its own
// registration (CLIENT_ID_APPCONTROL, CLIENT_ID_AUTOMATION). If an add-on's client ID is not set, it uses the core app,
// so a single-registration setup keeps working (and then everything is approved together).
export const BUNDLES = {
  core: {
    label: 'Apps and patching', env: 'CLIENT_ID', optional: false,
    uses: 'Discover apps, publish and update them in Intune, read device counts and look up groups.',
    roles: ['DeviceManagementApps.ReadWrite.All', 'DeviceManagementManagedDevices.Read.All', 'DeviceManagementConfiguration.Read.All', 'Group.Read.All']
  },
  appcontrol: {
    label: 'App Control', env: 'CLIENT_ID_APPCONTROL', optional: true,
    uses: 'Read Defender App Control events and create and assign App Control policies in Intune.',
    roles: ['DeviceManagementConfiguration.ReadWrite.All', 'ThreatHunting.Read.All', 'Group.Read.All']
  },
  automation: {
    label: 'Automation', env: 'CLIENT_ID_AUTOMATION', optional: true,
    uses: 'Add devices to Entra security groups on a schedule, and create those groups if you ask it to.',
    roles: ['Device.Read.All', 'GroupMember.ReadWrite.All', 'DeviceManagementManagedDevices.Read.All', 'Group.Read.All'],
    optionalRoles: ['Group.Create']
  }
};
export const BUNDLE_IDS = Object.keys(BUNDLES);
export const isBundle = b => Object.prototype.hasOwnProperty.call(BUNDLES, b);

// The app registration to use for a bundle: its own if configured, otherwise the core app.
export const clientIdFor = (bundle, env = process.env) => (isBundle(bundle) && env[BUNDLES[bundle].env]) || env.CLIENT_ID || '';
export const hasOwnApp = (bundle, env = process.env) => bundle === 'core' || !!(isBundle(bundle) && env[BUNDLES[bundle].env] && env[BUNDLES[bundle].env] !== env.CLIENT_ID);

// The roles a Microsoft token carries are the application permissions that were approved in that organization.
export function decodeRoles(jwt) {
  try {
    const p = JSON.parse(Buffer.from(String(jwt).split('.')[1], 'base64url').toString('utf8'));
    return Array.isArray(p.roles) ? p.roles.map(String) : [];
  } catch { return []; }
}
export const missingRoles = (required, granted) => required.filter(r => !granted.includes(r));

// Does this organization's plan (or the plan it asked for) include App Control? Then it should approve that bundle.
export function wantsAppControl(t) {
  if (!t) return false;
  return t.appControl === true || t.reqAppControl === true || (t.plan === 'trial' && t.interestAppControl === true) || (!t.plan && t.interestAppControl === true);
}

export function bundleStatus(id, granted, t, env = process.env) {
  const b = BUNDLES[id];
  const missing = missingRoles(b.roles, granted);
  return {
    id, label: b.label, uses: b.uses, optional: b.optional,
    needed: id === 'core' ? true : id === 'appcontrol' ? wantsAppControl(t) : false,
    consented: missing.length === 0, missing, permissions: b.roles, optionalPermissions: b.optionalRoles || [],
    optionalMissing: missingRoles(b.optionalRoles || [], granted),
    clientId: clientIdFor(id, env), ownApp: hasOwnApp(id, env)
  };
}
