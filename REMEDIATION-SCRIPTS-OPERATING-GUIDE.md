# Remediation Scripts — operating model

## Purpose

The Remediation Scripts area is intended to become a governed library for Windows PowerShell health checks and fixes. The current release stores script definitions and review metadata only; it does **not** execute or assign scripts to customer devices.

## Required lifecycle

1. Draft: author records the problem, supported OS/builds, prerequisites, expected duration and rollback.
2. Static review: inspect commands, network destinations, registry/service/file changes, privilege requirements and sensitive data handling.
3. Security review: scan the source, record SHA-256, inspect Authenticode signature and validate provenance.
4. Lab test: run on disposable test VMs for success, failure, non-admin context, reboot behavior and idempotency.
5. Approval: a second authorized platform reviewer approves an immutable version.
6. Customer approval: company admin chooses the target group, maintenance window and execution context.
7. Pilot: deploy to a small test group and inspect per-device exit codes and output.
8. Broad rollout: expand only after the pilot meets success criteria.
9. Reporting: retain assignment ID, script version/hash, device, start/end time, exit code, sanitized output and initiating admin.

## Library fields

Each script should include name, purpose, category, supported OS, minimum build, source/vendor, version, SHA-256, signature status, risk classification, required context, detection logic, remediation logic, expected exit codes, reboot behavior, timeout, rollback, approval state and change history.

## Reporting

Report total targeted devices, succeeded, failed, pending, not applicable, timed out, reboot required and unknown. Filter by tenant, script/version, assignment, device group, date and result. Never expose one customer's device output to another tenant. Sanitize secrets and personal data from output.

## Safety

Never run unreviewed customer-uploaded scripts. Do not allow scripts to self-elevate, disable security controls, exfiltrate secrets or silently change tenant-wide settings. Store script content and logs privately. Require explicit customer approval for each assignment. Provide pause/stop and rollback procedures before production execution is enabled.
