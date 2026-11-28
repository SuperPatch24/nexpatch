# Vulnerabilities (CVE) view

Shows customers which app versions installed on their devices have known security flaws, using the U.S. National Vulnerability Database (NVD). Flaws that CISA lists as actively exploited are flagged and sorted first.

## How it works

1. Each catalog app can be linked to its NVD product (a CPE such as `cpe:2.3:a:google:chrome`).
2. A timer (`cveSync`, every hour at :40) downloads the flaws for linked products into the blob container `nexpatch-cve-cache`. Each product is refreshed once a day. It downloads only changes for 7 days, then does a full download again.
3. `GET /api/reports/vulnerabilities` compares each tenant's Intune inventory with the affected version ranges and returns the exposures, a summary and the apps that aren't checked yet. The summary is also saved on the tenant row, which the partner Customers view uses.

## One-time setup

- **Nothing is required.** The function uses the storage account it already has.
- **Optional, recommended:** request a free NVD API key at https://nvd.nist.gov/developers/request-an-api-key. Without a key, NVD allows about 5 requests per 30 seconds. A key makes downloads about 8 times faster. Add it in Cloud Shell without pasting it into chat:

```bash
read -rsp "NVD API key: " NVD && echo
az functionapp config appsettings set -g nexpatch-rg -n nexpatch-api-20022 --settings NVD_API_KEY="$NVD" >/dev/null && unset NVD && echo saved
```

## Linking catalog apps (Admin Center)

1. Admin Center, Catalog, edit an app.
2. Next to **NVD product (CPE)**, click **Find**. It searches NVD by the app name. Pick the right vendor and product from the list. Never type a CPE from memory.
3. Save. Under **Vulnerability data**, click **Download now** for that app, or wait for the next hourly run.

Apps without a link appear to customers under "Installed apps not checked yet".

## Limits

- Only catalog apps with a CPE link are checked.
- NVD sometimes lists affected versions loosely. Treat results as a strong guide, not a full audit.
