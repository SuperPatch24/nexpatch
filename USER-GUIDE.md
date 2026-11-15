# NexpatchOnline user guide

## Sign in and connect Intune
1. Sign in with a Microsoft work account.
2. Open **Connect to Intune** and review the requested Graph permissions.
3. Have an administrator grant tenant-wide consent.
4. Sync inventory and review the results before making changes.

## Application catalog
The App Catalog combines WinGet applications and verified Microsoft Store applications in one place. Client organizations receive the shared catalog after tenant activation. For WinGet packages, verify the package identifier, publisher, architecture and installation context. The backend checks current versions against the WinGet community manifest repository when publishing.

## Microsoft Store applications
Use `winget search --source msstore "app name"` on a trusted Windows workstation or search the Microsoft Store to identify the exact listing, publisher and Store Product ID. Ask a NexpatchOnline catalog administrator to verify the entry. Only entries marked Verified show a Deploy action in the client App Catalog. A Package Family Name is not required for the native Intune Microsoft Store app type.

NexpatchOnline uses Intune's native Microsoft Store app type through the Microsoft Graph beta `windowsStoreApp` resource. Test deployment in a pilot tenant before broad rollout because the Graph API is beta. Microsoft manages Store app updates through Intune / Microsoft Store: UWP update behavior depends on Store auto-update policy, while Store Win32 apps need an active Intune assignment for updates and are currently in preview.

See [Microsoft Learn: Add Microsoft Store apps to Intune](https://learn.microsoft.com/en-us/intune/app-management/deployment/add-microsoft-store) and [Microsoft Graph: Create windowsStoreApp](https://learn.microsoft.com/en-us/graph/api/intune-apps-windowsstoreapp-create?view=graph-rest-beta).

## Reports and application discovery
Sync Intune inventory to compare installed applications with the shared catalog. Apps detected in your company but missing from the catalog can be reviewed in Discovery and submitted as application requests. For device-level installation status, run the Intune results script from Reports and import its JSON output. Connected organizations can share that report with NexpatchOnline platform reporting.

## Deployment rings
Use a pilot ring first, then early adopters, then broad deployment. Allow time between rings and review the deployment logs after each rollout.

## App Control base policy
Start in Audit mode on a pilot group. Review events before switching to Enforce. Managed Installer and Intelligent Security Graph options require the corresponding Intune configuration and licensing.

### Path rules
Enter one absolute path per line, such as `C:\Program Files\Contoso\*`. Only allow folders where standard users cannot create or modify files. Do not allow Downloads, Desktop, Temp, AppData, user profiles or other user-writable locations. NexpatchOnline rejects common unsafe path patterns, but administrators must still verify the folder ACLs.

## Enterprise enquiries
Public quote/demo requests are saved in Azure Table Storage (`SalesLeads`) and displayed to platform administrators in **Platform admin → Enterprise enquiries**. Configure Azure Table Storage access before enabling the form on a public site. Add a verified anti-spam challenge and notification workflow before production launch.
