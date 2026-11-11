# NexpatchOnline user guide

## Sign in and connect Intune
1. Sign in with a Microsoft work account.
2. Open **Connect to Intune** and review the requested Graph permissions.
3. Have an administrator grant tenant-wide consent.
4. Sync inventory and review the results before making changes.

## Application catalog
The current built-in catalog contains 19 sample entries. The platform administrator can import the 19 seeded applications plus 37 additional discovery matches into the shared catalog (56 unique WinGet package IDs). Client organizations receive the shared catalog after tenant activation.

For WinGet packages, verify the package identifier, publisher, architecture and installation context. The backend checks current versions against the WinGet community manifest repository when publishing.

## Microsoft Store source entries
Use `winget search --source msstore "app name"` to identify a Store product ID. Install the app on a test device and retrieve its package family name with `Get-AppxPackage`. Import a JSON array containing `name`, `id`, `packageFamily`, and optional `publisher` and `reg` fields. Store entries are not eligible for NexpatchOnline auto-publish. The current Store-source flow is an initial install/update path, not a substitute for the native Intune Microsoft Store app type. Validate Store app update behaviour in a test tenant before production.

Microsoft documents that apps deployed as Microsoft Store apps through Intune are automatically kept up to date. Store Win32 and UWP apps have different requirements and behaviours; see [Microsoft Learn: Add Microsoft Store apps to Intune](https://learn.microsoft.com/en-us/intune/app-management/deployment/add-microsoft-store).

## Deployment rings
Use a pilot ring first, then early adopters, then broad deployment. Allow time between rings and review the deployment logs after each rollout.

## App Control base policy
Start in Audit mode on a pilot group. Review events before switching to Enforce. Managed Installer and Intelligent Security Graph options require the corresponding Intune configuration and licensing.

### Path rules
Enter one absolute path per line, such as `C:\Program Files\Contoso\*`. Only allow folders where standard users cannot create or modify files. Do not allow Downloads, Desktop, Temp, AppData, user profiles or other user-writable locations. NexpatchOnline rejects common unsafe path patterns, but administrators must still verify the folder ACLs.

## Enterprise enquiries
Public quote/demo requests are saved in Azure Table Storage (`SalesLeads`) and displayed to platform administrators in **Platform admin → Enterprise enquiries**. Configure Azure Table Storage access before enabling the form on a public site. Add a verified anti-spam challenge and notification workflow before production launch.
