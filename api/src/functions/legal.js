// Click-to-accept for the Terms of Service, Privacy Policy and (for organization admins) the Data Processing Agreement.
import { app } from '@azure/functions';
import { withUser, HttpError, readJson } from '../lib/http.js';
import { legalStatus, recordAcceptance, DOC_URLS } from '../lib/legal.js';
import { audit } from '../lib/store.js';

// GET /api/legal/status – what the signed-in person still has to accept.
app.http('legalStatus', { methods: ['GET'], authLevel: 'anonymous', route: 'legal/status',
  handler: withUser(async (_req, _ctx, user) => ({ ...(await legalStatus(user, user.role)), urls: DOC_URLS }), 'viewer', { skipLegal: true, partner: false }) });

// POST /api/legal/accept { terms: true, dpa: true } – record acceptance of the current versions.
app.http('legalAccept', { methods: ['POST'], authLevel: 'anonymous', route: 'legal/accept',
  handler: withUser(async (req, _ctx, user) => {
    const b = await readJson(req);
    const ip = String(req.headers.get('x-forwarded-for') || '').split(',')[0].trim().replace(/:\d+$/, '');
    const r = await recordAcceptance(user, user.role, { terms: b.terms === true, dpa: b.dpa === true }, { ip, agent: req.headers.get('user-agent') || '' });
    if (!r.ok) throw new HttpError(400, r.error);
    const what = [r.accepted.terms && 'Terms of Service and Privacy Policy', r.accepted.dpa && 'Data Processing Agreement'].filter(Boolean).join(' and ');
    if (what) await audit(user.tenantId, user.email || user.userId, 'accepted legal terms', what);
    return r;
  }, 'viewer', { skipLegal: true, partner: false }) });
