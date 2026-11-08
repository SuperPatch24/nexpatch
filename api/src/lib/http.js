// Shared HTTP helpers: JSON responses, friendly errors, signed-in user and role checks.
import { verifyUser } from './auth.js';
import { resolveAccess, rank } from './access.js';

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export const json = (status, body) => ({ status, jsonBody: body });

const ROLE_NAMES = { viewer: 'Viewer', admin: 'Admin', owner: 'Owner' };

// Wraps a handler so it only runs for a valid user with at least `minRole` in their organization.
// minRole 'any' = any signed-in user (the handler decides).
export function withUser(handler, minRole = 'viewer') {
  return async (request, context) => {
    try {
      const user = await verifyUser(request);
      const access = await resolveAccess(user);
      user.role = access.role;
      user.access = access.source;
      if (minRole !== 'any') {
        if (!access.role) throw new HttpError(403, 'You don\u2019t have access to Nexpatch for your organization. Ask your IT administrator to add you.');
        if (rank(access.role) < rank(minRole)) throw new HttpError(403, `This needs the ${ROLE_NAMES[minRole]} role or higher.`);
      }
      const body = await handler(request, context, user);
      return json(200, body ?? {});
    } catch (err) {
      if (err instanceof HttpError) return json(err.status, { error: err.message });
      context.error('Unhandled error', err);
      return json(500, { error: 'Something went wrong on the server. Please try again.' });
    }
  };
}

export async function readJson(request) {
  try { return await request.json(); }
  catch { throw new HttpError(400, 'The request body must be JSON.'); }
}
