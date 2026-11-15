# Roles and access

Everyone signs in with their own Microsoft work account. Open **Organization > Users and access**.

## Roles
- **Admin** manages everything on the console: publishing apps, syncing inventory, App Control, notifications, settings, and who has access.
- **Viewer** can see settings, reports, activity and who has access, but cannot take any action. Action buttons are hidden for viewers and the server refuses their requests.

Global Administrators and Intune Administrators in Entra ID always have admin access, so an organization cannot lock itself out. People who were Owners before this change keep full access and are shown as Admin.

## Give an Entra group access
1. Open Users and access and find **Give an Entra group access**.
2. Search for the group, choose a role (Viewer or Admin) and select **Give access**.
3. Everyone in the group, including people in nested groups, gets that role at their next sign-in. Adding or removing people in Entra ID changes their access without any change in NexpatchOnline; allow up to five minutes.
4. If a person has a role of their own and one from a group, they get the higher one. Removing the group removes only the group's access.

Group lookups use the `Group.Read.All` permission already approved for NexpatchOnline. If a lookup fails, sign-in still works with the person's own role.

## Suspended and revoked organizations
Suspended: people can sign in and view data but cannot change anything. Revoked: nobody can use NexpatchOnline. Both are set by NexpatchOnline staff in the Admin Center.
