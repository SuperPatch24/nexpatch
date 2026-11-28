# IT partners (MSP multi-tenant view)

Lets a managed service provider (MSP) look after many customer organizations from its own NexpatchOnline sign-in.

## For the partner

1. Connect your own organization as usual.
2. Open **Organization, Customers**. Under **Add a customer**, create a code (owners only). Send it to the customer. Each code works once, for 7 days.
3. When the customer accepts, they appear in **Your customers** with devices, vulnerabilities, device agent health, publishing results and last sync. Customers that need attention come first.
4. Click **Open** to work in that customer. A blue banner shows whose organization you're in. **Back to my organization** returns you.

## For the customer

1. Connect your organization to Intune (once).
2. Open **Company profile, IT partners**, enter the code and choose the access:
   - **View only**: reports only.
   - **Manage**: deploy and update apps, App Control and automation.
3. You can change the access or remove the partner at any time. Removal takes effect on the partner's next request.

## Safety rules (enforced on the server)

- The partner's role in a customer is the lower of their role at home and the access the customer granted. A customer can't grant owner.
- Partners can never manage the customer's users, company profile, billing, plan requests, terms, session policy or tenant activation. These routes refuse the `x-nexpatch-context` header.
- Every request is checked against an active link. A suspended customer is read-only and a revoked customer is blocked.
- Codes are stored only as a SHA-256 hash and marked used once accepted. Both organizations get an audit entry.

## Storage

New tables (created automatically): `PartnerLinks` (partner to customer), `PartnerOf` (customer to partner), `PartnerInvites`.
