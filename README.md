# Nexpatch

Third-party patching and App Control for Microsoft Intune.

This is the **front-end prototype**: a single self-contained page (`index.html`) with
the introduction page, sign-in screen and admin console (overview, app catalog,
discovery, deployments, reports, App Control and Connect).

## Status

- Sign-in is **simulated**. Real sign-in needs Microsoft Entra ID (MSAL.js) and a backend.
- Data is stored in the browser (`localStorage`) and starts with sample data.
- Intune work is done by the PowerShell scripts the console generates. Run them on a
  Windows packaging machine.

## Run locally

Open `index.html` in a browser, or serve the folder:

```bash
npx serve .
```

## Deploy

- **Cloudflare Pages:** connect this repository, leave the build command empty,
  and set the output directory to `/`.
- **GitHub Pages:** Settings → Pages → deploy from the `main` branch, root folder.
  (On a free GitHub plan, Pages only works for public repositories.)

## Next steps

1. Multi-tenant Entra app registration and admin consent flow
2. Backend API (Azure Functions) with per-tenant data storage
3. Windows packaging worker and daily version checks
4. Replace browser storage and copy-paste scripts with API calls
