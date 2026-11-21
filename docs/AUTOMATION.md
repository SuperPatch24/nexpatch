# Automation and plan changes

## Automation rules (Automation page)
A rule adds devices to an Entra security group a set time after they enroll. It runs on a timer every 15 minutes
and only acts when the rule's own "check every" interval has passed.

Why not an Entra dynamic group: dynamic rules can't wait "2 hours after enrollment", so NexpatchOnline keeps an
ordinary assigned security group up to date instead. Devices are only added, never removed.

Safety defaults
- New rules only look at devices that enroll after the rule was created ("Which devices" can be changed).
- A rule adds at most 200 devices per run; the rest follow on the next run.
- Dynamic groups, Microsoft 365 groups, on-premises synced groups and role-assignable groups are refused.
- Up to 10 rules per organization. Preview shows who would be added without changing anything.
- The platform operator can turn Automation off per organization (Admin Center, features).

## Permissions
Automation has its own permission set and app registration (`CLIENT_ID_AUTOMATION`): Device.Read.All,
GroupMember.ReadWrite.All, and Group.Create only if NexpatchOnline should create groups. Customers approve it
separately under Connect > Optional add-ons. See PERMISSION-SETS.md for the setup.

## Plan changes
A company admin chooses Company profile > Change plan. This stores a request on the organization, emails the
platform admins (Brevo) and shows "Asked for ..." in the Admin Center organizations table. The operator opens
"Set paid plan", which is pre-filled with the request, and saves; that activates the plan and clears the request.
No payment is taken by the platform: billing stays outside NexpatchOnline until a payment provider is added.

Storage: two new tables (AutomationRules, AutomationDone) are created automatically on first use.
