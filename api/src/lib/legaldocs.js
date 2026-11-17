// Versions and the pure rules for click-to-accept (no storage, so it can be tested anywhere).
// Bump a version when a document changes in a way people must re-accept; the page then asks again at the next sign-in.
export const LEGAL = { terms: '2026-11-15', privacy: '2026-11-15', dpa: '2026-11-15' };
export const DOC_URLS = { terms: '/legal/terms.html', privacy: '/legal/privacy.html', dpa: '/legal/dpa.html' };
export const userKey = userId => `user-${String(userId || '').toLowerCase()}`.slice(0, 120);
const isAdminRole = role => role === 'admin' || role === 'owner';

// Pure: what still needs accepting, given the stored rows.
export function legalNeeds(userRow, dpaRow, role, versions = LEGAL) {
  const needsTerms = !userRow || userRow.termsVersion !== versions.terms || userRow.privacyVersion !== versions.privacy;
  const needsDpa = isAdminRole(role) && (!dpaRow || dpaRow.version !== versions.dpa);
  return { needsTerms, needsDpa, versions: { ...versions } };
}
