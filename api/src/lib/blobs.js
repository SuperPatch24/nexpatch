// Shared blob storage access for installer files (managed identity, or a connection string for local testing).
import { BlobServiceClient, BlobSASPermissions, StorageSharedKeyCredential, generateBlobSASQueryParameters } from '@azure/storage-blob';
import { DefaultAzureCredential } from '@azure/identity';
import { createHash } from 'node:crypto';

let svc;
export function blobService() {
  if (svc) return svc;
  if (process.env.BLOB_STORAGE_CONNECTION) svc = BlobServiceClient.fromConnectionString(process.env.BLOB_STORAGE_CONNECTION);
  else if (process.env.BLOB_STORAGE_URL) svc = new BlobServiceClient(process.env.BLOB_STORAGE_URL, new DefaultAzureCredential());
  else if (process.env.BLOB_STORAGE_ACCOUNT_NAME) svc = new BlobServiceClient(`https://${process.env.BLOB_STORAGE_ACCOUNT_NAME}.blob.core.windows.net`, new DefaultAzureCredential());
  else { const e = new Error('Installer storage isn’t configured. Set BLOB_STORAGE_ACCOUNT_NAME on the Function App.'); e.status = 503; throw e; }
  return svc;
}
const accountName = () => process.env.BLOB_STORAGE_ACCOUNT_NAME || (process.env.BLOB_STORAGE_URL ? new URL(process.env.BLOB_STORAGE_URL).hostname.split('.')[0] : '');

export async function container(name) { const c = blobService().getContainerClient(name); await c.createIfNotExists(); return c; }

// A short-lived address the browser can upload one file to (create and write only).
export async function uploadUrl(containerName, blobName, minutes = 30) {
  const c = await container(containerName), blob = c.getBlockBlobClient(blobName);
  const startsOn = new Date(Date.now() - 60_000), expiresOn = new Date(Date.now() + minutes * 60_000);
  const conn = process.env.BLOB_STORAGE_CONNECTION || '';
  const parts = Object.fromEntries(conn.split(';').map(x => { const i = x.indexOf('='); return i > 0 ? [x.slice(0, i), x.slice(i + 1)] : ['', '']; }));
  const opts = { containerName, blobName, permissions: BlobSASPermissions.parse('cw'), startsOn, expiresOn };
  const sas = parts.AccountName && parts.AccountKey
    ? generateBlobSASQueryParameters(opts, new StorageSharedKeyCredential(parts.AccountName, parts.AccountKey)).toString()
    : generateBlobSASQueryParameters(opts, await blobService().getUserDelegationKey(startsOn, expiresOn), accountName()).toString();
  return { url: `${blob.url}?${sas}`, expiresAt: expiresOn.toISOString() };
}

export const blobClient = (containerName, blobName) => blobService().getContainerClient(containerName).getBlockBlobClient(blobName);

export async function blobInfo(containerName, blobName) {
  const b = blobClient(containerName, blobName);
  const p = await b.getProperties().catch(e => { if (e.statusCode === 404) return null; throw e; });
  if (!p) return null;
  let tags = null, tagError = '';
  try { tags = (await b.getTags()).tags || {}; } catch (e) { tagError = e.statusCode === 403 ? 'permission' : 'error'; }
  return { size: p.contentLength, createdOn: p.createdOn?.toISOString?.() || '', tags, tagError };
}

export async function sha256Of(containerName, blobName) {
  const dl = await blobClient(containerName, blobName).download(0), h = createHash('sha256');
  for await (const c of dl.readableStreamBody) h.update(c);
  return h.digest('hex');
}
export const download = (containerName, blobName) => blobClient(containerName, blobName).downloadToBuffer();
export const remove = (containerName, blobName) => blobClient(containerName, blobName).deleteIfExists();
