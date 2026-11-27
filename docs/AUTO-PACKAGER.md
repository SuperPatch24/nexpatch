# Package an installer (Admin Center)

Platform admins (Super Admin or Catalog role) can turn a vendor's MSI or EXE into a catalog app that every company
can publish: **Admin Center, Shared catalog, Package an installer**.

1. **Upload** the installer and any files it needs (transforms, config or response files). Up to 20 files, 400 MB.
2. **Safety check.** For every file: size, SHA-256 and the Microsoft Defender scan result. For the installer:
   type and architecture, version info, the Authenticode signature (signer, file unchanged since signing, signature
   genuine, timestamp, whether the chain ends at a public root) and the installer framework.
   - **Blocked:** malware found by Defender, 3+ VirusTotal detections, or a signature that no longer matches the file.
   - **Review:** unsigned, not scanned yet, unrecognised installer, per-user installer, expired certificate.
   - These checks do not prove a file is safe. Defender's scan is the antivirus part; the rest helps you judge it.
3. **Commands.** NexpatchOnline suggests silent install and uninstall commands for the framework it found
   (MSI, Inno Setup, NSIS, WiX Burn, InstallShield, Advanced Installer and others) and a detection rule
   (MSI product code, the name in Installed apps, or a file). Unknown installers get a few common switches marked as guesses.
4. **Add to catalog.** It appears in every company's catalog as "Packaged by NexpatchOnline". Publishing it works like
   any WinGet app (rings, update-only, supersedence). Test it in your own tenant before relying on it.

## One-time setup (Azure)
| What | Why |
| --- | --- |
| `BLOB_STORAGE_ACCOUNT_NAME` on the Function App (already set for custom builds, `nexpatchpkg25483`) | Where uploads are kept (container `nexpatch-catalog-packages`) |
| Function App identity has **Storage Blob Data Owner** on that storage account | Upload links, and reading Defender's scan result tag |
| Storage account **CORS**: allow `https://nexpatchonline.com`, methods PUT and OPTIONS, headers `*` | The browser uploads straight to storage |
| **Microsoft Defender for Storage** with **malware scanning** on that storage account | Scans every upload; NexpatchOnline reads the result |
| Optional: `VIRUSTOTAL_API_KEY` on the Function App | Looks up the installer's SHA-256 on VirusTotal (the file itself is never sent) |

Cloud Shell example for the role:
```bash
PRINCIPAL=$(az functionapp identity show -g nexpatch-rg -n nexpatch-api-20022 --query principalId -o tsv)
SCOPE=$(az storage account show -g nexpatch-rg -n nexpatchpkg25483 --query id -o tsv)
az role assignment create --assignee-object-id "$PRINCIPAL" --assignee-principal-type ServicePrincipal --role "Storage Blob Data Owner" --scope "$SCOPE"
```
