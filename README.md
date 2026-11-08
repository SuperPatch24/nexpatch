# Nexpatch

Third-party patching and App Control for Microsoft Intune.

## Project layout

```
public/                  Website (published by Cloudflare)
  index.html             Introduction page, sign-in and admin console
  config.js              Client ID, sign-in addresses, backend address (public values, no secrets)
  vendor/                Microsoft Authentication Library (MSAL.js 5.26.0, MIT licence)
  _headers               Security headers
api/                     Backend (Azure Functions, Node.js 22)
  src/functions/         me, tenant/activate, inventory, users, audit, publish (+ queue worker), appcontrol, timers
  src/lib/               token checks, Table Storage, Microsoft Graph with certificate
wrangler.jsonc           Cloudflare settings (publishes ./public only)
docs/
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
  each with its own intent, include/exclude, filter, start and deadline; optional rollout rings instead;
  hardware, registry and script applicability rules;
  notifications, restart behavior and grace periods; running-app handling (close, warn, wait, retry later);
  dependencies; supersedence (update or replace, plus other apps); pre/post scripts; detection and requirement
  rules; Company Portal settings. Choices are remembered per app.
- **Publish to Intune:** one click on the website. The backend checks winget for the newest version, builds and
  encrypts the package in the cloud, uploads it to Intune, and applies dependencies, supersedence and assignments.
  The PowerShell script remains available as an alternative.
- **App Control live events:** each organization picks Microsoft Defender (advanced hunting) or the Nexpatch collector
  (a scheduled script deployed with Intune). Live list with allow publisher, allow file, block and ignore; allow decisions
  produce a downloadable supplemental policy.
- **Still in the browser:** catalog, rings, deployments, App Control and reports data.


## Deploy

- **Website:** Cloudflare Workers, root `/`, no build command, deploy command `npx wrangler deploy`.
- **Backend:** see `docs/BACKEND-SETUP.md`.
