# Application Packaging Wizard

## Scope in this release

The wizard captures Windows application packaging intake metadata and saves a tenant-scoped draft. It supports MSI, EXE, MSIX, APPX and existing `.intunewin` declarations, plus HTTPS installer URL, architecture, install/uninstall commands, detection notes and requirements.

## Workflow status

A saved draft is **not** a package. This phase does not accept installer file uploads, download installers, calculate SHA-256, verify Authenticode, scan malware, execute installers, create `.intunewin` files, test installs or publish to Intune.

## Required next infrastructure

1. Private Azure Blob upload container with short-lived upload authorization and file-size limits.
2. Server-side file hash and Authenticode verification; vendor-published hashes should be recorded when available.
3. Malware scanning and quarantine workflow.
4. Isolated Windows packaging worker running Microsoft's official Win32 Content Prep Tool.
5. Install/uninstall testing in disposable Windows VMs, detection-rule validation and reboot handling.
6. Platform review and customer approval before publication.
7. Audit records, immutable package versions and retention controls.

Never execute an untrusted installer inside the Azure Functions host. A draft must remain clearly marked as draft until every validation stage is complete.

## Secure upload and Windows worker (new)

The wizard now accepts MSI and EXE source files and uploads them directly to a private quarantine blob using a short-lived, blob-specific write SAS. Finalization verifies the expected byte count, computes SHA-256 server-side and queues a tenant-scoped job. A separate Windows worker performs the second hash check, Authenticode validation, Microsoft Defender Antivirus scan and official Microsoft Win32 Content Prep Tool conversion.

See [Secure Windows Packaging Worker](SECURE-WINDOWS-PACKAGING-WORKER.md) for deployment and configuration. The worker is a separately deployed Windows service and must be operational before customer uploads are enabled. A converted `.intunewin` remains unapproved until the isolated install/uninstall test and customer approval are complete. No package is automatically published or assigned to Intune.

## Expanded intake fields in this release

The wizard now records additional planning metadata with the package draft and private worker manifest:

- Detection strategy: automatic recommendation, MSI product code, file/folder, file version, registry or a custom detection-script note. The custom-script option is metadata only; it does not execute the script.
- Install context: system, user or validate either.
- Restart behavior: suppress, allow, determine from installer or force (review required).
- Return-code mapping, including success and reboot outcomes.
- Dependencies and prerequisite versions.
- Supersedence / replacement relationship.
- Intended deployment schedule and ring strategy.
- Notification preference and reporting requirements.

These values are intake metadata, not a live Intune assignment schedule. The current packaging worker does not create Intune assignments or execute deployment schedules. A customer administrator must review and approve the package and separately initiate deployment. Notifications selected in the wizard are preferences for a future notification workflow; they are not a guarantee that a message will be sent by this build.
