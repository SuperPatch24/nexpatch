# NexpatchOnline secure Windows packaging worker

## What this release implements

- Tenant-admin-only upload session creation for MSI and EXE installers.
- Short-lived, single-blob write SAS (15 minutes) to a private quarantine container.
- Finalization checks the exact expected size, enforces a 2 GiB cap, streams the blob to calculate SHA-256, records a tenant-scoped packaging job and queues it.
- The worker runs outside Azure Functions on a dedicated Windows host. It verifies the hash again, checks Authenticode, updates Microsoft Defender signatures, performs a Defender custom scan, and invokes Microsoft's `IntuneWinAppUtil.exe` to create an `.intunewin` file.
- Output is stored in a separate private artifact container. Customers can request a five-minute read SAS for their own tenant's artifact.
- Worker callbacks use a shared secret (`PACKAGING_WORKER_TOKEN`) and tenant/job IDs are cross-checked against the stored job.
- Optional disposable Hyper-V test VM script snapshots a baseline, disconnects guest networking, copies the source installer into the guest, runs install/uninstall commands, then restores the baseline.

## Important limitations

- This is a worker framework, not a deployed or independently penetration-tested service. Do not expose the worker VM to customers or the public internet.
- The worker currently rejects installers without a valid Authenticode signature. Unsigned packages require a separate manual review workflow; do not weaken the check globally.
- The Hyper-V test VM integration is opt-in and disabled by default. Configure a clean, disposable Windows test VM, PowerShell Direct, a dedicated local test credential, Hyper-V, and a disconnected virtual network before enabling it. The VM is reverted after each test. Test only with a known clean baseline and disposable VM; do not use a production server or production credentials.
- EXE install/uninstall command strings are administrator-supplied and execute only inside the isolated test guest. Restrict who can create packaging jobs. Do not configure Hyper-V testing until you have reviewed your guest isolation and recovery controls.
- Conversion success is not proof of successful installation. Jobs without a successful isolated test remain `packaged-awaiting-test`; even `test-passed` still requires customer approval before publishing/deployment.
- For EXE isolated testing, enter only the silent arguments for the uploaded executable (for example `/S`); the worker launches the uploaded file directly. The uninstall command is executed inside the isolated guest. For MSI, the worker uses standard quiet `msiexec` install and uninstall commands. The worker packages a single MSI/EXE source file. Complex installers that require companion files, transforms, prerequisite folders, custom detection, or dependency chains need a future multi-file payload workflow.
- No automatic Intune app creation, assignment or deployment occurs in this pipeline.

## Azure resources and settings

Use a dedicated storage account/container namespace for installer data, preferably separate from general application data. Keep all containers private and enable encryption at rest, secure transfer, diagnostic logging, Defender for Storage where licensed, and a lifecycle policy to delete abandoned quarantine blobs/manifests and old artifacts according to your retention policy.

Azure Function App settings:

- `BLOB_STORAGE_CONNECTION`: storage account connection string (or configure `BLOB_STORAGE_URL` with managed identity and grant Blob Data Contributor).
- `PACKAGING_WORKER_TOKEN`: high-entropy random secret shared with the worker. Store in Key Vault/App Settings; never commit it.
- `BLOB_STORAGE_ACCOUNT_NAME`: required only for user-delegation SAS when it cannot be derived from `BLOB_STORAGE_URL`.
- Queue access: the Function App identity/connection must be able to create queues and send messages.

Containers created by the API/worker:

- `nexpatch-packaging-quarantine`
- `nexpatch-packaging-manifests`
- `nexpatch-packaging-artifacts`

Queue: `nexpatch-packaging-jobs`.

Configure Storage account CORS to allow your exact Nexpatch website origin (for example `https://nexpatchonline.com`), methods `PUT` and `OPTIONS`, request headers `*`, and expose `ETag` and `x-ms-request-id`; do not use wildcard origins in production. The short-lived SAS is scoped to one blob, but Azure Blob SAS does not cap the upload byte count: finalization rejects any size mismatch/oversize, so use a dedicated account with storage alerts/quotas and lifecycle cleanup to limit abandoned upload cost. The current API uses `BLOB_STORAGE_CONNECTION` for both Blob and Queue Storage. If using managed identity for Blob, set `QUEUE_STORAGE_CONNECTION` for the queue client until managed-identity queue authentication is added.

## Windows worker setup

1. Provision a dedicated Windows Server 2022/2025 VM in a restricted management subnet. Do not install this worker on the Azure Functions host or a general-purpose admin workstation.
2. Apply Windows updates, Defender Antivirus, EDR, disk encryption, least-privilege local accounts, outbound allow-listing and monitoring. Do not grant inbound public access.
3. Run `install-prerequisites.ps1` elevated. The worker uses the .NET QueueClient exposed by the Az.Storage queue object for dequeue/delete operations (the current Az.Storage PowerShell module does not provide queue data-plane message cmdlets).
4. Download the official Microsoft Win32 Content Prep Tool from https://github.com/microsoft/Microsoft-Win32-Content-Prep-Tool and verify its Microsoft-published release/signature before placing `IntuneWinAppUtil.exe` at the configured path.
5. Copy `worker.ps1` and `test-in-hyperv.ps1` to `C:\NexpatchWorker`. Copy `worker.config.example.json` to `worker.config.json`, fill only non-secret values, and restrict ACLs to SYSTEM and the worker administrators. Supply `NEXPATCH_STORAGE_CONNECTION`, `NEXPATCH_WORKER_TOKEN` and (when Hyper-V testing is enabled) `NEXPATCH_TEST_VM_PASSWORD` as machine-level secrets using your approved secret-management process.
6. Start `powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\NexpatchWorker\worker.ps1` as a dedicated service identity. Configure a Windows Scheduled Task with restart-on-failure or a service wrapper. Monitor process health, queue age, Defender health, disk free space and poison messages.
7. Confirm a harmless signed test MSI can be uploaded, scanned, packaged and retrieved before enabling customer access.

## Optional Hyper-V testing

- Use a dedicated Hyper-V host/VM with a clean supported Windows baseline and no production data.
- Keep the test VM network disconnected. Configure PowerShell Direct and a dedicated local test account.
- Set `EnableHyperVTest` to `true`, configure `TestVmName`, `TestVmCredentialUser` and `TestVmCredentialPassword` in a protected secret store, and validate snapshot restore behavior manually before first use.
- The test script reverts the VM to its checkpoint. EXE silent install and uninstall commands are run inside the guest and must be reviewed before submission. A failed test must not be bypassed by manually changing the status to passed.

## API routes

- `POST /api/packaging/drafts/{id}/upload-session`
- `POST /api/packaging/drafts/{id}/finalize-upload`
- `GET /api/packaging/jobs`
- `GET /api/packaging/jobs/{id}/artifact`
- `POST /api/packaging/worker/jobs/{id}/complete` (worker secret only)

## Deployment order

1. Deploy API code and add the storage settings/secret.
2. Install and configure the Windows worker; do not enable user uploads before the worker is running.
3. Deploy the static site.
4. Run end-to-end tests with a benign, vendor-signed MSI in a test tenant.
5. Verify quarantine, hash, signature, Defender scan, queue, `.intunewin` output, artifact SAS expiry, callback authentication and tenant isolation.
6. Enable customer packaging only after all checks pass.
