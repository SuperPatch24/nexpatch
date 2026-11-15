# Admin Center: Organizations

Superadmin only. Lists every connected organization with its plan, usage and access status.

## Revoke access when a subscription is done
- **Revoke access**: nobody in the organization can use NexpatchOnline; nightly syncs stop. Data is kept. Takes effect within about 30 seconds.
- **Suspend**: read-only. People can view but nothing can be changed.
- **Restore access**: puts everything back.
- Use the filter "Subscription ended, still active" to find organizations whose paid-until date has passed or whose trial/plan expired. Nothing is revoked automatically.
- You cannot revoke or suspend your own organization.
- Revoking does not remove the NexpatchOnline enterprise application from the customer's Entra ID.

## Per-organization settings
Display name, billing contact, paid-until date, allowed invitation email domains (invitations to other domains are refused), limit overrides (devices, custom app builds and package requests per month; blank uses the plan limit), and feature switches: packaging and publishing, App Control, nightly inventory sync, device reports.

Paid-until is informational and drives the "Subscription ended" flag. Device-count overrides are shown but, like plan device limits, are not enforced by blocking.
