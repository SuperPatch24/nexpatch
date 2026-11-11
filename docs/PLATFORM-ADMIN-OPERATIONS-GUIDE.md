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


# 8. Full platform creation and launch runbook — chronological master checklist

This section is the end-to-end record for creating and operating the NexpatchOnline platform itself. It is written for the platform operator, not for a customer tenant administrator. Complete each stage in order and record the actual resource names, dates, operator, evidence and rollback point in the private change log. Never paste secrets into this document.

## 8.1 Product definition and governance

1. Define the product boundary: NexpatchOnline is a multi-tenant SaaS management plane for app discovery, packaging, update publishing, deployment reporting and App Control workflows for Microsoft Intune.
2. Keep platform identities separate from customer tenant identities. Platform roles are Super Admin, Catalog Manager and Support Admin; customer roles are Owner, Admin and Viewer.
3. Decide which features are live, preview, planned or disabled. Do not market a planned feature as operational.
4. Define customer data boundaries: tenant-scoped rows, tenant-scoped uploads, no cross-tenant installer sharing by default, and explicit authorization for any shared catalog promotion.
5. Define approval boundaries: no silent customer-tenant deployment, assignment or policy change. Publishing and deployment require explicit customer administrator action and audit records.
6. Establish a change log, incident log, release version scheme, staging environment and rollback artifact before production work.

## 8.2 Source control and project setup

1. Create a private source repository and protect the production branch.
2. Store the API, public site, worker, documentation and deployment configuration in version control. Exclude `.env`, local settings containing credentials, tokens, installer files and customer exports.
3. Review dependencies, pin versions where practical, enable dependency/security alerts and retain lockfiles.
4. Run syntax checks and automated tests for every change. Require review for authentication, tenant isolation, Graph permissions, installer processing and billing changes.
5. Build a release ZIP from a clean checkout and verify archive integrity before release.

## 8.3 Domain, DNS and public website

1. Register and control `nexpatchonline.com` using an organization-owned registrar account with MFA and recovery contacts.
2. Configure Cloudflare DNS and the public site hosting target. Keep DNS records documented before editing them.
3. Configure root email routing only if forwarding is desired. Cloudflare Email Routing is forwarding, not a mailbox, application inbox or inbound webhook.
4. Keep the Brevo reply subdomain MX records separate from root Cloudflare routing. Do not remove records unless intentionally changing providers.
5. Publish SPF, DKIM and DMARC records from the email provider's current authenticated-domain instructions. Verify each record after DNS propagation.
6. Configure HTTPS, canonical redirects, security headers and a tested custom-domain deployment.
7. Confirm the public website, login redirect, `/admin/` route and static asset paths work over HTTPS.

## 8.4 Microsoft Entra application registration

1. Create the NexpatchOnline Entra app registration in the platform's controlled tenant.
2. Configure supported account types deliberately; validate multi-tenant sign-in in a separate customer test tenant.
3. Add only required redirect URIs for the customer portal and Admin Center. Do not reuse a localhost redirect in production web sign-in.
4. Configure delegated and application Graph permissions only for implemented features. Maintain a route-to-permission matrix and distinguish read from write scopes.
5. Grant admin consent only after reviewing the exact permissions and the current Microsoft Graph documentation.
6. Configure platform-admin allowlists and verify each operator's role. Require MFA and use named accounts, not shared accounts.
7. Test tenant isolation with two independent test tenants and confirm users cannot read or mutate another tenant's records.
8. Keep client secrets and certificates in a managed secret store. Set expiry alerts and rotate before expiry.

## 8.5 Azure resource provisioning and API configuration

1. Create a dedicated resource group and production Azure Function App. Use a supported Node.js runtime and the deployment model used by this repository.
2. Create the required storage resources for the application data tables and the packaging workflow. Keep packaging quarantine, manifests, queue and artifacts private.
3. Configure Function App settings through Azure configuration or Key Vault references. Never commit credentials or paste them into support tickets.
4. Configure the API base URL in the public site's deployment configuration. Confirm CORS allows only the intended site origins.
5. Configure Application Insights/logging with redaction. Never log access tokens, SAS URLs, API keys, installer bytes or sensitive customer content.
6. Confirm health checks, startup, route registration and storage connectivity in staging before production.
7. Back up data and deployment configuration; document restore procedures and test them.

## 8.6 Transactional email and communications

1. Authenticate the domain with the selected transactional provider and verify the exact sender address.
2. Store the API key only in Function App settings/Key Vault. Rotate any key that has ever been exposed in chat, source control or logs.
3. Configure sender name, sender address and platform notification recipient allowlist.
4. Test a direct transactional send, then test the same send through the deployed Function App. Provider IP authorization may differ between a developer shell and Azure outbound IPs.
5. For every invitation, show whether the invitation record was saved and whether the email provider accepted the message. A provider-accepted message is not proof of inbox delivery.
6. Keep inbound mail marked unavailable until a real inbound provider integration stores messages and exposes a secure webhook. Do not infer receipt from forwarding to Gmail.
7. Maintain sent-message logs with recipient, subject, status, timestamp and sending operator; restrict access to message content and personal data.

## 8.7 Platform Admin Center configuration

1. Configure Super Admin, Catalog Manager and Support Admin allowlists. Verify the role-based tab and API restrictions independently; hiding a button is not authorization.
2. Configure customer request triage and service-level targets.
3. Configure shared catalog review, evidence fields, approval and retirement process.
4. Configure communications templates and notification recipients.
5. Configure website content and public pricing only after product/legal review.
6. Review platform reports and export permissions.
7. Keep financial reporting disabled until a billing provider, verified webhooks, customer mapping and invoice records are implemented.
8. Keep the auto-publish runbook in the Admin Center. Scheduling it requires a dedicated identity, least privilege, monitoring and stop conditions.

## 8.8 Shared application catalog operations

1. Collect candidates only from authoritative vendor sources, official WinGet manifests, verified Microsoft Store listings or approved vendor feeds.
2. Verify product identity, publisher, package ID, version, architecture, language, license and support lifecycle.
3. Verify download URL and hash. A hash proves byte identity, not publisher identity. Verify Authenticode and vendor provenance separately.
4. Record install/uninstall commands, return codes, reboot behavior, install context and detection rules.
5. Test the app in a disposable VM before marking it verified.
6. Record review evidence, operator, date, source revision and approval. Candidate entries remain disabled until approved.
7. Re-review source changes, signing changes, vendor ownership changes and security advisories. Retire unsupported or compromised entries.

## 8.9 Secure packaging worker deployment

1. Provision a dedicated Windows Server 2022/2025 worker VM with current patches and Microsoft Defender Antivirus.
2. Use a dedicated storage account for quarantine, manifests, queue and package artifacts. Keep containers private and apply lifecycle deletion to abandoned uploads.
3. Configure storage CORS for the exact Nexpatch website origin, only required methods (PUT/OPTIONS), required headers and exposed response headers. Do not use wildcard origins in production.
4. Configure Function App settings for storage and the high-entropy worker callback token. Configure matching worker environment variables securely; do not paste tokens into chat.
5. Install the PowerShell modules required by the worker and download Microsoft's official Win32 Content Prep Tool from its official source. Verify its provenance.
6. Configure the worker service identity with minimum required storage permissions. Avoid broad access to customer application storage.
7. Configure the worker polling interval, queue retry/poison-message handling, log retention and health monitoring.
8. Keep Hyper-V testing disabled until a dedicated disposable test VM, checkpoint workflow, network isolation and credentials are configured.
9. Run a harmless, signed test MSI through upload, hash verification, signature check, Defender scan, IntuneWinAppUtil packaging and artifact download.
10. Run install/uninstall tests only in a disposable isolated VM. Record exact test commands, VM snapshot and outcomes.
11. Confirm failed signature, malware scan, hash mismatch and failed test outcomes cannot be marked approved.
12. The current worker release supports one MSI or EXE file up to 2 GB. It does not yet support companion files, transforms, folders, multi-file installers or unsigned-package exceptions.
13. A generated `.intunewin` is not equivalent to approval. Require an explicit approval workflow before catalog publishing or deployment.

## 8.10 Customer onboarding and Intune connection

1. Create a test organization and connect a non-production Intune tenant.
2. Review the exact Graph permission list with a customer Global Administrator/Intune Administrator.
3. Obtain explicit tenant consent and verify the connection with a read-only inventory call first.
4. Import discovered applications and reconcile package IDs carefully; never invent Store IDs or WinGet identifiers.
5. Confirm customer Owner/Admin/Viewer permissions and invitation behavior.
6. Test app publishing with a harmless test application and a pilot group only.
7. Verify the customer can review assignments and results before expanding rings.
8. Keep customer tenant configuration, group identifiers, reports and installer data tenant-scoped.

## 8.11 Deployment, monitoring and rollback

1. Use Pilot → Early Adopters → Broad Deployment where the customer chooses ring deployment.
2. Define maintenance windows, deadlines, restart handling, exclusions and rollback plan before publishing.
3. Monitor Intune job status and device-level install results. Separate Nexpatch publish success from actual device installation success.
4. Pause rollout on elevated failures, security alerts, hash/signature changes or unexpected reboot behavior.
5. Preserve package versions and assignment metadata for rollback. A rollback must itself be approved and audited.
6. Export reports only to authorized operators and avoid exposing unnecessary device/user identifiers.

## 8.12 Billing, invoices and financial controls

1. Select a billing provider and configure a separate test environment before accepting payments.
2. Define plans, device limits, billing intervals, trial rules, taxes, currencies, proration, refunds, credits and cancellation policy.
3. Map provider customer/subscription IDs to Nexpatch organization IDs using immutable references.
4. Verify webhook signatures, event idempotency, replay handling and retry/dead-letter behavior.
5. Store invoice identifiers, status, currency, subtotal, tax, total, due date, paid date, hosted invoice URL and credit/refund links from the provider. Do not synthesize paid status.
6. Restrict payment and invoice operations to finance-authorized platform roles. Keep card data entirely with the payment provider; Nexpatch must not store card numbers or security codes.
7. Build reporting for MRR/ARR, collections, overdue balance, churn, refunds, taxes and invoice aging only from provider-backed records.
8. Reconcile provider statements against Nexpatch records monthly and retain audit evidence.

## 8.13 Release acceptance checklist

- [ ] Authentication, role checks and tenant isolation tested
- [ ] Entra consent and Graph permission matrix reviewed
- [ ] Email invitation accepted by provider and delivery checked
- [ ] Customer upload, quarantine, hash and signature verification tested
- [ ] Defender scan and packaging worker tested on Windows
- [ ] `.intunewin` output verified with official tool
- [ ] Isolated VM install/uninstall test passed
- [ ] Approval gate and customer deployment consent verified
- [ ] Reports reconcile with Intune source data
- [ ] Backups, logs, alerts, incident contacts and rollback tested
- [ ] Legal terms, privacy notice, pricing and data retention reviewed
- [ ] Billing remains disabled until provider and webhook acceptance tests pass

## 8.14 Known release limitations to disclose

The current packaging worker is an implementation foundation, not a production certification. Its Windows scripts require execution on the supported Windows host; no Azure deployment or live end-to-end worker test is implied by source validation. The application does not yet create/assign Intune apps automatically from a packaging job, does not provide automatic remediation execution, and does not have a connected billing provider. The Admin Center's inbound communications view is not a true mailbox while Cloudflare forwarding is the only inbound path. Permission checklists are manual review aids, not live consent telemetry.
