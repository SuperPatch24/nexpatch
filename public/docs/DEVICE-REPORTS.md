# Device reports and Patch Tuesday compliance

Open **Reports** in the portal. Device data is collected from Intune on every inventory sync (nightly at 07:00 UTC, or **Sync now** on the Connect page). Until the first sync after you update, the device reports are empty.

## Permission
Uses `DeviceManagementManagedDevices.Read.All`, which is already on the Connect page. If an organization approved NexpatchOnline before this permission was listed, an admin must approve again.

## Reports (CSV per report, or one Excel workbook)
Hardware and storage, Low storage (under 15% free or under 20 GB), Low memory (under 8 GB), No recent check-in (30+ days), Windows versions, Compliance and encryption, Microsoft 365 Apps by device, Microsoft 365 Apps versions.

## Monthly Patch Tuesday compliance
Each report runs from one Patch Tuesday (second Tuesday) to the next. A device is **compliant** when its Windows build moved forward during the cycle, or it joined during the cycle already on the newest build in your fleet. The newest build is measured against your own fleet, not against Microsoft's catalog. History begins at the first device sync, so the first cycle can look partial. Each sync updates the current cycle; the last sync before the next Patch Tuesday is what stays as that month's report (summary plus up to 120 non-compliant devices).

## Limits
Microsoft 365 Apps status is relative to the newest version in your fleet and does not identify update channels. Windows 11 readiness (TPM, CPU) is not reported.
