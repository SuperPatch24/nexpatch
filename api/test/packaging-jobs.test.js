import test from 'node:test';
import assert from 'node:assert/strict';
import { finalizeUpload, deterministicJobId, evaluateWorkerResult, classifyJob, PackagingError, STATES, buildManifest } from '../src/lib/packaging-jobs.js';

const T = 'tenant-1', D = 'draft-1', BLOB = 'tenant-1/draft-1/abc-setup.msi';
const baseDraft = () => ({ uploadBlobName: BLOB, uploadFileName: 'setup.msi', uploadExpectedBytes: 100, uploadExpiresAt: '2099-01-01T00:00:00.000Z', installerType: 'msi', name: 'App', version: '1.0' });

// In-memory fake of every external effect, with per-boundary failure switches.
function harness({ fail = {}, draft = baseDraft() } = {}) {
  const rows = { PackageDrafts: { [D]: { ...draft } }, PackagingJobs: {} };
  const log = { manifests: [], queue: [], audits: [], writes: [] };
  const f = { ...fail };
  const trip = (k) => { if (f[k]) { if (f[k] === 'once') delete f[k]; throw new Error(`boom-${k}`); } };
  const deps = {
    maxBytes: 2 * 1024 ** 3,
    now: () => '2026-11-11T12:00:00.000Z',
    getRow: async (n, _t, k) => rows[n][k] ? { rowKey: k, ...rows[n][k] } : null,
    putRow: async (n, _t, k, fields, mode) => {
      trip(`putRow:${n}:${fields.status || 'any'}`); trip('putRow');
      rows[n][k] = mode === 'Replace' ? { ...fields } : { ...(rows[n][k] || {}), ...fields };
      log.writes.push([n, fields.status]);
    },
    audit: async (...a) => { trip('audit'); log.audits.push(a); },
    getBlobProps: async () => { trip('blob'); return { contentLength: f.size ?? 100 }; },
    hashBlob: async () => { trip('hash'); return 'a'.repeat(64); },
    writeManifest: async (t, j, m) => { trip('manifest'); log.manifests.push([t, j, m]); },
    enqueue: async (m) => { trip('queue'); log.queue.push(m); }
  };
  return { deps, rows, log, f };
}
const run = (h) => finalizeUpload(h.deps, { tenantId: T, draftId: D, actor: 'a@b.c' });
const status = (h) => h.rows.PackagingJobs[deterministicJobId(T, D, BLOB)]?.status;

test('finalize happy path: manifest, queue, then queued; one of each', async () => {
  const h = harness(); const r = await run(h);
  assert.equal(r.status, 'queued'); assert.equal(status(h), 'queued');
  assert.equal(h.log.manifests.length, 1); assert.equal(h.log.queue.length, 1);
  assert.equal(h.log.manifests[0][2].schemaVersion, 1);
  assert.equal(h.rows.PackageDrafts[D].status, 'queued'); assert.equal(h.rows.PackageDrafts[D].jobId, r.jobId);
});

test('finalize is idempotent: a second call creates nothing new', async () => {
  const h = harness(); const a = await run(h); const b = await run(h);
  assert.equal(b.jobId, a.jobId); assert.equal(b.alreadyFinalized, true);
  assert.equal(h.log.manifests.length, 1); assert.equal(h.log.queue.length, 1);
  assert.equal(Object.keys(h.rows.PackagingJobs).length, 1);
});

test('blob read failure: 400, nothing persisted', async () => {
  const h = harness({ fail: { blob: true } });
  await assert.rejects(run(h), e => e instanceof PackagingError && e.status === 400);
  assert.deepEqual(h.rows.PackagingJobs, {}); assert.equal(h.log.queue.length, 0);
});

test('size mismatch: 400, nothing persisted', async () => {
  const h = harness(); h.f.size = 999;
  await assert.rejects(run(h), e => e.status === 400);
  assert.deepEqual(h.rows.PackagingJobs, {});
});

test('hash failure: 502, nothing persisted, retry succeeds', async () => {
  const h = harness({ fail: { hash: 'once' } });
  await assert.rejects(run(h), e => e.status === 502);
  assert.deepEqual(h.rows.PackagingJobs, {});
  assert.equal((await run(h)).status, 'queued');
});

test('job persistence failure before queueing: nothing is queued', async () => {
  const h = harness({ fail: { 'putRow:PackagingJobs:validating': true } });
  await assert.rejects(run(h), e => e.status === 503);
  assert.equal(h.log.manifests.length, 0); assert.equal(h.log.queue.length, 0); assert.notEqual(status(h), 'queued');
});

test('manifest write failure: never queued, never enqueued, retry-required, then recovers with ONE job and ONE message', async () => {
  const h = harness({ fail: { manifest: 'once' } });
  await assert.rejects(run(h), e => e.status === 502 && /manifest/.test(e.message));
  assert.equal(status(h), STATES.RETRY_REQUIRED); assert.equal(h.log.queue.length, 0);
  assert.equal(h.rows.PackageDrafts[D].status, STATES.RETRY_REQUIRED);
  assert.ok(!h.log.writes.some(([, s]) => s === 'queued'), 'must never have written queued');
  const r = await run(h);
  assert.equal(r.status, 'queued'); assert.equal(Object.keys(h.rows.PackagingJobs).length, 1);
  assert.equal(h.log.queue.length, 1); assert.equal(h.log.manifests.length, 1);
});

test('queue write failure: manifest exists, job is retry-required (not queued), retry enqueues once', async () => {
  const h = harness({ fail: { queue: 'once' } });
  await assert.rejects(run(h), e => e.status === 502 && /queued/.test(e.message));
  assert.equal(status(h), STATES.RETRY_REQUIRED); assert.equal(h.log.manifests.length, 1);
  assert.ok(!h.log.writes.some(([, s]) => s === 'queued'));
  assert.equal((await run(h)).status, 'queued');
  assert.equal(h.log.queue.length, 1); assert.equal(Object.keys(h.rows.PackagingJobs).length, 1);
});

test('final persistence failure after enqueue: not reported queued; retry resumes, same job id', async () => {
  const h = harness({ fail: { 'putRow:PackagingJobs:queued': 'once' } });
  await assert.rejects(run(h), e => e.status === 503);
  assert.notEqual(status(h), 'queued');
  const r = await run(h);
  assert.equal(r.status, 'queued'); assert.equal(r.jobId, deterministicJobId(T, D, BLOB));
  assert.equal(Object.keys(h.rows.PackagingJobs).length, 1);
  // Documented trade-off: this one boundary can produce a duplicate queue message; the callback guard absorbs it.
  assert.ok(h.log.queue.length >= 1 && h.log.queue.length <= 2);
});

test('audit failure does not undo a queued job', async () => {
  const h = harness({ fail: { audit: true } });
  assert.equal((await run(h)).status, 'queued'); assert.equal(status(h), 'queued');
});

test('expired upload session is rejected only for first-time finalize', async () => {
  const d = baseDraft(); d.uploadExpiresAt = '2020-01-01T00:00:00.000Z';
  await assert.rejects(run(harness({ draft: d })), e => e.status === 410);
  // retry after expiry is allowed once a job record exists
  const h = harness({ draft: { ...baseDraft(), uploadExpiresAt: '2099-01-01T00:00:00.000Z' }, fail: { manifest: 'once' } });
  await assert.rejects(run(h)); h.rows.PackageDrafts[D].uploadExpiresAt = '2020-01-01T00:00:00.000Z';
  assert.equal((await run(h)).status, 'queued');
});

test('a draft bound to a different job cannot be finalized again', async () => {
  const h = harness(); h.rows.PackageDrafts[D].jobId = 'some-other-job';
  await assert.rejects(run(h), e => e.status === 409);
});

test('error messages returned to the UI contain no secrets or internal error text', async () => {
  for (const k of ['hash', 'manifest', 'queue']) {
    const h = harness({ fail: { [k]: true } });
    await assert.rejects(run(h), e => !/boom|sig=|SharedAccessKey|https?:\/\//i.test(e.message));
  }
});

test('manifest preserves wizard metadata fields', () => {
  const m = buildManifest({ ...baseDraft(), detectionType: 'msi', returnCodes: '0,3010', dependencies: 'x' }, { tenantId: T, jobId: 'j', sha256: 'h', fileSize: 1 });
  assert.equal(m.detectionType, 'msi'); assert.equal(m.returnCodes, '0,3010'); assert.equal(m.dependencies, 'x'); assert.equal(m.schemaVersion, 1);
});

test('worker callback guard: unknown job, bad status, premature and duplicate/late results', () => {
  assert.equal(evaluateWorkerResult(null, 'test-passed').httpStatus, 404);
  assert.equal(evaluateWorkerResult({ status: 'queued' }, 'hacked').httpStatus, 400);
  assert.equal(evaluateWorkerResult({ status: 'validating' }, 'test-passed').httpStatus, 409);
  assert.equal(evaluateWorkerResult({ status: 'retry-required' }, 'test-passed').httpStatus, 409);
  assert.equal(evaluateWorkerResult({ status: 'test-passed' }, 'worker-error').httpStatus, 409);
  assert.equal(evaluateWorkerResult({ status: 'scan-failed' }, 'test-passed').httpStatus, 409);
  assert.equal(evaluateWorkerResult({ status: 'queued' }, 'packaged-awaiting-test').ok, true);
  assert.equal(evaluateWorkerResult({ status: 'worker-error' }, 'packaged-awaiting-test').ok, true);
});

test('reconcile classification: stale validating and queued-without-manifest are flagged; healthy jobs are not', () => {
  const now = '2026-11-11T12:00:00.000Z';
  assert.equal(classifyJob({ status: 'validating', updatedAt: '2026-11-11T11:00:00.000Z' }, { now }).action, 'mark-retry');
  assert.equal(classifyJob({ status: 'validating', updatedAt: '2026-11-11T11:59:00.000Z' }, { now }).action, 'ok');
  assert.equal(classifyJob({ status: 'queued', updatedAt: now }, { manifestExists: false, now }).stage, 'manifest-missing');
  assert.equal(classifyJob({ status: 'queued', updatedAt: now }, { manifestExists: true, now }).action, 'ok');
  assert.equal(classifyJob({ status: 'queued', updatedAt: now }, { manifestExists: undefined, now }).action, 'ok');
});

test('manifest preserves structured catalog dependency and supersedence selections', async () => {
  const manifest = buildManifest({
    uploadBlobName: 'tenant/draft/file.msi', uploadFileName: 'file.msi', installerType: 'msi',
    dependencies: [{ id: 'dep-1', name: 'Runtime' }], dependencyType: 'auto',
    supersedence: [{ id: 'old-1', name: 'Legacy App' }], uninstallSuperseded: true,
    detectionType: 'script', detectionScript: 'Write-Output "Installed"; exit 0'
  }, { tenantId: 'tenant', jobId: 'job', sha256: 'abc', fileSize: 10 });
  assert.deepEqual(JSON.parse(manifest.dependencies), [{ id: 'dep-1', name: 'Runtime' }]);
  assert.deepEqual(JSON.parse(manifest.supersedence), [{ id: 'old-1', name: 'Legacy App' }]);
  assert.equal(manifest.dependencyType, 'auto');
  assert.equal(manifest.uninstallSuperseded, true);
  assert.match(manifest.detectionScript, /Installed/);
});
