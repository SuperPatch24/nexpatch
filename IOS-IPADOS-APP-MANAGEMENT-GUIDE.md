# iOS and iPadOS App Management

## Scope in this release

NexpatchOnline adds an Apple fleet view backed by the connected organization's Microsoft Intune tenant. The initial implementation reads managed-device inventory, detected iOS/iPadOS applications and the Intune mobile-app catalog, then stores a tenant-scoped snapshot for reporting.

## Setup

1. Connect the organization to NexpatchOnline and complete Microsoft Entra admin consent.
2. Ensure the app registration has the Microsoft Graph application permissions required by the deployed endpoints. At minimum, review read access to Intune managed devices, detected applications and mobile apps. Grant only permissions required by enabled features.
3. Confirm the organization has an active Intune tenant and Apple Push Notification service (APNs) configured for Apple device management.
4. Use **Apple apps & devices → Sync Apple inventory**.

## What the view shows

- Managed iOS/iPadOS devices, model, OS version, serial number, ownership, compliance, primary user and last check-in.
- Detected app/version records and device counts returned by Intune.
- Intune mobile app catalog records where the Graph resource identifies an iOS/iPadOS app type.
- Excel export with an executive summary, Apple Devices sheet and Detected Apps sheet.
- Browser Print / Save PDF for a printable fleet snapshot.

## Important limitations

- A detected app version is an observation, not proof that the app is outdated. Nexpatch does not infer the latest App Store version or compatibility from a version string.
- The initial Apple view is inventory and reporting, not app assignment or update execution. Administrators continue to approve and deploy through Intune.
- Apple Business Manager Apps and Books license reconciliation is not implemented in this phase.
- The Graph API's returned data depends on tenant permissions, enrollment state, Intune licensing and the endpoint's current schema. Empty data is not proof that no Apple devices or apps exist.
- The first sync uses broad Intune inventory endpoints and may take time in large tenants. Review Graph throttling and application permissions before enabling at scale.
