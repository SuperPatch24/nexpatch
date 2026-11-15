# How to confirm this build is the one you deployed
This is a complete copy of the site. Do not unzip it over older updates; replace everything.
On the live site (hard refresh, Ctrl+F5):
- Landing page: "Works with" shows only Microsoft Entra ID, Microsoft Intune, Microsoft Defender; a features slideshow with six tabs; the logo is a package with a green update arrow.
- Sign in, then Apps > Discovery: there is no "Find winget packages for unmatched apps" panel.
- Left menu: Apps, App Control, Organization and Resources have chevrons and collapse.
- A "Device insights" link exists; App reports has tabs Apps, App updates, Unpatched apps, Microsoft 365 apps, iOS apps (no device reports).
- Users: Admin and Viewer roles plus "Add Entra group".
- Admin center > Organizations: Revoke, Suspend, Settings per organization.
If a heading is missing, the old files are still being served (Static Web Apps cache or wrong folder).
