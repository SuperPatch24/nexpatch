// Shared HTTP helpers: JSON responses, friendly errors, signed-in user and role checks.
import { verifyUser } from './auth.js';
import { resolveAccess, rank } from './access.js';
import { enforceSession, countRequest } from './sessions.js';
import { legalStatus } from './legal.js';
import { getRow, getTenant } from './store.js';
import { partnerDecision, ACCESS } from './partners.js';
import { accessOf } from './tenantsettings.js';

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
      await applyPartnerContext(request, user, minRole, options);
      const body = await handler(request, context, user);
      return json(200, body ?? {});
    } catch (err) {
      if (err instanceof HttpError) return json(err.status, { error: err.message, ...(err.code ? { code: err.code } : {}), ...(err.claims ? { claims: err.claims } : {}) });
      context.error('Unhandled error', err);
      return json(500, { error: 'Something went wrong on the server. Please try again.' });
    }
  };
}

// A partner (MSP) working in a customer's organization sends x-nexpatch-context: <customer tenant ID>.
// Everything above (sign-in, session rules, role, Terms) was checked for the partner's own organization. Here the
// request moves into the customer's organization with the lower of the partner's role and the access the customer
// approved. Routes marked { partner: false } (users, billing, company details, connecting, partner settings) refuse it.
async function applyPartnerContext(request, user, minRole, options) {
  const ctx = String(request.headers?.get?.('x-nexpatch-context') || '').trim().toLowerCase();
  if (!ctx || ctx === String(user.tenantId || '').toLowerCase()) return;
  const blocked = options.partner === false;
  const link = blocked || !user.role ? null : await getRow('PartnerLinks', user.tenantId, ctx);
  const t = link ? await getTenant(ctx) : null;
  const d = partnerDecision({ blocked, homeRole: user.role, link, tenant: t, tenantStatus: t ? accessOf(t) : 'active', minRole });
  if (d.error) throw new HttpError(d.error.status, d.error.message);
  user.partner = { homeTenantId: user.tenantId, homeRole: user.role, customerTenantId: ctx, customerName: t.name || link.customerName || '', access: link.access, accessName: ACCESS[link.access] };
  user.tenantId = ctx; user.role = d.role; user.access = 'partner'; user.tenantStatus = d.tenantStatus;
}

export async function readJson(request) {
  try { return await request.json(); }
  catch { throw new HttpError(400, 'The request body must be JSON.'); }
}
