# Device insights, device reports and Patch Tuesday compliance

Open **Device insights** in the portal. Device data is collected from Intune on every inventory sync (nightly at 07:00 UTC, or **Sync now** on the Connect page). Until the first sync after you update, these pages are empty.

## Permission
Uses `DeviceManagementManagedDevices.Read.All`, already on the Connect page. If an organization approved NexpatchOnline before this permission was listed, an admin must approve again.

## Device insights
Managed Windows devices, compliance, Windows versions, last contact (today, 1 to 7 days, 8 to 30 days, over 30 days, never), performance (memory and free disk space), disk size, models, users with devices, encryption and ownership, and enrolment by month.

## Device reports (CSV per report, or one Excel workbook)
Hardware and storage, Low storage (under 15% free or under 20 GB), Low memory (under 8 GB), No recent check-in (30+ days), Windows versions, Compliance and encryption, Microsoft 365 Apps by device, Microsoft 365 Apps versions.

## Monthly Patch Tuesday compliance
Each report runs from one Patch Tuesday (second Tuesday) to the next. A device is **compliant** when its Windows build moved forward during the cycle, or it joined during the cycle already on the newest build in your fleet. "Newest" is measured against your own fleet, not Microsoft's catalog. History begins at the first device sync, so the first cycle can look partial. Each sync updates the current cycle; the last sync before the next Patch Tuesday is what stays as that month's report (summary plus up to 120 non-compliant devices).

## App reports
App reports are for apps only: Apps, App updates, Unpatched apps, Microsoft 365 Apps and iOS apps. Device information lives in Device insights.

## Limits
Microsoft 365 Apps status is relative to the newest version in your fleet and does not identify update channels. Windows 11 readiness (TPM, CPU) is not reported.
