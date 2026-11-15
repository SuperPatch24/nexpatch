# Next: packaging worker and daily version checks

Goal: replace the PowerShell scripts admins run by hand with server-side automation.

## Pieces

1. **Version checker (Azure Function, timer, every 6 hours)**
   Reads the public winget package repository (`microsoft/winget-pkgs` on GitHub) for every app
   in any client's catalog and records the newest version in a `Versions` table.
   New version found → adds a message to a `package-jobs` Storage queue. No Windows needed.

2. **Packaging worker (Windows)**
   A small Windows VM (or your own PC at first) runs a PowerShell loop that:
   - takes a job from `package-jobs`
   - downloads the installer once and checks its SHA256 against the winget manifest
   - scans it with Microsoft Defender
   - builds the `.intunewin` package (same wrapper, detection and requirement scripts as today)
   - uploads it to Blob Storage and records it in a `Packages` table
   - adds one `publish-jobs` message per client that manages that app

3. **Publisher (same worker)**
   For each `publish-jobs` message it signs in to that client's tenant with the Key Vault certificate,
   creates the Win32 app, sets supersedence and assigns the client's rings
   (the existing `Publish-NexpatchOnlineApp` logic, switched to certificate sign-in).

4. **Website changes**
   Catalog, auto-publish and ring settings move from the browser to the backend
   (`/api/catalog`, `/api/settings`), and Deployments reads real publish history.

## Order

1. Move catalog and ring settings to the backend (needed by everything else).
2. Version checker.
3. Worker: packaging only, test with 2–3 apps.
4. Worker: publishing to one test tenant, then a second tenant.
5. Install results sync (nightly, like inventory).
