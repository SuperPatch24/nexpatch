// Click-to-accept for the Terms of Service, Privacy Policy and (for organization admins) the Data Processing Agreement.
// Bump a version when a document changes in a way people must re-accept; the page then asks again at the next sign-in.
import { getRow, putRow } from './store.js';
import { LEGAL, DOC_URLS, legalNeeds, userKey } from './legaldocs.js';
export { LEGAL, DOC_URLS, legalNeeds };

const cache = new Map(); // only "all accepted" results are cached, for a few minutes
const TTL = 5 * 60 * 1000;
export const clearLegalCache = () => cache.clear();

export async function legalStatus(user, role) {
  const ck = `${user.tenantId}|${user.userId}|${role}`;
  const hit = cache.get(ck);
  if (hit && hit.until > Date.now()) return hit.value;
  const [userRow, dpaRow] = await Promise.all([getRow('LegalAcceptances', user.tenantId, userKey(user.userId)), getRow('LegalAcceptances', user.tenantId, 'dpa')]);
  const value = legalNeeds(userRow, dpaRow, role);
  if (!value.needsTerms && !value.needsDpa) cache.set(ck, { value, until: Date.now() + TTL });
  return value;
}

export async function recordAcceptance(user, role, { terms, dpa }, meta = {}) {
  const st = await legalStatus(user, role);
  if (st.needsTerms && terms !== true) return { ok: false, error: 'Please accept the Terms of Service and Privacy Policy to continue.' };
  if (st.needsDpa && dpa !== true) return { ok: false, error: 'Please accept the Data Processing Agreement to continue. It covers your organization’s data.' };
  const at = new Date().toISOString();
  if (st.needsTerms) await putRow('LegalAcceptances', user.tenantId, userKey(user.userId), { termsVersion: LEGAL.terms, privacyVersion: LEGAL.privacy, at, email: user.email || '', name: user.name || '', ip: String(meta.ip || '').slice(0, 64), agent: String(meta.agent || '').slice(0, 200) });
  if (st.needsDpa) await putRow('LegalAcceptances', user.tenantId, 'dpa', { version: LEGAL.dpa, at, by: user.email || user.userId, byName: user.name || '', role, ip: String(meta.ip || '').slice(0, 64) });
  clearLegalCache();
  return { ok: true, accepted: { terms: st.needsTerms, dpa: st.needsDpa }, at };
}
