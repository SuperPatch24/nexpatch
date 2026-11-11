# Deploy the NexpatchOnline backend (Azure Functions)

The backend checks every sign-in, stores each organization's data separately
(Table Storage, partitioned by tenant ID), and reads Intune with a certificate kept in Key Vault.

Time: about 45 minutes. Cost at low usage: a few dollars a month or less
(Flex Consumption has a monthly free grant; Table Storage and Key Vault cost cents).

You need: the Azure CLI (`az`), Azure Functions Core Tools v4 (`func`), Node.js 22, and the
app registration from `ENTRA-SETUP.md`.

---

## 1. Update the app registration

In **Entra admin center → App registrations → NexpatchOnline**:

1. **Expose an API → Application ID URI → Add**, accept `api://<client-id>`, Save.
2. **Expose an API → Add a scope**
   - Scope name: `access_as_user`
   - Who can consent: **Admins and users**
   - Admin consent display name: *Use NexpatchOnline*
   - Admin consent description: *Lets NexpatchOnline's website call its backend as the signed-in user.*
3. **Manifest:** set `"requestedAccessTokenVersion": 2` (inside the `api` section), and set
   `"groupMembershipClaims": "DirectoryRole"` (top level). Save.
   The second setting lets Entra Global Administrators and Intune Administrators always have owner access.
4. **API permissions → Add a permission → APIs my organization uses → NexpatchOnline → Delegated → access_as_user.**
   Admin approval then covers it automatically.

## 2. Create the Azure resources

Run in Bash (Azure Cloud Shell works). Pick your own unique names.

```bash
RG=nexpatch-rg
LOC=canadacentral
ST=nexpatchst$RANDOM          # storage: 3–24 lowercase letters and numbers
KV=nexpatch-kv-$RANDOM        # key vault: globally unique
FN=nexpatch-api-$RANDOM       # function app
CLIENT_ID=<your-client-id>
SITE=https://nexpatchonline.com

az login
az group create -n $RG -l $LOC

az storage account create -n $ST -g $RG -l $LOC --sku Standard_LRS \
  --min-tls-version TLS1_2 --allow-blob-public-access false

az keyvault create -n $KV -g $RG -l $LOC --enable-rbac-authorization true

az functionapp create -g $RG -n $FN --storage-account $ST \
  --flexconsumption-location $LOC --runtime node --runtime-version 22

az functionapp identity assign -g $RG -n $FN
```

## 3. Give the backend least-privilege access

```bash
PRINCIPAL=$(az functionapp identity show -g $RG -n $FN --query principalId -o tsv)
ST_ID=$(az storage account show -n $ST -g $RG --query id -o tsv)
KV_ID=$(az keyvault show -n $KV -g $RG --query id -o tsv)
ME=$(az ad signed-in-user show --query id -o tsv)

# Backend: read/write tables, read the certificate. Nothing else.
az role assignment create --assignee-object-id $PRINCIPAL --assignee-principal-type ServicePrincipal \
  --role "Storage Table Data Contributor" --scope $ST_ID
az role assignment create --assignee-object-id $PRINCIPAL --assignee-principal-type ServicePrincipal \
  --role "Key Vault Secrets User" --scope $KV_ID
# Publishing jobs run through a storage queue
az role assignment create --assignee-object-id $PRINCIPAL --assignee-principal-type ServicePrincipal \
  --role "Storage Queue Data Contributor" --scope $ST_ID

# You: allowed to create the certificate.
az role assignment create --assignee $ME --role "Key Vault Certificates Officer" --scope $KV_ID
```

Role assignments can take a few minutes to apply.

## 4. Create the certificate

The backend signs in to client tenants with this certificate. Its private key never leaves Key Vault and the backend.

```bash
az keyvault certificate get-default-policy \
  | sed 's#application/x-pkcs12#application/x-pem-file#' > policy.json
az keyvault certificate create --vault-name $KV -n nexpatch-graph -p @policy.json

# Public part only, to upload to the app registration
az keyvault certificate download --vault-name $KV -n nexpatch-graph -f nexpatch-graph.cer -e DER
```

Then in **App registrations → NexpatchOnline → Certificates & secrets → Certificates → Upload certificate**, upload `nexpatch-graph.cer`.

The default policy makes a 12-month certificate. **Set a calendar reminder** to renew it and upload the new one before it expires, or every client stops syncing.

## 5. Configure and deploy

First, create a free GitHub token so NexpatchOnline can check winget for new versions
(GitHub allows only 60 anonymous checks an hour, shared with other Azure customers):
GitHub → **Settings → Developer settings → Fine-grained tokens → Generate new token**,
**Repository access: Public repositories (read-only)**, no extra permissions. Copy the token.

```bash
az functionapp config appsettings set -g $RG -n $FN --settings \
  CLIENT_ID=$CLIENT_ID \
  KEY_VAULT_URL=https://$KV.vault.azure.net/ \
  CERT_NAME=nexpatch-graph \
  TABLES_URL=https://$ST.table.core.windows.net \
  GITHUB_TOKEN=<your-github-token>

az functionapp cors add -g $RG -n $FN --allowed-origins $SITE http://localhost:8787

cd api
npm install --omit=dev
func azure functionapp publish $FN

# Your API address (new apps get a unique host name)
echo "https://$(az functionapp show -g $RG -n $FN --query defaultHostName -o tsv)/api"
```

## 6. Point the website at the backend

In `public/config.js`, set `apiBaseUrl` to the address printed above (ending in `/api`). Commit and push.

## 7. Test

- [ ] Sign out and sign in again (the site now asks for the NexpatchOnline API scope).
- [ ] **Connect to Intune → Approve for my organization.** After returning, the page says
      *Finishing the connection*, then **Connected**, then shows the number of app versions synced.
      A brand-new approval can take a minute to take effect; the site retries automatically.
- [ ] **Discovery** shows your real apps, labelled *Synced from Intune*.
- [ ] **Sync now from Intune** works (limited to once every 5 minutes).
- [ ] Next morning, *Last synced* shows the nightly run (07:00 UTC).
- [ ] Sign in from a second trial tenant: it sees only its own inventory.

## API reference

| Method | Path | What it does |
|---|---|---|
| GET | `/api/me` | Signed-in user and organization status |
| POST | `/api/tenant/activate` | Confirms admin approval works, marks the organization active |
| GET | `/api/inventory` | Stored inventory for the caller's organization (Viewer) |
| POST | `/api/inventory/sync` | Pulls fresh inventory from Intune now (Admin) |
| GET | `/api/users` | People with access and pending invitations (Admin) |
| POST | `/api/users` | Invite someone by work email with a role (Owner) |
| PATCH | `/api/users/{id}` | Change someone's role (Owner) |
| DELETE | `/api/users/{id}` | Remove access or cancel an invitation (Owner) |
| GET | `/api/audit` | Recent activity (Admin) |
| POST | `/api/publish` | Publish an app to Intune with the chosen options (Admin); returns a job ID |
| GET | `/api/publish` | Recent publishing jobs (Viewer) |
| GET | `/api/publish/{id}` | One job's status and log (Viewer) |
| GET/PUT | `/api/appcontrol/settings` | App Control event source and base policy ID (Viewer / Admin) |
| POST | `/api/appcontrol/key` | Create or replace the collector key; returns installer scripts once (Owner) |
| POST | `/api/appcontrol/ingest` | Collector devices send events (authenticated by the organization's key) |
| POST | `/api/appcontrol/check` | Test Defender or show collector status (Admin) |
| GET | `/api/appcontrol/events` | Live App Control activity with decisions (Viewer) |
| POST | `/api/appcontrol/decisions` | Allow publisher, allow file, block, ignore, undo (Admin) |
| GET | `/api/appcontrol/supplemental` | Supplemental policy XML from allow decisions (Admin) |
| GET/POST | `/api/appcontrol/base` | Build the base policy and deploy it to Intune (Admin) |
| POST | `/api/appcontrol/supplemental/deploy` | Deploy the supplemental policy to Intune (Admin) |
| GET | `/api/groups?search=` | Search Entra groups for pickers (Admin) |
| timer | `appControlPoll` | Every 15 minutes, polls Defender for organizations that chose it |
| queue | `publishWorker` | Builds the package, uploads it to Intune, sets relationships and assignments |
| timer | `nightlySync` | Syncs every active organization daily at 07:00 UTC |

Every request must carry a valid Entra ID access token for `api://<client-id>/access_as_user`.
The tenant ID always comes from that token, never from the request, so one organization can't read another's data.

## App Control live events

Each organization chooses its event source on the App Control page:

- **Microsoft Defender:** add the application permission **Microsoft Graph → ThreatHunting.Read.All** to the app registration
  (once). Clients approve NexpatchOnline again, then use **Check connection**. Needs advanced hunting in the client's tenant.
- **NexpatchOnline collector:** an owner clicks **Create device key and installer**, then deploys the downloaded installer as an
  Intune platform script (SYSTEM, 64-bit). No extra Azure setup.

## Access control

- Roles per organization: **Viewer** (read only), **Admin** (publish, sync, App Control), **Owner** (also manages people).
- The person who connects an organization becomes its first owner. An organization always keeps at least one owner.
- Entra Global Administrators and Intune Administrators always have owner access (needs the manifest setting in step 1).
- Invitations match the person's Microsoft sign-in name within the same organization, the first time they sign in.
- Every change is written to the organization's activity log.

## Updating the backend later

After changing anything in `api`, deploy again from your PC:

```powershell
cd C:\dev\nexpatch\api
npm install --omit=dev
func azure functionapp publish <your-function-app-name>
```

## Local development

```bash
npm install -g azurite
azurite-table &                                 # local Table Storage

# Development certificate (upload dev-cert.cer to the app registration too)
openssl req -x509 -newkey rsa:2048 -nodes -days 90 -subj "/CN=nexpatch-dev" \
  -keyout dev-key.pem -out dev-cert.cer
cat dev-key.pem dev-cert.cer > api/dev-cert.pem && rm dev-key.pem

cd api
cp local.settings.example.json local.settings.json   # add your CLIENT_ID
npm install
func start                                       # http://localhost:7071/api
```

Set `apiBaseUrl: 'http://localhost:7071/api'` in `public/config.js` while testing, and run the site with `npx wrangler dev`.
Never commit `local.settings.json` or any `.pem` file (both are in `.gitignore`).

## Restricting who can sign in (recommended for clients)

By default, anyone in an approved organization can sign in. Each client can limit this in
**Entra ID → Enterprise applications → NexpatchOnline → Properties → Assignment required: Yes**,
then assign only their IT admins under **Users and groups**.

## Application requests, installer storage and Admin Center

The client dashboard now includes **Request an application**. Requests are stored in the `AppRequests` Azure Table, partitioned by the requesting Entra tenant. Installer files are uploaded to the private `nexpatch-request-installers` Blob container; supported extensions are MSI, MSIX, APPX, EXE, ZIP and INTUNEWIN, with a 50 MB application limit. Uploads are quarantined for review (`scanStatus=pending`) and are never executed by the service.

Configure one of the following for private Blob Storage access:

- `BLOB_STORAGE_CONNECTION`: storage connection string (simplest setup), or
- `BLOB_STORAGE_URL`: `https://<storage-account>.blob.core.windows.net` plus `BLOB_STORAGE_ACCOUNT_NAME` when needed.

When using managed identity, grant the Function App **Storage Blob Data Contributor** and **Storage Blob Delegator** (for user-delegation SAS) on the storage account/container. The Function App also needs its existing Table Storage data permissions. Enable Microsoft Defender for Storage malware scanning (or an equivalent controlled malware-scanning workflow) before treating uploaded installers as safe. The admin download URL is short-lived (five minutes); the admin page labels it “Download installer (scan first)”. File extension validation is not malware scanning or package validation. A support/super admin must scan the downloaded file with the approved scanner and explicitly confirm the result before setting its scan status to `clean`; unsafe files can be marked `rejected`.

### Admin Center sign-in

The separate Admin Center is hosted at `/admin/`. Add `https://<your-site-hostname>/admin/` as an additional **Single-page application** redirect URI on the same Entra app registration. Configure the Function App allowlists with comma-separated administrator sign-in names (UPNs) or Entra object IDs: `PLATFORM_ADMINS` for Super Admin (full access), `PLATFORM_CATALOG_MANAGERS` for catalog-only access, and `PLATFORM_SUPPORT_ADMINS` for request triage and reporting. Optionally set `PLATFORM_TENANT_ID` to restrict all platform administrators to one Entra tenant. Only allowlisted platform roles can call platform APIs; site settings and tenant-wide billing/operations remain Super Admin only. The client portal remains at `/` and continues to use organization-scoped access.

The Admin Center includes request triage, shared catalog editing, live graphical summaries, Excel workbook export (Summary, Catalog, Requests and Organizations sheets), and a controlled website editor for the public hero headline/description, announcement banner and support email. It is not an arbitrary source-code editor. Deploy the updated API dependencies with `npm install` in `api/` before publishing the Functions app.
