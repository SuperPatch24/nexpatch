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
