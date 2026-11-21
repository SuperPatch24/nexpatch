# Company access (Admin Center)

Admin Center > **Company access** lists every connected company with one switch per product or function:
Apps and patching, App Control, Automation, Device reports, Packaging and publishing, Nightly sync.

- Revoke takes effect within about 30 seconds: the company's menu entries disappear, its actions return a clear
  "turned off for your organization" message, and background jobs (nightly sync, App Control polling, automation
  rules) skip it. Nothing is deleted; granting again restores everything.
- Everything is granted by default, so existing companies keep working. Only switches you change are stored.
- Activating a paid plan with the App Control add-on grants App Control automatically.
- Every change is written to that company's audit log with who made it.
- **Check permissions** asks Microsoft which permission sets the company has approved (apps and patching,
  App Control, Automation). Granting access here does not approve anything in the company's Microsoft tenant;
  the company approves those itself on its Connect page. See PERMISSION-SETS.md.
- Only super admins can change access; super admins and support admins can check permissions.
- To stop a company entirely (nobody can sign in) or make it read-only, use Revoke or Suspend on the Organizations tab.
- Fixed: saving the Organizations settings dialog no longer switches back on a product you had turned off from here.
