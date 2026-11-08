// Calls Microsoft Graph in a client's tenant as Nexpatch itself (app-only),
// using the certificate stored in Key Vault. Requires the tenant's admin approval.
import { ClientCertificateCredential, DefaultAzureCredential } from '@azure/identity';
import { SecretClient } from '@azure/keyvault-secrets';
import { readFile } from 'node:fs/promises';
import { HttpError } from './http.js';

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

async function credentialFor(tenantId) {
  if (!credentials.has(tenantId)) {
    const certificate = await loadCertificate();
    credentials.set(tenantId, new ClientCertificateCredential(tenantId, process.env.CLIENT_ID, { certificate }));
  }
  return credentials.get(tenantId);
}

function explainTokenError(err) {
  const m = String(err?.message || err);
  if (/AADSTS7000229|AADSTS700016|AADSTS65001|AADSTS90094/.test(m)) {
    return new HttpError(409, 'Nexpatch isn\u2019t approved in this organization yet. An administrator needs to approve it on the Connect page.');
  }
  if (/AADSTS700027|AADSTS700024/.test(m)) {
    return new HttpError(500, 'Nexpatch\u2019s certificate was rejected. Check that it is uploaded to the app registration.');
  }
  return new HttpError(502, 'Couldn\u2019t sign in to this organization\u2019s Microsoft tenant.');
}

export async function graph(tenantId, path, init = {}, attempt = 0) {
  let token;
  try { token = await (await credentialFor(tenantId)).getToken('https://graph.microsoft.com/.default'); }
  catch (err) { throw explainTokenError(err); }

  const url = path.startsWith('https://') ? path : `https://graph.microsoft.com${path}`;
  const res = await fetch(url, { ...init, headers: { Authorization: `Bearer ${token.token}`, 'Content-Type': 'application/json', ...(init.headers || {}) } });

  if ((res.status === 429 || res.status >= 500) && attempt < 3) {
    const wait = Math.min(30, Number(res.headers.get('retry-after')) || 2 ** attempt * 2);
    await new Promise(r => setTimeout(r, wait * 1000));
    return graph(tenantId, path, init, attempt + 1);
  }
  if (!res.ok) {
    let detail = '';
    try { detail = ((await res.json()).error || {}).message || ''; } catch {}
    detail = String(detail).split(/\r?\n/)[0].slice(0, 300);
    if (res.status === 403) throw new HttpError(403, 'Nexpatch doesn\u2019t have the Intune permissions it needs in this organization. Ask an administrator to approve it again.' + (detail ? ` (${detail})` : ''));
    throw new HttpError(502, `Microsoft Graph returned an error (${res.status})${detail ? ': ' + detail : '.'}`);
  }
  return res.status === 204 ? null : res.json();
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
