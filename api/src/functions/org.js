import { app } from '@azure/functions';
import { BlobServiceClient } from '@azure/storage-blob';
import { DefaultAzureCredential } from '@azure/identity';
import { withUser, HttpError, readJson } from '../lib/http.js';
import { getTenant, getRow, putRow, audit } from '../lib/store.js';
import { planStatus } from '../lib/plan.js';
import { SYNC_SCHEDULE, MAX_LOGO_BYTES, nextDailyRun, sniffImage, cleanProfile } from '../lib/org.js';

const CONTAINER = 'nexpatch-org-assets';
let blobs;
function container() {
  if (!blobs) {
    if (process.env.BLOB_STORAGE_CONNECTION) blobs = BlobServiceClient.fromConnectionString(process.env.BLOB_STORAGE_CONNECTION);
    else if (process.env.BLOB_STORAGE_URL) blobs = new BlobServiceClient(process.env.BLOB_STORAGE_URL, new DefaultAzureCredential());
    else throw new HttpError(503, 'Logo storage is not configured on this platform yet.');
  }
  return blobs.getContainerClient(CONTAINER);
}
const logoName = tid => `${tid}/logo`;
async function readLogo(tid) {
  try {
    const c = container(), b = c.getBlockBlobClient(logoName(tid));
    if (!(await b.exists())) return null;
    const buf = await b.downloadToBuffer();
    const type = sniffImage(buf);
    return type ? { contentType: type, dataUrl: `data:${type};base64,${buf.toString('base64')}` } : null;
  } catch (err) { if (err instanceof HttpError) throw err; return null; }
}

// Where customer data is stored is a platform fact, not something each customer picks: DATA_STORE_LOCATION if you set it,
// otherwise the Azure region the Function App reports about itself.
function dataLocation() {
  const configured = String(process.env.DATA_STORE_LOCATION || '').trim();
  if (configured) return { value: configured, source: 'configured' };
  const region = String(process.env.REGION_NAME || '').trim();
  return region ? { value: region, source: 'azure-region' } : { value: '', source: 'unknown' };
}

app.http('orgGet', { methods: ['GET'], authLevel: 'anonymous', route: 'org', handler: withUser(async (_req, _c, user) => {
  const t = await getTenant(user.tenantId);
  if (!t) throw new HttpError(404, 'Your organization isn’t connected yet.');
  const profile = await getRow('OrgProfiles', user.tenantId, 'profile');
  const plan = planStatus(t);
  return {
    companyName: profile?.companyName || '',
    updatedAt: profile?.updatedAt || null,
    tenantId: t.rowKey,
    connectedAt: t.activatedAt || null,
    dataLocation: dataLocation(),
    subscription: { plan: plan.plan, active: plan.active, daysLeft: plan.daysLeft, trialStartedAt: t.trialStartedAt || null, trialEndsAt: plan.trialEndsAt || null, activatedAt: t.activatedAt || null },
    sync: { lastSyncAt: t.lastSyncAt || null, lastSyncCount: t.lastSyncCount || 0, lastSyncError: t.lastSyncError || '', schedule: SYNC_SCHEDULE.label, nextRunAt: nextDailyRun(), scheduledSyncActive: plan.active }
  };
}, 'viewer') });

app.http('orgSave', { methods: ['PUT'], authLevel: 'anonymous', route: 'org', handler: withUser(async (req, _c, user) => {
  const c = cleanProfile(await readJson(req)); if (c.error) throw new HttpError(400, c.error);
  await putRow('OrgProfiles', user.tenantId, 'profile', { ...c.value, updatedAt: new Date().toISOString(), updatedBy: user.email || user.userId }, 'Merge');
  await audit(user.tenantId, user.email || user.userId, 'org.profile.updated', c.value.companyName);
  return { companyName: c.value.companyName };
}, 'admin') });

app.http('orgLogoGet', { methods: ['GET'], authLevel: 'anonymous', route: 'org/logo', handler: withUser(async (_r, _c, user) => ({ logo: await readLogo(user.tenantId) }), 'viewer') });

app.http('orgLogoSave', { methods: ['PUT'], authLevel: 'anonymous', route: 'org/logo', handler: withUser(async (req, _c, user) => {
  const b = await readJson(req);
  const buf = Buffer.from(String(b.data || ''), 'base64');
  if (!buf.length) throw new HttpError(400, 'Choose an image file.');
  if (buf.length > MAX_LOGO_BYTES) throw new HttpError(413, 'The logo is too large. Use an image under 256 KB.');
  const type = sniffImage(buf);
  if (!type) throw new HttpError(415, 'Use a PNG, JPEG or WebP image. SVG files aren’t accepted.');
  const c = container(); await c.createIfNotExists();
  await c.getBlockBlobClient(logoName(user.tenantId)).uploadData(buf, { blobHTTPHeaders: { blobContentType: type } });
  await audit(user.tenantId, user.email || user.userId, 'org.logo.updated', type);
  return { logo: { contentType: type, dataUrl: `data:${type};base64,${buf.toString('base64')}` } };
}, 'admin') });

app.http('orgLogoDelete', { methods: ['DELETE'], authLevel: 'anonymous', route: 'org/logo', handler: withUser(async (_r, _c, user) => {
  await container().getBlockBlobClient(logoName(user.tenantId)).deleteIfExists();
  await audit(user.tenantId, user.email || user.userId, 'org.logo.removed', '');
  return { removed: true };
}, 'admin') });
