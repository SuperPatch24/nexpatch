# Deploy the Nexpatch backend (Azure Functions)

The backend checks every sign-in, stores each organization's data separately
(Table Storage, partitioned by tenant ID), and reads Intune with a certificate kept in Key Vault.

Time: about 45 minutes. Cost at low usage: a few dollars a month or less
(Flex Consumption has a monthly free grant; Table Storage and Key Vault cost cents).

You need: the Azure CLI (`az`), Azure Functions Core Tools v4 (`func`), Node.js 22, and the
app registration from `ENTRA-SETUP.md`.

---

## 1. Update the app registration

In **Entra admin center → App registrations → Nexpatch**:

1. **Expose an API → Application ID URI → Add**, accept `api://<client-id>`, Save.
2. **Expose an API → Add a scope**
   - Scope name: `access_as_user`
   - Who can consent: **Admins and users**
   - Admin consent display name: *Use Nexpatch*
   - Admin consent description: *Lets Nexpatch's website call its backend as the signed-in user.*
3. **Manifest:** set `"requestedAccessTokenVersion": 2` (inside the `api` section). Save.
4. **API permissions → Add a permission → APIs my organization uses → Nexpatch → Delegated → access_as_user.**
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
SITE=https://nexpatch.ahalawani02.workers.dev

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

Then in **App registrations → Nexpatch → Certificates & secrets → Certificates → Upload certificate**, upload `nexpatch-graph.cer`.

The default policy makes a 12-month certificate. **Set a calendar reminder** to renew it and upload the new one before it expires, or every client stops syncing.

## 5. Configure and deploy

```bash
az functionapp config appsettings set -g $RG -n $FN --settings \
  CLIENT_ID=$CLIENT_ID \
  KEY_VAULT_URL=https://$KV.vault.azure.net/ \
  CERT_NAME=nexpatch-graph \
  TABLES_URL=https://$ST.table.core.windows.net

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

- [ ] Sign out and sign in again (the site now asks for the Nexpatch API scope).
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
| GET | `/api/inventory` | Stored inventory for the caller's organization |
| POST | `/api/inventory/sync` | Pulls fresh inventory from Intune now |
| timer | `nightlySync` | Syncs every active organization daily at 07:00 UTC |

Every request must carry a valid Entra ID access token for `api://<client-id>/access_as_user`.
The tenant ID always comes from that token, never from the request, so one organization can't read another's data.

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
**Entra ID → Enterprise applications → Nexpatch → Properties → Assignment required: Yes**,
then assign only their IT admins under **Users and groups**.
