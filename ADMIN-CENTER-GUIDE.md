# NexpatchOnline Admin Center guide

This is internal documentation for NexpatchOnline website operators. It is separate from the customer-facing Client IT Administrator documentation.

## Access and roles

The Admin Center is hosted at `/admin/` and uses the platform administrator allowlists:

- `PLATFORM_ADMINS`: Super Admin
- `PLATFORM_CATALOG_MANAGERS`: Catalog Manager
- `PLATFORM_SUPPORT_ADMINS`: Support Admin

Super Admins manage the entire platform. Catalog Managers manage shared catalog entries. Support Admins review client requests and platform reports. Keep these allowlists limited to named operator accounts.

## Microsoft Store catalog candidates

The **Add 250 Store candidates** action imports a curated discovery queue into the existing shared App Catalog. It is not a verified popularity ranking, and it does not assert that every candidate is currently available in every Store region.

For each candidate:

1. Search the Microsoft Store and/or run `winget search --source msstore "app name"` on a trusted Windows workstation.
2. Verify the exact app title, publisher and Store Product ID.
3. Enter the Product ID and Microsoft Store URL in the catalog editor.
4. Tick the verification checkbox only after checking the source.
5. Save and confirm the entry is shown as Verified / deployable.

A native Intune Microsoft Store app does not require a Package Family Name. Do not invent PFNs. A Store candidate without a verified Product ID remains visible in the same customer App Catalog but cannot be deployed.

Store deployment uses the Microsoft Graph beta `windowsStoreApp` resource. Microsoft documents this API as beta, so validate in a test tenant before production use. Store app updates are handled by Microsoft Store / Intune rather than Nexpatch WinGet auto-publish. Microsoft notes that Store Win32 apps are currently in preview; UWP update behavior depends on Store auto-update policy.

## Platform reports

The Reports & exports tab includes:

- Total and enabled shared catalog entries.
- WinGet and Microsoft Store catalog counts.
- Verified Store entries and candidates awaiting verification.
- Failed Nexpatch update jobs and failed deployment jobs.
- Intune device install failures imported by connected client administrators.
- Apps found in tenant inventories but not in the shared catalog.
- Organization, request and request-status counts.

### Metric definitions

- **Total catalog entries** includes disabled rows and unverified Store candidates; **apps available to deploy** includes only enabled entries with a usable WinGet ID or a verified Store Product ID.\n- **Update failures**: failed Nexpatch publish jobs whose request was classified as update-only.
- **Deployment failures**: failed Nexpatch publish jobs not classified as update-only.
- **Intune install failures**: device-level failures from the most recently imported Intune install-status report per app and tenant.
- **Catalog gaps**: unique discovered app names that do not match a shared catalog name or installed-app alias. Review suggestions before adding them.

The Excel workbook contains Summary, Catalog, Client requests, Organizations, Publishing jobs, Install results and Catalog gaps worksheets. The Admin Center also renders graphical bar reports.

## Client application requests

Review installer uploads and vendor links in Client requests. Never execute uploaded files. Use an approved malware scanning and package validation process. Record scan status and admin notes, and move requests through review, packaging, testing, approval and publication.

## Website and email settings

Website settings edit supported public text fields; they are not an unrestricted source-code editor. Brevo credentials must remain in Azure Function App settings or Key Vault. Never put secrets in browser code, page content or this guide.

## Operational safety

Catalog edits are shared with every connected client organization. Verify package identifiers, publishers, Store region availability and update behavior before enabling deployment. Do not automatically add catalog-gap suggestions without review.
