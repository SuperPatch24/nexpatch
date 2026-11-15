// Deploys App Control policies to Intune as configuration (settings catalog) policies via Microsoft Graph.
// Base and supplemental use the same App Control settings-catalog shape, just a different template reference.
import { graph } from './graph.js';

const CP = '/beta/deviceManagement/configurationPolicies';
const TEMPLATES = {
  base: { id: '4321b946-b76b-4450-8afd-769c08b16ffc_1', family: 'endpointSecurityApplicationControl', display: 'App Control for Business' },
  supplemental: { id: '08441ae9-e0c0-4e57-8e8b-6e72405cd64f_1', family: 'endpointSecurityApplicationControlSupplementalPolicy', display: 'App Control for Business - Supplemental' }
};

function settingsPayload(xml) {
  return [{
    '@odata.type': '#microsoft.graph.deviceManagementConfigurationSetting',
    settingInstance: {
      '@odata.type': '#microsoft.graph.deviceManagementConfigurationChoiceSettingInstance',
      settingDefinitionId: 'device_vendor_msft_policy_config_applicationcontrol_policies_{policyguid}_policiesoptions',
      choiceSettingValue: {
        '@odata.type': '#microsoft.graph.deviceManagementConfigurationChoiceSettingValue',
        value: 'device_vendor_msft_policy_config_applicationcontrol_configure_xml_selected',
        children: [{
          '@odata.type': '#microsoft.graph.deviceManagementConfigurationSimpleSettingInstance',
          settingDefinitionId: 'device_vendor_msft_policy_config_applicationcontrol_policies_{policyguid}_xml',
          simpleSettingValue: {
            '@odata.type': '#microsoft.graph.deviceManagementConfigurationStringSettingValue',
            value: xml,
            settingValueTemplateReference: { settingValueTemplateId: '88f6f096-dedb-4cf1-ac2f-4b41e303adb5' }
          },
          settingInstanceTemplateReference: { settingInstanceTemplateId: '4d709667-63d7-42f2-8e1b-b780f6c3c9c7' }
        }],
        settingValueTemplateReference: { settingValueTemplateId: 'b28c7dc4-c7b2-4ce2-8f51-6ebfd3ea69d3' }
      },
      settingInstanceTemplateReference: { settingInstanceTemplateId: '1de98212-6949-42dc-a89c-e0ff6e5da04b' }
    }
  }];
}

function policyBody(name, xml, kind) {
  const t = TEMPLATES[kind];
  return {
    name, description: `Managed by NexpatchOnline (${new Date().toISOString().slice(0, 16).replace('T', ' ')})`,
    platforms: 'windows10', technologies: 'mdm', roleScopeTagIds: ['0'],
    templateReference: { '@odata.type': 'microsoft.graph.deviceManagementConfigurationPolicyTemplateReference', templateId: t.id, templateFamily: t.family, templateDisplayName: t.display, templateDisplayVersion: 'Version 1' },
    settings: settingsPayload(xml)
  };
}

async function findPolicy(tid, name, kind) {
  const f = encodeURIComponent(`templateReference/TemplateFamily eq '${TEMPLATES[kind].family}' and name eq '${name.replace(/'/g, "''")}'`);
  const res = await graph(tid, `${CP}?$filter=${f}`);
  return (res.value || [])[0] || null;
}

// Creates or updates an App Control policy in Intune, then assigns it to the given groups.
export async function deployAcPolicy(tid, { name, xml, kind, groupIds = [], allDevices = false, log = () => {} }) {
  const existing = await findPolicy(tid, name, kind);
  const body = policyBody(name, xml, kind);
  let policyId;
  if (existing) {
    policyId = existing.id;
    await graph(tid, `${CP}('${policyId}')`, { method: 'PUT', body: JSON.stringify(body) });
    log(`Updated the ${kind} policy in Intune`);
  } else {
    const created = await graph(tid, CP, { method: 'POST', body: JSON.stringify(body) });
    policyId = created.id;
    log(`Created the ${kind} policy in Intune`);
  }

  // Assignments (replace the whole set)
  const assignments = [];
  if (allDevices) assignments.push({ target: { '@odata.type': '#microsoft.graph.allDevicesAssignmentTarget' } });
  for (const g of groupIds) assignments.push({ target: { '@odata.type': '#microsoft.graph.groupAssignmentTarget', groupId: g } });
  await graph(tid, `${CP}('${policyId}')/assign`, { method: 'POST', body: JSON.stringify({ assignments }) });
  log(assignments.length ? `Assigned to ${assignments.length} target${assignments.length > 1 ? 's' : ''}` : 'Saved with no assignment yet');
  return { policyId, created: !existing };
}
