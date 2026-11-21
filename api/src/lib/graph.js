// Calls Microsoft Graph in a client's tenant as NexpatchOnline itself (app-only),
// using the certificate stored in Key Vault. Requires the tenant's admin approval.
import { ClientCertificateCredential, DefaultAzureCredential } from '@azure/identity';
import { SecretClient } from '@azure/keyvault-secrets';
import { readFile } from 'node:fs/promises';
import { HttpError } from './http.js';
import { clientIdFor, decodeRoles, BUNDLES, isBundle } from './bundles.js';

let certPromise;
const credentials = new Map();

function loadCertificate() {
  certPromise ??= (async () => {
    if (process.env.CERT_PEM_PATH) return readFile(process.env.CERT_PEM_PATH, 'utf8'); // local development only
    const secrets = new SecretClient(process.env.KEY_VAULT_URL, new DefaultAzureCredential());
    const secret = await secrets.getSecret(process.env.CERT_NAME); // Key Vault exposes the certificate (with key) as a secret
    return secret.value;
  })();
  return certPromise;
}

async function credentialFor(tenantId, bundle = 'core') {
  const clientId = clientIdFor(bundle), key = `${tenantId}:${clientId}`;
  if (!credentials.has(key)) {
    const certificate = await loadCertificate();
    credentials.set(key, new ClientCertificateCredential(tenantId, clientId, { certificate }));
  }
  return credentials.get(key);
}

// Which application permissions has this organization approved for a bundle? A brand-new credential is used so a
// permission approved a minute ago shows up straight away (the token carries the approved permissions as roles).
export async function grantedRoles(tenantId, bundle = 'core') {
  try {
    const certificate = await loadCertificate();
    const cred = new ClientCertificateCredential(tenantId, clientIdFor(bundle), { certificate });
    return decodeRoles((await cred.getToken('https://graph.microsoft.com/.default')).token);
  } catch { return []; }
}

// graphAs('appcontrol') behaves like graph() but signs in with that bundle's app registration.
export const graphAs = bundle => (tenantId, path, init = {}) => graph(tenantId, path, { ...init, bundle });
export const graphAllAs = bundle => async (tenantId, path) => {
  const out = []; let next = path;
  while (next) { const page = await graph(tenantId, next, { bundle }); out.push(...(page.value || [])); next = page['@odata.nextLink'] || null; }
  return out;
};

const addOn = bundle => (bundle && bundle !== 'core' && isBundle(bundle) ? BUNDLES[bundle].label : '');
function explainTokenError(err, bundle = 'core') {
  const m = String(err?.message || err);
  if (addOn(bundle) && /AADSTS7000229|AADSTS700016|AADSTS65001|AADSTS90094/.test(m)) {
    return new HttpError(409, `The ${addOn(bundle)} permissions haven\u2019t been approved in this organization yet. An administrator can approve them on the Connect page.`);
  }
  if (/AADSTS7000229|AADSTS700016|AADSTS65001|AADSTS90094/.test(m)) {
    return new HttpError(409, 'NexpatchOnline isn\u2019t approved in this organization yet. An administrator needs to approve it on the Connect page.');
  }
  if (/AADSTS700027|AADSTS700024/.test(m)) {
    return new HttpError(500, 'NexpatchOnline\u2019s certificate was rejected. Check that it is uploaded to the app registration.');
  }
  return new HttpError(502, 'Couldn\u2019t sign in to this organization\u2019s Microsoft tenant.');
}

export async function graph(tenantId, path, opts = {}, attempt = 0) {
  const { bundle = 'core', ...init } = opts;
  let token;
  try { token = await (await credentialFor(tenantId, bundle)).getToken('https://graph.microsoft.com/.default'); }
  catch (err) { throw explainTokenError(err, bundle); }

  const url = path.startsWith('https://') ? path : `https://graph.microsoft.com${path}`;
  const res = await fetch(url, { ...init, headers: { Authorization: `Bearer ${token.token}`, 'Content-Type': 'application/json', ...(init.headers || {}) } });

  if ((res.status === 429 || res.status >= 500) && attempt < 3) {
    const wait = Math.min(30, Number(res.headers.get('retry-after')) || 2 ** attempt * 2);
    await new Promise(r => setTimeout(r, wait * 1000));
    return graph(tenantId, path, opts, attempt + 1);
  }
  if (!res.ok) {
    let detail = '';
    try { detail = ((await res.json()).error || {}).message || ''; } catch {}
    // Intune often wraps the real reason as JSON text inside the message
    try { const inner = JSON.parse(detail); detail = inner.Message || inner.message || detail; } catch {}
    detail = String(detail).replace(/\s*-?\s*Operation ID.*$/is, '').replace(/\s+/g, ' ').trim().slice(0, 300);
    // Intune answers a missing application permission with 401 (not 403). Drop the cached token so the
    // next attempt picks up a fresh one after the admin re-approves.
    if ((res.status === 401 || res.status === 403) && addOn(bundle)) {
      if (res.status === 401) credentials.delete(`${tenantId}:${clientIdFor(bundle)}`);
      throw new HttpError(403, `NexpatchOnline doesn\u2019t have all the ${addOn(bundle)} permissions in this organization yet. An administrator can approve them on the Connect page` + (detail ? ` (${detail})` : '.'));
    }
    if (res.status === 401) {
      credentials.delete(`${tenantId}:${clientIdFor(bundle)}`);
      throw new HttpError(403, 'NexpatchOnline doesn\u2019t have permission for this in your tenant yet. An administrator needs to approve it again on the Connect page' + (detail ? ` (${detail})` : '.'));
    }
    if (res.status === 403) throw new HttpError(403, 'NexpatchOnline doesn\u2019t have the Intune permissions it needs in this organization. Ask an administrator to approve it again.' + (detail ? ` (${detail})` : ''));
    throw new HttpError(502, `Microsoft Graph returned an error (${res.status})${detail ? ': ' + detail : '.'}`);
  }
  // Some Graph actions (for example commit) succeed with an empty body
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// Follows @odata.nextLink until every page is read.
export async function graphAll(tenantId, path) {
  const out = [];
  let next = path;
  while (next) {
    const page = await graph(tenantId, next);
    out.push(...(page.value || []));
    next = page['@odata.nextLink'] || null;
  }
  return out;
}
