// Shared HTTP helpers: JSON responses, friendly errors, signed-in user and role checks.
import { verifyUser } from './auth.js';
import { resolveAccess, rank } from './access.js';
import { enforceSession, countRequest } from './sessions.js';
import { legalStatus } from './legal.js';

export class HttpError extends Error {
  constructor(status, message, code) { super(message); this.status = status; if (code) this.code = code; }
}

export const json = (status, body, extra = {}) => ({ status, jsonBody: body, ...extra });

const ROLE_NAMES = { viewer: 'Viewer', admin: 'Admin', owner: 'Owner' };

// Wraps a handler so it only runs for a valid user with at least `minRole` in their organization.
// minRole 'any' = any signed-in user (the handler decides).
// options.skipSession: don't apply the organization's session and MFA rules (used by the
// endpoints the browser needs to report a fresh sign-in and read the rules).
// options.skipLegal: don't require the current Terms/DPA to be accepted (the legal endpoints themselves).
export function withUser(handler, minRole = 'viewer', options = {}) {
  return async (request, context) => {
    try {
      const user = await verifyUser(request);
      if (!options.skipSession) { user.sessionPolicy = await enforceSession(user); countRequest(user.tenantId); }
      const access = await resolveAccess(user);
      user.role = access.role;
      user.access = access.source;
      user.tenantStatus = access.tenantStatus; user.tenantMessage = access.tenantMessage;
      if (minRole !== 'any') {
        if (access.revoked) throw new HttpError(403, access.tenantMessage);
        if (!access.role) throw new HttpError(403, 'You don\u2019t have access to NexpatchOnline for your organization. Ask your IT administrator to add you.');
        if (access.tenantStatus === 'suspended' && rank(minRole) > rank('viewer') ) throw new HttpError(403, access.tenantMessage);
        if (rank(access.role) < rank(minRole)) throw new HttpError(403, `This needs the ${ROLE_NAMES[minRole]} role or higher.`);
        // Everyone must have accepted the current Terms and Privacy Policy (and an organization admin the DPA).
        // The app answers 428 by showing the "Before you continue" box. Endpoints with minRole 'any' (/me,
        // connecting the organization, platform administration) are not gated.
        if (!options.skipLegal) { const lg = await legalStatus(user, access.role); if (lg.needsTerms || lg.needsDpa) throw new HttpError(428, 'Please accept the Terms of Service to continue.', 'legal_required'); }
      }
      const body = await handler(request, context, user);
      return json(200, body ?? {});
    } catch (err) {
      if (err instanceof HttpError) return json(err.status, { error: err.message, ...(err.code ? { code: err.code } : {}), ...(err.claims ? { claims: err.claims } : {}) });
      context.error('Unhandled error', err);
      return json(500, { error: 'Something went wrong on the server. Please try again.' });
    }
  };
}

export async function readJson(request) {
  try { return await request.json(); }
  catch { throw new HttpError(400, 'The request body must be JSON.'); }
}
