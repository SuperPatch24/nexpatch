# NexpatchOnline — Company IT Administrator Guide

## 1. Your responsibilities

Company IT administrators connect their Microsoft tenant, manage company users, review requests, choose deployment targets and monitor results. Shared catalog curation and platform-wide settings are controlled by NexpatchOnline Platform Administrators.

## 2. Connect Microsoft Intune

1. Sign in with an authorized Microsoft Entra work account.
2. Open **Connect** and confirm the tenant name and tenant ID.
3. Review the permission checklist before requesting consent.
4. Have an authorized tenant administrator review the application identity and requested Microsoft Graph application permissions in Entra.
5. Grant only the permissions needed for the features your organization intends to use.
6. Return to NexpatchOnline and run a read-only inventory sync first.
7. Confirm the expected device and application counts before enabling deployments.

Use `INTUNE-PERMISSIONS-CHECKLIST.md` as a preparation checklist. The live Microsoft consent screen and the exact deployed Graph endpoints are authoritative; do not treat this document as a substitute for reviewing the actual permissions.

## 3. Users and access

Open **Users & Access**. Invite the person's exact Microsoft sign-in email and choose the least-privileged role:

- Viewer: view permitted information and reports.
- Admin: manage operational settings and approved workflows.
- Owner: manage users and organization-level access.

NexpatchOnline sends an invitation notification through its configured transactional email provider. The invitee must sign in using the same Microsoft account/email. First sign-in activates the pending membership. If the invitation email is not delivered, check the sender/provider configuration and ask the invitee to use the exact invited account; do not create duplicate invitations.

Review users periodically and remove access promptly when someone leaves the organization. Keep at least two trusted owners where possible.

## 4. Inventory and discovery

Run an inventory sync after connection. Review sync timestamp, device coverage, discovered applications and publisher/version data. Inventory may be incomplete if devices have not checked in or the tenant consent is missing a read permission. Do not interpret an absent app as proof that it is not installed.

## 5. Application deployment

1. Select a verified catalog entry.
2. Review publisher, version, architecture, install behavior and prerequisites.
3. Choose a small pilot device/user group.
4. Confirm assignments and maintenance window.
5. Monitor publish job and device install status.
6. Expand to early adopters and then broad deployment only after pilot success.

Never deploy to all devices simply to test a new package. Store apps and Win32 apps have different update and assignment behavior; follow the app-specific notes.

## 6. Application requests

Review submitted requests and ask for missing vendor, business justification, architecture or installer details. Uploaded installers are untrusted input. Do not execute them on an administrator workstation. Require scanning, provenance review, signature/hash checks, packaging, isolated testing and approval before catalog publication.

## 7. App Control and Defender

App Control policy changes can block business-critical software. Begin in audit mode, review events, create a tested supplemental policy and pilot before enforcement. Keep a documented recovery policy and emergency contact. Defender integration is optional; request only the specific Defender permissions required by an enabled feature.

## 8. PowerShell remediation

Use only approved, versioned scripts with documented purpose, supported OS/builds, execution context, timeout, exit codes and rollback. Company approval must identify target group and change window. Review per-device outcomes and never run scripts that have not passed security review and lab testing.

## 9. Reports and troubleshooting

Use Reports to inspect deployment jobs, installation outcomes and inventory gaps. Separate a Nexpatch publish failure from an Intune device installation failure. Capture the job ID, tenant, app/version, device, timestamp and sanitized error text for support. Never share access tokens, secrets or private customer data.

## 10. Offboarding and revocation

Before disconnecting the tenant, export required reports and document active assignments. Revoke the NexpatchOnline enterprise application consent in Entra only after understanding that inventory, deployment and reporting features will stop.
