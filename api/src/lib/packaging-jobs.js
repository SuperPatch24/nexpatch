// Packaging job lifecycle: finalize (idempotent, recoverable), reconciliation, worker transition guard.
// This module has NO Azure imports on purpose: every external effect is injected via `deps`, so each
// failure boundary (blob read, hash, manifest write, queue write, job persistence) can be tested.
import { createHash } from 'node:crypto';

export class PackagingError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// Job / draft states. Hyphenated to match the statuses the Windows worker already reports.
export const STATES = Object.freeze({
  UPLOAD_PENDING: 'upload-pending',   // SAS issued, installer not yet finalized
  VALIDATING: 'validating',           // API is verifying + writing manifest + enqueueing (transient)
  QUEUED: 'queued',                   // manifest written AND queue message accepted
  RETRY_REQUIRED: 'retry-required',   // a finalize step failed; calling finalize again is safe
  CANCELLED: 'cancelled'
});

// Worker-reported outcomes that end a job. A late/duplicate worker message must not overwrite these.
export const TERMINAL_WORKER_STATES = new Set(['scan-failed', 'signature-rejected', 'test-passed', 'test-failed', 'cancelled']);
export const WORKER_RESULT_STATES = new Set(['scan-failed', 'signature-rejected', 'packaged-awaiting-test', 'test-passed', 'test-failed', 'worker-error']);

// States where calling finalize again should re-run the missing steps instead of returning the existing job.
const RETRYABLE = new Set([STATES.VALIDATING, STATES.RETRY_REQUIRED]);

export const MANIFEST_SCHEMA_VERSION = 1;
export const STALE_VALIDATING_MS = 15 * 60_000;

// Same draft + same uploaded blob => same job ID, so a retried finalize can never create a second job.
export function deterministicJobId(tenantId, draftId, blobName) {
  const h = createHash('sha256').update(`${tenantId}|${draftId}|${blobName}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

const s = v => (v && typeof v === 'object') ? JSON.stringify(v) : String(v || '');

export function buildManifest(draft, { tenantId, jobId, sha256, fileSize }) {
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION, tenantId, jobId,
    blobName: draft.uploadBlobName, fileName: draft.uploadFileName, sha256, fileSize,
    installerType: draft.installerType,
    installCommand: s(draft.installCommand), uninstallCommand: s(draft.uninstallCommand),
    detectionType: s(draft.detectionType), detectionPath: s(draft.detectionPath), detectionValue: s(draft.detectionValue), detectionScript: s(draft.detectionScript),
    installContext: s(draft.installContext), restartBehavior: s(draft.restartBehavior), returnCodes: s(draft.returnCodes),
    dependencies: s(draft.dependencies), dependencyType: s(draft.dependencyType), supersedence: s(draft.supersedence), uninstallSuperseded: !!draft.uninstallSuperseded,
    deploymentSchedule: s(draft.deploymentSchedule), deploymentRings: s(draft.deploymentRings),
    notificationSettings: s(draft.notificationSettings), reportingNotes: s(draft.reportingNotes),
    name: s(draft.name), version: s(draft.version)
  };
}

export function buildJob(draft, { tenantId, draftId, jobId, sha256, fileSize, actor, now }) {
  return {
    jobId, draftId, tenantId, blobName: draft.uploadBlobName, fileName: draft.uploadFileName, fileSize, sha256,
    installerType: draft.installerType,
    installCommand: s(draft.installCommand), uninstallCommand: s(draft.uninstallCommand),
    detectionRule: s(draft.detectionRule), detectionType: s(draft.detectionType), detectionPath: s(draft.detectionPath), detectionValue: s(draft.detectionValue), detectionScript: s(draft.detectionScript),
    installContext: s(draft.installContext), restartBehavior: s(draft.restartBehavior), returnCodes: s(draft.returnCodes),
    dependencies: s(draft.dependencies), dependencyType: s(draft.dependencyType), supersedence: s(draft.supersedence), uninstallSuperseded: !!draft.uninstallSuperseded,
    deploymentSchedule: s(draft.deploymentSchedule), deploymentRings: s(draft.deploymentRings),
    notificationSettings: s(draft.notificationSettings), reportingNotes: s(draft.reportingNotes),
    name: s(draft.name), publisher: s(draft.publisher), version: s(draft.version), architecture: s(draft.architecture || 'unknown'),
    status: STATES.VALIDATING, stage: 'validating', error: '', createdAt: now, updatedAt: now, requestedBy: actor
  };
}

/**
 * Idempotent, recoverable finalize.
 * Order matters: nothing is persisted until the blob is verified and hashed; the job is only marked `queued`
 * AFTER the manifest is written and the queue message is accepted. A failure after the job row exists leaves it
 * `retry-required` (never a false `queued`), and calling finalize again resumes safely.
 *
 * deps: { getRow, putRow, audit, getBlobProps(blobName), hashBlob(blobName), writeManifest(tenantId, jobId, manifest),
 *         enqueue(message), now() , maxBytes }
 */
export async function finalizeUpload(deps, { tenantId, draftId, actor }) {
  const draft = await deps.getRow('PackageDrafts', tenantId, draftId);
  if (!draft || !draft.uploadBlobName) throw new PackagingError(404, 'No active installer upload was found.');

  const jobId = deterministicJobId(tenantId, draftId, draft.uploadBlobName);
  if (draft.jobId && draft.jobId !== jobId) throw new PackagingError(409, 'This draft already has a different packaging job. Create a new draft for another build.');

  const existing = await deps.getRow('PackagingJobs', tenantId, jobId);
  if (existing && !RETRYABLE.has(existing.status)) {
    // Duplicate finalize (double click, retry after a lost response): report the job, change nothing.
    return { jobId, status: existing.status, sha256: existing.sha256, alreadyFinalized: true, message: 'This upload was already finalized. No new job was created.' };
  }
  // The upload window only matters for first-time finalize; a retry happens after the upload is already complete.
  if (!existing && draft.uploadExpiresAt && new Date(draft.uploadExpiresAt) < new Date(deps.now())) {
    throw new PackagingError(410, 'Upload session expired. Start a new upload.');
  }

  // 1. Blob must exist with the authorized size. Nothing is written yet, so failures here leave no residue.
  let props;
  try { props = await deps.getBlobProps(draft.uploadBlobName); }
  catch { throw new PackagingError(400, 'Installer upload is not present in private quarantine storage.'); }
  const fileSize = Number(props.contentLength);
  if (fileSize !== Number(draft.uploadExpectedBytes) || fileSize > deps.maxBytes) {
    throw new PackagingError(400, 'Uploaded file size does not match the authorized upload.');
  }

  // 2. Hash. Still nothing persisted.
  let sha256;
  try { sha256 = await deps.hashBlob(draft.uploadBlobName); }
  catch { throw new PackagingError(502, 'The installer could not be read back to verify it. Please retry finalize.'); }

  // 3. Persist the job as `validating` (NOT queued). From here on, failures must leave a recoverable record.
  const now = deps.now();
  const job = buildJob(draft, { tenantId, draftId, jobId, sha256, fileSize, actor, now });
  try {
    await deps.putRow('PackagingJobs', tenantId, jobId, job, 'Replace');
    await deps.putRow('PackageDrafts', tenantId, draftId, { status: STATES.VALIDATING, stage: 'validating', jobId, sha256, uploadFileSize: fileSize, updatedAt: now });
  } catch { throw new PackagingError(503, 'The job could not be recorded. Nothing was queued. Please retry finalize.'); }

  const fail = async (stage, status, message) => {
    try {
      const t = deps.now();
      await deps.putRow('PackagingJobs', tenantId, jobId, { status: STATES.RETRY_REQUIRED, stage, error: message, updatedAt: t });
      await deps.putRow('PackageDrafts', tenantId, draftId, { status: STATES.RETRY_REQUIRED, stage, updatedAt: t });
    } catch { /* the reconciler will flag a stale `validating` job */ }
    throw new PackagingError(status, message);
  };

  // 4. Manifest (same key + content on every retry, so overwriting is safe).
  try { await deps.writeManifest(tenantId, jobId, buildManifest(draft, { tenantId, jobId, sha256, fileSize })); }
  catch { await fail('manifest-write', 502, 'The installer was verified, but its job manifest could not be saved. Nothing was queued. Please retry finalize.'); }

  // 5. Queue message. Only after the manifest exists, so a worker can never dequeue a job with no manifest.
  try { await deps.enqueue({ tenantId, jobId }); }
  catch { await fail('queue-write', 502, 'The installer was verified and its manifest saved, but the job could not be queued. Please retry finalize.'); }

  // 6. Only now is the job `queued`. If this write fails the message is already in the queue; the job is marked
  //    `retry-required` (or left `validating` if even that write fails), the next finalize resumes, and the
  //    callback guard absorbs any duplicate worker result.
  try {
    const t = deps.now();
    await deps.putRow('PackagingJobs', tenantId, jobId, { status: STATES.QUEUED, stage: 'queued', error: '', updatedAt: t });
    await deps.putRow('PackageDrafts', tenantId, draftId, { status: STATES.QUEUED, stage: 'quarantine', updatedAt: t });
  } catch { await fail('job-persist', 503, 'The job was queued but its status could not be saved. Please retry finalize; duplicates are handled.'); }

  try { await deps.audit(tenantId, actor, 'queued secure installer packaging', `${s(draft.name)} (${s(draft.uploadFileName)}), SHA256 ${sha256}`); } catch { /* audit failure must not undo a queued job */ }
  return { jobId, status: STATES.QUEUED, sha256, message: 'Upload verified and queued. No installer has executed on the API service.' };
}

/** Decide whether a worker callback may change the job. Terminal results are never overwritten by a late/duplicate message. */
export function evaluateWorkerResult(job, nextStatus) {
  if (!job) return { ok: false, httpStatus: 404, error: 'Packaging job not found.' };
  if (!WORKER_RESULT_STATES.has(nextStatus)) return { ok: false, httpStatus: 400, error: 'Invalid worker status.' };
  if (TERMINAL_WORKER_STATES.has(String(job.status))) return { ok: false, httpStatus: 409, error: 'Job already has a final result; duplicate or late worker result ignored.' };
  if ([STATES.UPLOAD_PENDING, STATES.VALIDATING, STATES.RETRY_REQUIRED].includes(String(job.status))) {
    return { ok: false, httpStatus: 409, error: 'Job has not been fully queued; worker result rejected.' };
  }
  return { ok: true };
}

/** Pure classification used by the reconciliation timer. */
export function classifyJob(job, { manifestExists, now }) {
  const age = Date.parse(now) - Date.parse(job.updatedAt || job.createdAt || now);
  if (job.status === STATES.VALIDATING && age > STALE_VALIDATING_MS) return { action: 'mark-retry', stage: 'stale-validating', reason: 'Finalize did not complete; retry finalize.' };
  if (job.status === STATES.QUEUED && manifestExists === false) return { action: 'mark-retry', stage: 'manifest-missing', reason: 'Job was queued but its manifest is missing; retry finalize.' };
  return { action: 'ok' };
}
