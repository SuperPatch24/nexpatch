# Remediation scripts — implementation status

## Current release behavior

The customer portal reads approved script metadata from the platform remediation library. Script source remains private to platform administrators. The customer-facing endpoint does not execute scripts, create Intune assignments, or retrieve per-device results. A successful HTTP response from the metadata endpoint is not evidence of Intune execution.

The portal now distinguishes an unavailable library from an empty approved library and gives a safe retry path. The API logs the underlying storage failure for operator investigation while returning a non-sensitive message to the customer.

## Required Intune-style capability (not yet implemented)

A production remediation center must use Microsoft Graph deviceManagement device health script APIs and the corresponding device run-state/result APIs. Before enabling it, implement and test:

1. Tenant-admin delegated consent and least-privilege Graph permissions for reading device inventory/groups, creating/updating scripts, assigning scripts, and reading device run states. Verify the exact current permission names against Microsoft Graph documentation before requesting consent.
2. Script authoring/version history, PowerShell 64-bit setting, run-as 32-bit setting, signed-script enforcement, logged-on-user vs SYSTEM context, schedule/frequency, retries, grace period, assignment filters, and pilot/broad rings.
3. Mandatory script review, static safety checks, approval workflow, immutable version/hash, and tenant authorization before assignment.
4. Assignment lifecycle with idempotency, Graph request tracking, retry/backoff, throttling handling, and audit records.
5. Device-level result ingestion: detection output, remediation output, exit codes, execution timestamps, device identity, last check-in, and statuses such as pending, succeeded, not remediated, failed, and unknown.
6. Reporting: success/remediation rate, failures by script/version/device/OS, trend over time, export CSV/XLSX, stale results, and clear distinction between no result and failure.
7. Tenant isolation, role checks, retention limits, sensitive-output redaction, and explicit confirmation before assignment to production groups.

Do not enable an Execute, Assign, or Deploy action until all of the above Graph flows and permission checks are implemented and covered by integration tests against a non-production tenant. Do not fabricate device results or show sample data as live results.
