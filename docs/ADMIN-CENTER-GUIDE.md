# NexpatchOnline Admin Center guide

This is internal documentation for NexpatchOnline website operators. It is separate from the customer-facing Client IT Administrator documentation.

## Access and roles

The Admin Center is hosted at `/admin/` and uses the platform administrator allowlists:

- `PLATFORM_ADMINS`: Super Admin
- `PLATFORM_CATALOG_MANAGERS`: Catalog Manager
- `PLATFORM_SUPPORT_ADMINS`: Support Admin

Super Admins manage the entire platform. Catalog Managers manage shared catalog entries. Support Admins review client requests and platform reports. Keep these allowlists limited to named operator accounts.

## Adding apps to the catalog

Open **Catalog** and use **Find and add an app**. Type the app name; NexpatchOnline searches WinGet and the Microsoft Store and verifies every match (the ID exists, the manifest matches, the publisher is present, the installer or Store page is reachable). Only verified matches can be added, and the server verifies again when you add. You can also add, edit or remove entries by hand, and **Remove unverified Store apps** clears any old unverified Store entries.

WinGet name search needs a read-only `GITHUB_TOKEN` app setting (GitHub only allows code search when signed in). Store search works without it. Nothing is added from memory or guessed: every ID comes from a manifest fetched at that moment.

## Notifications, documentation and email

- **Customer notifications:** client admins get a Notifications page for outage, degraded-service and maintenance notices (email, portal banner, downloadable Windows toast script).
- **Guides:** on the Admin documentation tab, use **Add or edit a guide** to write guides for platform admins or for customers. Customer guides appear in the portal's Documentation page.
- **Communications Center:** templates, audiences, CC/BCC, reply-to, scheduling, preview and email branding.

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

## Vendors and version checks

- **Browse a vendor:** in Catalog, type a vendor such as Microsoft or Oracle to list every package that vendor has on WinGet. Add apps one at a time, or add the shown apps (up to 25 at once). Each is verified when added; ones that fail are skipped. Check a vendor's license terms before offering an app to customers.
- **Version checks:** every catalog app is checked against its vendor source about once a day. Choose the source per app in the catalog form: automatic (WinGet or Microsoft Store), GitHub releases (`owner/name`), or any public RSS/Atom feed (optionally with a pattern that picks the version out of the newest entry's title). **Check versions now** runs a batch immediately, and **New versions detected** lists what changed in the last 45 days.
- Detection only records versions. Nothing is downloaded, packaged or published automatically: WinGet apps are built at publish time from the latest version, so customers with auto-publish on get the new version at their next run.
