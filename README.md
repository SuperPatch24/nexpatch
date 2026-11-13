# NexpatchOnline

Third-party patching and App Control for Microsoft Intune.

## Project layout

```
public/                  Website (published by Cloudflare)
  index.html             Introduction page, sign-in and admin console
  config.js              Client ID, sign-in addresses, backend address (public values, no secrets)
  vendor/                Microsoft Authentication Library (MSAL.js 5.26.0, MIT licence)
  _headers               Security headers
api/                     Backend (Azure Functions, Node.js 22)
  src/functions/         tenant, inventory, users, audit, publish (+ queue worker), reports, install-results, appcontrol, timers
  src/lib/               token checks, Table Storage, Microsoft Graph with certificate, Store discovery candidates
wrangler.jsonc           Cloudflare settings (publishes ./public only)
docs/
  AUTO-DEPLOY.md         GitHub Actions deployment and platform administrators
  ENTRA-SETUP.md         App registration and sign-in
  BACKEND-SETUP.md       Azure resources, certificate, deploy, test
  WORKER-PLAN.md         Next phase: packaging worker and version checks
```

## Status

- **Sign-in:** Microsoft Entra ID (MSAL.js) once `public/config.js` has a client ID.
- **Admin approval:** records the organization, then the backend confirms access and activates it.
- **Users and access:** each organization manages its own people with Viewer, Admin and Owner roles, invitations and an activity log.
- **Inventory:** pulled from Intune by the backend on approval, on demand, and nightly.
- **Deployment options:** update-only applicability; assignments to groups (name or ID), All devices or All users,
- **Update-only deployments** are published to Intune as "Update for <app> <version>" (and shown that way in Deployments). The catalog shows when each app was last updated, and the Company profile page shows company name and logo, data location, subscription, and the last and next update sync.
  each with its own intent, include/exclude, filter, start and deadline; optional rollout rings instead;
  hardware, registry and script applicability rules;
  notifications, restart behavior and grace periods; running-app handling (close, warn, wait, retry later);
  dependencies; supersedence (update or replace, plus other apps); pre/post scripts; detection and requirement
  rules; Company Portal settings. Choices are remembered per app.
- **Publish to Intune:** one click on the website. The backend checks winget for the newest version, builds and
  encrypts the package in the cloud, uploads it to Intune, and applies dependencies, supersedence and assignments.
  The PowerShell script remains available as an alternative.
- **App Control live events:** each organization picks Microsoft Defender (advanced hunting) or the NexpatchOnline collector
  (a scheduled script deployed with Intune). Live list with allow publisher, allow file, block and ignore; allow decisions
  produce a downloadable supplemental policy.
- **Group picker:** type a few letters to find Entra groups when assigning.
- **Platform admin:** operators manage a shared app catalog for every organization and see all connected tenants. Microsoft Store entries use the same catalog as WinGet.
- **Automatic deployment:** pushes to GitHub deploy the website (Cloudflare) and the backend (GitHub Actions). See `docs/AUTO-DEPLOY.md`.
- **Free trial:** each organization gets 30 days from connecting; then publishing and sync pause until it's marked as paid in NexpatchOnline admin.
- **Deploy App Control from the website:** build the base policy and push it to Intune, and deploy the supplemental policy from allow decisions, all through Microsoft Graph. No XML download, no reference device. PowerShell remains as an advanced option.
- **App Control section:** Activity, Base policy, Supplemental policy and Reports tabs.
- **Still in the browser:** catalog, rings, deployments, App Control and reports data.


## Deploy

- **Website:** Cloudflare Workers, root `/`, no build command, deploy command `npx wrangler deploy`.
- **Backend:** see `docs/BACKEND-SETUP.md`.


## Commercial and documentation additions

- Public pricing and Enterprise enquiry form are included as a proposal. Prices are not connected to billing or entitlement enforcement.
- Enterprise enquiries are stored in the `SalesLeads` Azure Table and visible to platform administrators. Configure storage permissions and anti-spam controls before public launch.
- Signed-in client IT administrators have a searchable Documentation centre; see `docs/CLIENT-IT-ADMIN-GUIDE.md`. Website operators have a separate Admin Center documentation tab and `docs/ADMIN-CENTER-GUIDE.md`.
- The Admin Center can find an app by name on WinGet and the Microsoft Store, verify it against live manifests, and add it to the shared catalog; platform admins can also add and remove entries and write documentation for admins or customers. Client admins can send outage and maintenance notifications.
- Verified Store entries deploy through Intune's native `windowsStoreApp` Graph beta resource. A PFN is not required for this native Store app type. Store entries are excluded from Nexpatch WinGet auto-publish; updates are managed by Microsoft Store / Intune. Test the beta publishing path in a pilot tenant before production.
- Base-policy path rules are now sent to the backend and embedded in WDAC XML. Only administrator-protected directories should be allowed.

## Client application requests and Admin Center

- Clients can request missing applications, provide an HTTPS vendor/download URL and/or upload an installer (up to 50 MB). Requests are tenant-partitioned and clients can track status and admin notes.
- Installers are stored in a private Azure Blob container and remain marked `pending` for malware/security review. They are not executed automatically. Configure Blob Storage and a malware-scanning workflow before production use; see `docs/BACKEND-SETUP.md`.
- Platform administrators use the separate `/admin/` page for request triage, shared catalog editing, Store candidate verification, graphical metrics, Excel exports, website settings, email settings and internal admin documentation. Add `/admin/` as an Entra SPA redirect URI and configure `PLATFORM_ADMINS` (Super Admin), `PLATFORM_CATALOG_MANAGERS` (catalog-only) and/or `PLATFORM_SUPPORT_ADMINS` (request triage and reports).
- Admin reports include total catalog entries, apps available to deploy, WinGet / Store counts, Store verification backlog, failed update jobs, failed deployment jobs, Intune device install failures imported by client admins, and detected apps missing from the shared catalog.
- Excel export contains Summary, Catalog, Client requests, Organizations, Publishing jobs, Install results, Catalog gaps and a Visual summary worksheet.

## Branding and operator guides

The current brand mark is `public/nexpatch-logo.svg`. Expanded documentation is in `docs/` and mirrored under `public/docs/` for static hosting. The dashboard concept image in `docs/assets/` is illustrative artwork, not a screenshot of production data or a claim that every depicted feature is implemented.

## Current feature boundaries

- User invitations are persisted and email notifications are sent through Brevo when configured. Access activates on first sign-in with the invited Microsoft account.
- The Platform Admin Remediation Scripts area stores draft PowerShell definitions and metadata only. It does not execute scripts or assign them to Intune devices.
- The Intune permissions checklist is a review aid, not a live consent/permission detector. Verify the exact Graph permissions configured for the deployed app registration before requesting tenant consent.
- Driver update visibility and iOS/iPadOS update management are roadmap recommendations, not implemented deployment capabilities in this release.

## Apple inventory and packaging wizard (November 2026)

- Customer console now includes **Apple apps & devices**. It reads iOS/iPadOS managed-device inventory, detected app/version records and iOS/iPadOS app catalog resources from the connected Intune tenant. It offers an Excel executive/device/app workbook and browser Print / Save PDF.
- Apple inventory is currently read-only. It does not assign apps, force app updates, manage Apps and Books licenses, or determine that an app is outdated without a trusted latest-version source.
- **Application packaging wizard** captures Windows app intake metadata and saves tenant-scoped packaging drafts. It is not yet an installer upload, malware scan, signature verification, Win32 Content Prep Tool conversion, install test or Intune publishing pipeline.
- See `docs/IOS-IPADOS-APP-MANAGEMENT-GUIDE.md` and `docs/APPLICATION-PACKAGING-WIZARD-GUIDE.md` for current boundaries and the next infrastructure requirements.


## Secure Windows packaging worker

The MSI/EXE packaging wizard now has a private quarantine upload and queue-backed worker workflow. See [Secure Windows Packaging Worker](docs/SECURE-WINDOWS-PACKAGING-WORKER.md) for Azure storage configuration, worker prerequisites, Defender scanning, Microsoft Win32 Content Prep Tool setup, optional isolated Hyper-V testing, deployment order and current limitations. The worker must be deployed separately; API deployment alone does not enable packaging.
