# Microsoft Intune connection and permission checklist

This guide is an administrator preparation checklist. The exact permissions shown in the Microsoft consent screen and the app registration's configured Microsoft Graph **Application permissions** are authoritative. Do not grant permissions merely because they appear in a generic guide. Review the feature-to-permission mapping with the NexpatchOnline operator before granting tenant-wide consent.

## Before connecting

- [ ] Confirm the correct Microsoft Entra tenant ID and verified domain.
- [ ] Use a Global Administrator or another role authorized to grant admin consent for the requested application permissions.
- [ ] Review the NexpatchOnline enterprise application publisher, application ID and requested permissions.
- [ ] Confirm whether the organization will use read-only inventory, application deployment, update deployment, App Control, Defender signals, or PowerShell remediation. Enable only the features required.
- [ ] Create pilot device and user groups. Do not begin with all production devices.
- [ ] Record the approving administrator, date, change ticket and approved scope.

## Feature checklist

### Inventory and device discovery
- [ ] Read device and managed-device inventory.
- [ ] Read discovered applications and installed application versions.
- [ ] Read device compliance / management status if used by reporting.
- [ ] Validate inventory sync against a small pilot group.

### Application packaging and deployment
- [ ] Read Intune mobile apps and assignments where needed to identify existing apps.
- [ ] Create and manage mobile apps only if NexpatchOnline will publish applications.
- [ ] Read groups and group membership only if the workflow resolves deployment targets.
- [ ] Read and manage app assignments only if the customer explicitly enables assignment management.
- [ ] Validate app upload, commit, assignment and install status in a pilot group.

### Application updates
- [ ] Confirm whether updates are WinGet-sourced, Microsoft Store-managed, or customer-uploaded.
- [ ] Grant app and assignment write access only if NexpatchOnline will create or update those Intune objects.
- [ ] Confirm supersedence, dependencies, detection rules and rollback approach before broad rollout.

### App Control / Windows Defender Application Control
- [ ] Read device configuration and relevant policy state if App Control reporting is enabled.
- [ ] Create or update App Control policies only when the customer has explicitly enabled policy deployment.
- [ ] Pilot in audit mode before enforcement.
- [ ] Maintain an emergency recovery policy and documented rollback owner.

### Microsoft Defender (optional)
- [ ] Defender integration is optional and separate from core Intune app deployment.
- [ ] Identify the exact Defender data or action required before requesting any Microsoft Defender API permissions.
- [ ] Do not grant broad Defender permissions for a feature that only needs Intune inventory.

### PowerShell remediation scripts
- [ ] Decide whether scripts are only stored in the Nexpatch catalog or actually delivered/executed through Intune.
- [ ] For execution, review the required Intune device-management script permissions and the exact Graph endpoints used by the enabled workflow.
- [ ] Review script source, publisher, hash, signing status, run context, timeout and exit-code behavior.
- [ ] Require platform review and customer approval before assignment.
- [ ] Pilot scripts on test devices and retain execution results.

## Permission design principles

NexpatchOnline uses app-only Microsoft Graph authentication for tenant operations. Application permissions generally operate without a signed-in user and require tenant admin consent. They can be powerful. The final production consent list must be generated from the exact Graph routes in the deployed build and verified against Microsoft's current Graph permission reference. Do not infer a permission list from feature names alone.

## Verification after consent

- [ ] Re-open the connection status in NexpatchOnline.
- [ ] Run a read-only inventory sync first.
- [ ] Confirm expected devices and apps are visible.
- [ ] Test deployment only after the read path works and only in a pilot group.
- [ ] Test App Control / Defender / scripts independently; do not assume consent for one feature enables another.
- [ ] Document denied permissions and the corresponding disabled feature.

## Revocation

A tenant administrator can review and revoke consent from Microsoft Entra admin center → Enterprise applications → NexpatchOnline → Permissions. Revocation may stop inventory, deployments, scripts, or reporting. Plan a controlled shutdown and export required records first.
