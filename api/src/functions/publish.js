import { app, output } from '@azure/functions';
import { withUser, HttpError, readJson } from '../lib/http.js';
import { getTenant, saveJob, getJob, listJobs, audit } from '../lib/store.js';
import { publishApp } from '../lib/publisher.js';
import { randomUUID } from 'node:crypto';
import { planStatus } from '../lib/plan.js';

const queue = output.storageQueue({ queueName: 'publish-jobs', connection: 'AzureWebJobsStorage' });
const WINGET_ID = /^[A-Za-z0-9][A-Za-z0-9.+_-]{1,100}$/;

// POST /api/publish – queue a publish of one app with the options chosen on the website.
app.http('publishStart', {
  methods: ['POST'], authLevel: 'anonymous', route: 'publish', extraOutputs: [queue],
  handler: withUser(async (req, context, user) => {
    const t = await getTenant(user.tenantId);
    if (!t || t.status !== 'active') throw new HttpError(409, 'Connect your organization on the Connect page before publishing.');
    if (!planStatus(t).active) throw new HttpError(402, 'Your free trial has ended. Subscribe to keep publishing apps.');
    const { app: a, options } = await readJson(req);
    const source = a?.source === 'msstore' ? 'msstore' : 'winget';
    if (source === 'msstore') throw new HttpError(409, 'This Microsoft Store entry is catalog-only for now. Native Intune Store app publishing and update handling must be enabled before deployment.');
    if (!a || !a.name || !WINGET_ID.test(a.winget || '') || !a.reg) throw new HttpError(400, 'The app needs a name, a winget ID and its name in Installed apps.');
    if (!options || typeof options !== 'object') throw new HttpError(400, 'Deployment options are missing.');
    const jobId = randomUUID();
    await saveJob(user.tenantId, jobId, {
      status: 'queued', appName: a.name, wingetId: a.winget, summary: String(options.summary || '').slice(0, 200),
      createdBy: user.email || user.userId, createdAt: new Date().toISOString(), log: JSON.stringify([]),
      request: JSON.stringify({ app: { name: a.name, winget: a.winget, reg: a.reg, vendor: a.vendor || '', source, storeFamily: a.storeFamily || '' }, options })
    });
    context.extraOutputs.set(queue, { tenantId: user.tenantId, jobId });
    await audit(user.tenantId, user.email || user.userId, 'started publishing', a.name);
    return { jobId };
  }, 'admin')
});

// GET /api/publish – recent publishing jobs. GET /api/publish/{id} – one job with its log.
const shape = (j, withLog) => ({ id: j.rowKey, status: j.status, appName: j.appName, version: j.version || null, summary: j.summary || '', appId: j.appId || null,
  createdBy: j.createdBy, createdAt: j.createdAt, finishedAt: j.finishedAt || null, error: j.error || '', step: j.step || '', ...(withLog ? { log: JSON.parse(j.log || '[]') } : {}) });
app.http('publishList', {
  methods: ['GET'], authLevel: 'anonymous', route: 'publish',
  handler: withUser(async (_req, _ctx, user) => ({ jobs: (await listJobs(user.tenantId, 30)).map(j => shape(j, false)) }), 'viewer')
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
      const result = await publishApp(tenantId, a, options, text => { log(text); });
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
