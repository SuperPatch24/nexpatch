# Set up Microsoft sign-in for NexpatchOnline

Do this once, in **your own** Microsoft Entra tenant (the tenant that owns NexpatchOnline).
Replace `https://nexpatchonline.com` with your address if it changes.

## 1. Register the app

1. Go to **Microsoft Entra admin center → Identity → Applications → App registrations → New registration**.
2. **Name:** `NexpatchOnline`
3. **Supported account types:** *Accounts in any organizational directory (Any Microsoft Entra ID tenant – Multitenant)*
4. **Redirect URI:** platform **Single-page application (SPA)**, value
   `https://nexpatchonline.com/` (with the trailing slash)
5. Click **Register**, then copy the **Application (client) ID**.

## 2. Add the approval (admin consent) address

1. In the app, open **Authentication → Add a platform → Web**.
2. Redirect URI: `https://nexpatchonline.com/consent`
3. Leave **Access tokens** and **ID tokens** (implicit grant) **unchecked**. Save.

## 3. Permissions

Open **API permissions**.

- Keep **Microsoft Graph → Delegated → User.Read** (added by default). This is all sign-in needs.
- For the coming backend, add **Microsoft Graph → Application** permissions:
  - `DeviceManagementApps.ReadWrite.All`
  - `DeviceManagementConfiguration.ReadWrite.All`
  - `DeviceManagementManagedDevices.Read.All`
  - `Group.Read.All`

  Add these now in your test tenant so you can test approval end to end.
  Before inviting real clients, review the list: clients see every permission on the approval screen.

Do **not** create a client secret for the website. The site never needs one.

## 4. Put the client ID in the site

1. Open `public/config.js` and paste the client ID into `clientId`.
2. Commit and push. Cloudflare redeploys automatically.

## 5. Cloudflare build settings (Workers)

| Setting | Value |
|---|---|
| Root directory | `/` |
| Build command | *(empty)* |
| Deploy command | `npx wrangler deploy` |

`wrangler.jsonc` publishes only the `public` folder.

## 6. Connect the backend

When you deploy the backend, follow `BACKEND-SETUP.md` step 1 to expose the `access_as_user` scope and add the certificate.

## 7. Test checklist

- [ ] **Sign in:** *Sign in with Microsoft* opens Microsoft's page and returns to Overview with your name and initials.
- [ ] **Work email:** typing your email and pressing *Continue* pre-fills it on Microsoft's page.
- [ ] **Approval:** *Connect to Intune → Approve for my organization* shows Microsoft's consent screen, then returns with **Approved** and your tenant ID filled in.
- [ ] **Entra check:** your tenant now lists *NexpatchOnline* under **Enterprise applications**.
- [ ] **Sign out:** returns through Microsoft's sign-out page to the home page.
- [ ] **Sample data:** *Explore with sample data* still works without signing in.
- [ ] **Second tenant:** sign in from a different trial tenant to confirm the app works across organizations.

## Troubleshooting

| Message | Fix |
|---|---|
| `AADSTS50011` redirect URI mismatch | The address in Entra must match exactly, including `https` and the trailing `/`. |
| `AADSTS700016` application not found | Wrong client ID in `config.js`, or the app isn't set to multitenant. |
| `AADSTS65001` / needs admin approval | The organization blocks user consent. An admin uses *Approve for my organization*. |
| Sign-in button says it isn't set up | `clientId` in `config.js` is empty, or the new `config.js` hasn't deployed yet. |
