# Permission sets: customers approve only what they use

Microsoft Entra approves **all** of an app registration's permissions in one click, and there is no way to approve
only some of them. So NexpatchOnline uses one app registration per permission set:

| Set | Required? | App registration (env var on the Function App) | Application permissions |
|---|---|---|---|
| Apps and patching | Yes | `CLIENT_ID` (the existing app) | DeviceManagementApps.ReadWrite.All, DeviceManagementManagedDevices.Read.All, DeviceManagementConfiguration.Read.All, Group.Read.All |
| App Control | Only with the App Control add-on | `CLIENT_ID_APPCONTROL` | DeviceManagementConfiguration.ReadWrite.All, ThreatHunting.Read.All, Group.Read.All |
| Automation | Only if they use Automation | `CLIENT_ID_AUTOMATION` | Device.Read.All, GroupMember.ReadWrite.All, DeviceManagementManagedDevices.Read.All, Group.Read.All (and Group.Create to let NexpatchOnline create groups) |

A customer that does not add App Control never sees or approves the App Control permissions. The Connect page shows
each add-on with what Microsoft has actually approved (read from the token's roles), and marks App Control
"Needed for your plan" when the plan, the trial choice or a plan-change request includes it.

If an add-on's env var is not set it falls back to `CLIENT_ID`, so a single-registration setup keeps working
(everything is then approved together). That is fine for your own test tenant.

## One-time setup for each add-on registration (App Control, Automation)
1. Entra admin center > App registrations > New registration. Name `NexpatchOnline App Control` (or `... Automation`).
   Supported account types: **Accounts in any organizational directory (Multitenant)**.
2. Authentication > Add a platform > Web > redirect URI `https://nexpatchonline.com/consent`. Leave implicit grant off.
3. Certificates & secrets > Certificates > upload the **same public certificate** the core app uses (the one in Key Vault).
   No client secret.
4. API permissions > Add a permission > Microsoft Graph > **Application permissions**: add the permissions from the
   table. Do not add anything else. (You can click "Grant admin consent" in your own tenant to test.)
5. Copy the Application (client) ID and save it on the Function App:
   `az functionapp config appsettings set -g nexpatch-rg -n nexpatch-api-20022 --settings CLIENT_ID_APPCONTROL=<id>`
   (and `CLIENT_ID_AUTOMATION=<id>` for Automation).
6. Core: remove ThreatHunting.Read.All and DeviceManagementConfiguration.ReadWrite.All from the core app's permissions
   if they are there, so new customers are not asked for them. Customers who already approved keep what they approved;
   they can remove NexpatchOnline in Enterprise applications and approve again to drop them.

## What customers do
- Everyone: approve **Apps and patching** (the existing Approve button).
- App Control customers: Connect page > Optional add-ons > Approve App Control.
- Automation users: Connect page > Optional add-ons > Approve Automation.

Until an add-on is approved its pages explain what is missing and nothing is read or changed in Microsoft.
