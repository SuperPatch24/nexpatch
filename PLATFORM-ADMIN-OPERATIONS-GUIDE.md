# NexpatchOnline — Platform Administrator Operations Guide

## 1. Platform roles

- Super Admin: platform-wide configuration, security, billing and operator access.
- Catalog Manager: shared application catalog and remediation library curation within assigned permissions.
- Support Admin: customer requests, communications and support reporting. No catalog publishing or tenant-wide configuration.

Keep allowlists small, use named operator accounts with MFA and review membership on a scheduled basis. Customer tenant roles are separate from NexpatchOnline platform roles.

## 2. Shared catalog governance

A catalog item must have authoritative source evidence, verified publisher, product identifier, version, architecture, install/uninstall behavior, detection method, update source and licensing notes. Candidate entries are not deployable. Never invent Store IDs, package family names, publisher names or version numbers.

### WinGet

WinGet is a platform catalog source and publishing workflow. Keep WinGet package identifiers, manifest review and source management out of customer-facing administration screens. Customer administrators may deploy only approved shared catalog entries and must not be able to edit platform source metadata.

Before approval, inspect the official manifest and installer URLs, hashes, architecture, silent switches and publisher signature where available. A manifest hash is useful integrity evidence but does not independently prove a vendor's identity. Record the source commit and review date.

### Microsoft Store

Verify the exact Store listing, publisher, product ID, URL and supported deployment type. Keep unverified candidates disabled for deployment. Store deployment currently uses a Microsoft Graph beta resource in this codebase; validate in a test tenant and monitor Microsoft API changes.

## 3. Guided package intake

The desired package wizard should guide an operator through:

1. Source selection: official vendor URL, approved WinGet manifest, Microsoft Store listing, or authorized customer upload.
2. Metadata: product name, publisher, version, architecture, language, license, release notes and support URL.
3. Provenance: source URL, download timestamp, SHA-256, Authenticode status and vendor-published checksum if available.
4. Security: malware scan, archive inspection, dependency review and risk classification.
5. Install configuration: silent install/uninstall commands, return codes, detection rule, reboot behavior and user/system context.
6. Packaging: use Microsoft's official Win32 Content Prep Tool on a dedicated isolated Windows worker for Win32 `.intunewin` packages. Do not treat a custom ZIP wrapper as equivalent.
7. Lab test: install, upgrade, uninstall, reinstall, detection and failure-path tests on disposable VMs.
8. Review: second-person approval, immutable package hash and release notes.
9. Publish: create/update the shared catalog entry and record Intune publish outcomes.
10. Monitor: pilot ring, early adopters, broad ring, rollback plan and version history.

Customer-uploaded installers must remain private to that tenant unless rights and security review explicitly approve shared distribution.

## 4. Remediation script governance

The Remediation Scripts section in this release stores script definitions as drafts. It does not execute or assign them. Before enabling execution, implement static analysis, malware scanning, signature/hash provenance, isolated tests, dual approval, customer consent, scoped Intune assignment, execution controls, per-device reporting, pause/stop and rollback. See `REMEDIATION-SCRIPTS-OPERATING-GUIDE.md`.

## 5. Invitations and communications

User invitations are stored against the organization and sent through the configured Brevo transactional sender. A failed send must be visible to the inviter; it must not silently appear as a delivered invitation. The invited user is activated on first sign-in with the exact invited Microsoft account. Review Azure Function logs and Brevo transactional logs when delivery fails.

Cloudflare Email Routing forwards inbound email to the designated Gmail destination. It is not an application inbox or webhook. Do not mark an email as received/stored in the Admin Center unless an inbound provider integration has actually delivered and persisted the message.

## 6. Intune permission governance

Maintain a permission-to-endpoint matrix from the exact Graph routes in the deployed release. Separate read-only inventory, app create/update, assignments, App Control, Defender and script execution. Validate the matrix against current Microsoft Graph permission reference before each release. Use least privilege and tenant-specific consent records. Never promise a permission checklist is dynamically verified unless the application actually reads and stores consent status.

## 7. Release and incident operations

- Review changes and automated tests before deployment.
- Deploy to a staging Function App and static site before production.
- Verify authentication, role boundaries, Graph consent, Brevo delivery and storage access.
- Confirm logs do not contain credentials, tokens, installer contents or unnecessary personal data.
- Keep backups and a rollback build.
- Record release version, change ticket, operator, time and smoke-test outcome.
