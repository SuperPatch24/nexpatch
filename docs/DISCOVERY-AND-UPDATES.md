# Discovery, update detection, one-click fixes and the summary report

## One setup step: a GitHub token (recommended)

Discovery and version checks read the public WinGet repository on GitHub. Without a token GitHub allows 60 requests
an hour, which is enough for about one check per app per day. With a token it allows 5,000.

1. On GitHub: Settings, Developer settings, Personal access tokens, **Fine-grained tokens**, Generate new token.
   Repository access: **Public repositories (read-only)**. No other permissions. Give it an expiry you will remember.
2. In Azure Cloud Shell (the token is never shown or pasted into chat):

```bash
read -rsp "GitHub token: " GT; echo
az functionapp config appsettings set -g nexpatch-rg -n nexpatch-api-20022 --settings "GITHUB_TOKEN=$GT" --output none
unset GT
```

Or add `GITHUB_TOKEN` in the portal: Function App, Settings, Environment variables, App settings, then Apply.

## WinGet discovery (Admin Center, Shared catalog)

Every three hours the platform reads the apps that trusted vendors publish on WinGet and checks the newest version:

| Check | Why |
| --- | --- |
| Downloads use HTTPS, every download has a SHA-256 hash | WinGet and Intune can verify the file |
| Download comes from the vendor's own website (or the vendor's own GitHub account) | Not a mirror or a third party |
| A whole-device installer that installs silently | Intune can deploy it with no one at the device |
| Publisher, name and licence listed | You know what you are offering customers |

- **Ready**: every check passed. **Needs review**: deployable, but a person should look (usually the download host).
  **Skipped**: Intune can't deploy it as it is (portable or per-user only).
- Nothing is added automatically. Select apps and click **Add selected** (up to 25 at a time). Each app is verified
  again on the server before it is added.
- The vendor list starts with about 60 well-known publishers (names checked against the WinGet repository).
  Add or remove vendors under **Vendors checked**. Each app is rechecked weekly.
- The name used to detect the installed app comes from the manifest's Installed apps name. Check it for apps whose
  name in Windows differs (Edit in the catalog list).

## Update detection

The version watcher now runs every hour. With a `GITHUB_TOKEN` each catalog app is checked about every 4 hours,
without one about once a day. Apps with a new version in the last 7 days show **New** in the Admin Center catalog list.
Customers with auto-publish on get the new version at their next publish run, as before.

## Publish wizard: several deployment types at once

Each assignment now has its own **Deployment** choice:

- **Update only**: installs only on devices that already have the app.
- **Install**: installs on new and existing devices.

If you mix them (for example *Update only, Required, All devices* plus *Install, Available, All staff*), one click
creates two apps in Intune and publishes both: an update-only app and an install app. Exclusions apply to both.
The rings method still uses the single Update only switch.

## One-click fix (Vulnerabilities page) and Update now (Reports)

**Fix now** publishes the newest version as an **update-only, Required** deployment. Because it is update-only,
assigning it to All devices reaches exactly the devices that have the app. You choose:

- Every device that has the app, now (the default for known exploited flaws), with an install deadline, or
- Your rollout rings.

It uses your saved publish settings for that app (notifications, restarts, what to do if the app is running).
The same dialog opens from **Update now** in Reports, Unpatched apps.

## Summary report (Reports, Summary)

One page with compliance, the trend, flaws by severity, what to fix first, the apps furthest behind and publishing
results. **Download report** saves a colored standalone HTML file anyone can open. **Print or save as PDF** opens it
ready to print.
