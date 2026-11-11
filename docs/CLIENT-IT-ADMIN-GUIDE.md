# NexpatchOnline Client IT Administrator guide

This guide is for IT administrators using NexpatchOnline within their own organization. It is separate from the internal NexpatchOnline website Admin Center guide.

## App Catalog

The App Catalog combines WinGet applications and verified Microsoft Store applications in one place. Use search and filters to find an application. Microsoft Store candidates that have not yet been verified by NexpatchOnline are visible but cannot be deployed.

For a Microsoft Store app, use the **Deploy** action only when the entry is marked Verified. Choose a pilot group first, then expand deployment after validating installation. Store apps are created as native Microsoft Store app types in Intune. A Package Family Name is not required for this native Store deployment path.

Microsoft documents Store app updates as managed by Microsoft Store / Intune. UWP app updates can be affected by Store auto-update policy. Store Win32 apps currently have preview limitations and require an active Intune assignment for updates.

## Discover applications missing from NexpatchOnline

Sync Intune inventory from the Connect page. The Discovery view shows apps detected in your company that are not currently matched to the Nexpatch catalog. Review the app name, publisher, device count and versions. You can request that NexpatchOnline add an app using Request an application.

## Request a new application

Use Request an application when an app is missing. Provide the application name, publisher, vendor website, download URL or installer file, version, architecture and additional requirements. Track the request status in the portal. Uploaded installers are stored for review and are not automatically executed.

## Deployments and reports

Use Deployments to monitor Nexpatch publish jobs. For device-level installation results, use Reports → Get results script, run it with the required Microsoft Graph read permission, and import the JSON output. When your organization is connected, the imported results are also shared with NexpatchOnline platform reporting.

## Permissions and security

Only an Entra / Intune administrator should approve tenant-wide consent. Use least-privileged roles and dedicated pilot groups. Do not share credentials, access tokens, installer secrets or customer data in support requests.
