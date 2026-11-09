# Automatic deployment

After this one-time setup, every change pushed to GitHub deploys itself:

- **Website** (`public/`): Cloudflare already redeploys on every push.
- **Backend** (`api/`): the GitHub Action in `.github/workflows/deploy-backend.yml` deploys to Azure Functions.

No more zip uploads or Cloud Shell for updates.

## One-time setup (Cloud Shell, about 10 minutes)

The Action signs in to Azure with a federated credential: GitHub proves who it is, and no password or secret is stored anywhere.

```bash
RG=nexpatch-rg
FN=nexpatch-api-20022
GH_REPO=SuperPatch24/nexpatch          # your GitHub owner/repository

# 1. An identity for GitHub
APP_ID=$(az ad app create --display-name nexpatchonline-github-deploy --query appId -o tsv)
az ad sp create --id $APP_ID -o none

# 2. Trust pushes to the main branch of your repository
az ad app federated-credential create --id $APP_ID --parameters "{\"name\":\"github-main\",\"issuer\":\"https://token.actions.githubusercontent.com\",\"subject\":\"repo:${GH_REPO}:ref:refs/heads/main\",\"audiences\":[\"api://AzureADTokenExchange\"]}"

# 3. Allow it to deploy this function app only
FN_ID=$(az functionapp show -g $RG -n $FN --query id -o tsv)
az role assignment create --assignee $APP_ID --role "Website Contributor" --scope $FN_ID -o none

# 4. Values for GitHub
az account show --query "{AZURE_TENANT_ID:tenantId, AZURE_SUBSCRIPTION_ID:id}" -o table
echo "AZURE_CLIENT_ID=$APP_ID"
```

If a deployment later fails with an authorization error, give the identity **Contributor** on the resource group instead:
`az role assignment create --assignee $APP_ID --role Contributor --scope $(az group show -n $RG --query id -o tsv)`

## Add the values in GitHub

Repository → **Settings → Secrets and variables → Actions**:

| Tab | Name | Value |
|---|---|---|
| Secrets | `AZURE_CLIENT_ID` | from step 4 |
| Secrets | `AZURE_TENANT_ID` | from step 4 |
| Secrets | `AZURE_SUBSCRIPTION_ID` | from step 4 |
| Variables | `FUNCTION_APP_NAME` | `nexpatch-api-20022` |

## Test it

Repository → **Actions → Deploy backend → Run workflow**. A green tick means the backend deployed.
From then on, any change under `api/` that reaches `main` deploys automatically.

## Platform administrators

The **Platform admin** page (shared app catalog, list of organizations) is shown to the accounts in the
`PLATFORM_ADMINS` app setting:

```bash
az functionapp config appsettings set -g nexpatch-rg -n nexpatch-api-20022 -o none --settings \
  "PLATFORM_ADMINS=MoHala@Nexpatch.onmicrosoft.com" \
  "PLATFORM_TENANT_ID=<your home tenant ID>"
```

Separate several accounts with commas. Sign in to NexpatchOnline with that account to see the page.
