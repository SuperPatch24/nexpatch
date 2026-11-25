import { app, output } from '@azure/functions';
import { jobDisplayName } from '../lib/naming.js';
import { withUser, HttpError, readJson } from '../lib/http.js';
import { getTenant, getRow, saveJob, getJob, listJobs, audit } from '../lib/store.js';
import { publishApp, publishStoreApp } from '../lib/publisher.js';
import { randomUUID } from 'node:crypto';
import { planStatus } from '../lib/plan.js';
import { featureOn, featureMessage } from '../lib/tenantsettings.js';
import { stuckKind, stuckMessage } from '../lib/jobhealth.js';
import { graph } from '../lib/graph.js';
import { removeIntuneApp, REMOVAL_TEXT } from '../lib/removal.js';

const queue = output.storageQueue({ queueName: 'publish-jobs', connection: 'AzureWebJobsStorage' });
const WINGET_ID = /^[A-Za-z0-9][A-Za-z0-9.+_-]{1,100}$/;

// POST /api/publish – queue a publish of one app with the options chosen on the website.
app.http('publishStart', {
  methods: ['POST'], authLevel: 'anonymous', route: 'publish', extraOutputs: [queue],
  handler: withUser(async (req, context, user) => {
    const t = await getTenant(user.tenantId);
    if (!t || t.status !== 'active') throw new HttpError(409, 'Connect your organization on the Connect page before publishing.');
    if (!planStatus(t).active) throw new HttpError(402, 'Your free trial has ended. Subscribe to keep publishing apps.');
    if (!featureOn(t, 'apps')) throw new HttpError(403, featureMessage('apps'));
    if (!featureOn(t, 'packaging')) throw new HttpError(403, featureMessage('packaging'));
    const { app: a, options } = await readJson(req);
    const source = a?.source === 'msstore' ? 'msstore' : 'winget';
    if (!a || !a.name) throw new HttpError(400, 'The app name is required.');
    if (source === 'msstore') {
      const entry = await getRow('Catalog', 'global', String(a.catalogId || ''));
      if (!entry || entry.source !== 'msstore' || entry.enabled === false || entry.verificationStatus !== 'verified' || !entry.storeProductId || !entry.appStoreUrl) {
        throw new HttpError(409, 'This Microsoft Store catalog entry has not been verified by a NexpatchOnline catalog administrator yet.');
      }
      a.storeProductId = entry.storeProductId;
      a.appStoreUrl = entry.appStoreUrl;
      a.vendor = entry.vendor || a.vendor || '';
    } else if (!WINGET_ID.test(a.winget || '') || !a.reg) {
      throw new HttpError(400, 'The app needs a valid WinGet ID and its name in Installed apps.');
    }
    if (!options || typeof options !== 'object') throw new HttpError(400, 'Deployment options are missing.');
    const jobId = randomUUID();
    const operationType = source === 'winget' && options.updateOnly ? 'update' : 'deployment';
    await saveJob(user.tenantId, jobId, {
      status: 'queued', appName: a.name, wingetId: a.winget || '', source, operationType, summary: String(options.summary || '').slice(0, 200),
      createdBy: user.email || user.userId, createdAt: new Date().toISOString(), log: JSON.stringify([]),
      request: JSON.stringify({ app: { name: a.name, winget: a.winget || '', reg: a.reg || a.name, vendor: a.vendor || '', source, storeProductId: a.storeProductId || '', appStoreUrl: a.appStoreUrl || '', catalogId: a.catalogId || '' }, options })
    });
    context.extraOutputs.set(queue, { tenantId: user.tenantId, jobId });
    await audit(user.tenantId, user.email || user.userId, 'started publishing', a.name);
    return { jobId };
  }, 'admin')
});

// GET /api/publish – recent publishing jobs. GET /api/publish/{id} – one job with its log.
const shape = (j, withLog) => ({ id: j.rowKey, status: j.status, appName: j.appName, operationType: j.operationType || 'deployment', displayName: jobDisplayName(j), version: j.version || null, summary: j.summary || '', appId: j.appId || null, removedAt: j.removedAt || null,
  createdBy: j.createdBy, createdAt: j.createdAt, stuck: stuckKind(j), stuckMessage: stuckMessage(stuckKind(j)), finishedAt: j.finishedAt || null, error: j.error || '', step: j.step || '', ...(withLog ? { log: JSON.parse(j.log || '[]') } : {}) });
app.http('publishList', {
  methods: ['GET'], authLevel: 'anonymous', route: 'publish',
  handler: withUser(async (_req, _ctx, user) => ({ jobs: (await listJobs(user.tenantId, 30)).map(j => shape(j, false)) }), 'viewer')
});
// Last successful publish per app, for the catalog's "Last updated" column.
app.http('publishSummary', {
  methods: ['GET'], authLevel: 'anonymous', route: 'publish-summary',
  handler: withUser(async (_req, _ctx, user) => {
    const apps = {};
    for (const j of await listJobs(user.tenantId, 2000)) {
      if (j.status !== 'succeeded' || !j.appName || j.removedAt) continue;
      const at = j.finishedAt || j.createdAt;
      if (!apps[j.appName] || String(at) > String(apps[j.appName].at)) apps[j.appName] = { at, version: j.version || '', operationType: j.operationType || 'deployment' };
    }
    return { apps };
  }, 'viewer')
});
app.http('publishGet', {
  methods: ['GET'], authLevel: 'anonymous', route: 'publish/{id}',
  handler: withUser(async (req, _ctx, user) => {
    const j = await getJob(user.tenantId, req.params.id);
    if (!j) throw new HttpError(404, 'That publishing job wasn\u2019t found.');
    return shape(j, true);
  }, 'viewer')
});

// Queue worker: does the actual publishing. Runs once per job (no automatic retries, to avoid duplicate apps).
app.storageQueue('publishWorker', {
  queueName: 'publish-jobs', connection: 'AzureWebJobsStorage',
  handler: async (msg, context) => {
    const { tenantId, jobId } = typeof msg === 'string' ? JSON.parse(msg) : msg;
    const job = await getJob(tenantId, jobId);
    if (!job) return;
    if (job.status === 'running') { await saveJob(tenantId, jobId, { status: 'failed', error: 'This job was interrupted. Start the publish again.', finishedAt: new Date().toISOString() }); return; }
    if (job.status !== 'queued') return; // already finished
    const lines = [];
    const log = async text => { lines.push({ at: new Date().toISOString(), text }); context.log(`[${jobId}] ${text}`); await saveJob(tenantId, jobId, { log: JSON.stringify(lines), step: String(text).slice(0, 200) }).catch(() => {}); };
    await saveJob(tenantId, jobId, { status: 'running', startedAt: new Date().toISOString() });
    try {
      const { app: a, options } = JSON.parse(job.request);
      const result = a.source === 'msstore' ? await publishStoreApp(tenantId, a, options, text => { log(text); }) : await publishApp(tenantId, a, options, text => { log(text); });
      await log('Done');
      await saveJob(tenantId, jobId, { status: 'succeeded', appId: result.appId, version: result.version, finishedAt: new Date().toISOString() });
      await audit(tenantId, job.createdBy, 'published', `${a.name} ${result.version}`);
    } catch (err) {
      await log(`Failed: ${err.message}`);
      await saveJob(tenantId, jobId, { status: 'failed', error: String(err.message).slice(0, 500), finishedAt: new Date().toISOString() });
      await audit(tenantId, job.createdBy, 'publish failed', `${job.appName}: ${err.message}`.slice(0, 300));
    }
  }
});

// DELETE /api/publish/{id} – removes a published deployment: deletes the app NexpatchOnline created in Intune (with its
// assignments), then marks the job removed. Devices that already installed the app keep it; deleting an app in Intune
// does not uninstall it.
app.http('publishRemove', {
  methods: ['DELETE'], authLevel: 'anonymous', route: 'publish/{id}',
  handler: withUser(async (req, _ctx, user) => {
    const j = await getJob(user.tenantId, req.params.id);
    if (!j) throw new HttpError(404, 'That publishing job wasn\u2019t found.');
    if (['queued', 'running'].includes(j.status)) throw new HttpError(409, 'This is still publishing. Wait for it to finish, then remove it.');
    let r = { status: 'no-app' };
    if (j.appId && !j.removedAt) {
      r = await removeIntuneApp({ graph: (p, o) => graph(user.tenantId, p, o) }, j.appId).catch(err => { throw new HttpError(err.status && err.status < 500 ? err.status : 502, `Couldn\u2019t remove it from Intune: ${String(err.message).slice(0, 300)}`); });
    }
    const at = new Date().toISOString();
    await saveJob(user.tenantId, j.rowKey, { removedAt: at, removedBy: user.email || user.userId, removal: r.status });
    // Other jobs that ended on the same Intune app (a republish of the same version) are gone with it.
    if (j.appId && (r.status === 'removed' || r.status === 'already-gone')) {
      for (const o of await listJobs(user.tenantId, 2000)) if (o.rowKey !== j.rowKey && o.appId === j.appId && !o.removedAt) await saveJob(user.tenantId, o.rowKey, { removedAt: at, removedBy: user.email || user.userId, removal: r.status });
    }
    await audit(user.tenantId, user.email || user.userId, 'removed deployment', `${j.appName}${j.version ? ' ' + j.version : ''}: ${r.status}`);
    return { status: r.status, message: REMOVAL_TEXT[r.status] };
  }, 'admin')
});
