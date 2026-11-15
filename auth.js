// Validates the access token the website sends with every request.
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { HttpError } from './http.js';

const JWKS = createRemoteJWKSet(new URL('https://login.microsoftonline.com/common/discovery/v2.0/keys'));
const REQUIRED_SCOPE = 'access_as_user';

export async function verifyUser(request) {
  const header = request.headers.get('authorization') || '';
  const match = /^Bearer (.+)$/i.exec(header);
  if (!match) throw new HttpError(401, 'Sign in required.');

  const clientId = process.env.CLIENT_ID;
  let payload;
  try {
    ({ payload } = await jwtVerify(match[1], JWKS, {
      audience: [clientId, `api://${clientId}`],
      clockTolerance: 60
    }));
  } catch {
    throw new HttpError(401, 'Your sign-in has expired or is not valid. Please sign in again.');
  }

  // Multi-tenant: accept any organization, but only tokens Entra ID issued for that organization.
  const tenantId = payload.tid;
  if (!tenantId || payload.iss !== `https://login.microsoftonline.com/${tenantId}/v2.0`) {
    throw new HttpError(401, 'This sign-in was not issued by Microsoft Entra ID.');
  }
  const scopes = String(payload.scp || '').split(' ');
  if (!scopes.includes(REQUIRED_SCOPE)) {
    throw new HttpError(403, 'This sign-in does not include access to NexpatchOnline.');
  }

  return {
    tenantId,
    userId: payload.oid,
    name: payload.name || '',
    email: (payload.preferred_username || '').toLowerCase(),
    // Entra directory roles (role template IDs). Present when the app manifest has groupMembershipClaims = "DirectoryRole".
    directoryRoles: Array.isArray(payload.wids) ? payload.wids : []
  };
}
