import { app } from '@azure/functions';
import { withUser, HttpError, readJson } from '../lib/http.js';
import { getTenant, saveTenant, listRows, audit } from '../lib/store.js';
import { TIERS, validatePlanRequest, planRequestOf, CLEAR_PLAN_REQUEST as CLEAR } from '../lib/plans.js';
import { notifyPlatformAdmins, escapeHtml } from '../lib/email.js';


// A company admin asks for a different plan. The operator confirms it (no payment is taken here).
app.http('orgPlanRequest', { methods: ['POST'], authLevel: 'anonymous', route: 'org/plan-request',
  handler: withUser(async (req, ctx, user) => {
    const t = await getTenant(user.tenantId);
    if (!t) throw new HttpError(404, 'Your organization isn’t connected yet.');
    const inv = await listRows('Inventory', user.tenantId, 20000);
    const devices = inv.reduce((m, x) => Math.max(m, Number(x.deviceCount) || 0), 0);
    const v = validatePlanRequest(await readJson(req), { devices, current: t });
    if (v.error) throw new HttpError(400, v.error);
    const r = v.request, who = user.email || user.userId;
    await saveTenant(user.tenantId, { reqTier: r.tier, reqBilling: r.billing, reqAppControl: r.appControl, reqNote: r.note, reqAt: new Date().toISOString(), reqBy: who });
    await audit(user.tenantId, who, 'asked to change plan', `${TIERS[r.tier].label}, ${r.billing}${r.appControl ? ', with App Control' : ''}`);
    try {
      await notifyPlatformAdmins({ subject: `Plan change request: ${TIERS[r.tier].label}`, tags: ['plan-request'],
        htmlContent: `<p><b>${escapeHtml(who)}</b> (organization ${escapeHtml(user.tenantId)}) asked for <b>${escapeHtml(TIERS[r.tier].label)}</b>, ${escapeHtml(r.billing)}${r.appControl ? ', with App Control' : ''}.</p>${r.note ? `<p>${escapeHtml(r.note)}</p>` : ''}<p>Open the Admin Center, then Organizations, and activate the plan.</p>`,
        textContent: `${who} (${user.tenantId}) asked for ${TIERS[r.tier].label}, ${r.billing}${r.appControl ? ', with App Control' : ''}. ${r.note}` }, ctx);
    } catch { /* the request is saved either way; the operator also sees it in the Admin Center */ }
    return { request: planRequestOf(await getTenant(user.tenantId)) };
  }, 'admin', { partner: false }) });

app.http('orgPlanRequestCancel', { methods: ['DELETE'], authLevel: 'anonymous', route: 'org/plan-request',
  handler: withUser(async (_req, _c, user) => {
    await saveTenant(user.tenantId, CLEAR);
    await audit(user.tenantId, user.email || user.userId, 'cancelled plan change request', '');
    return { ok: true };
  }, 'admin', { partner: false }) });
