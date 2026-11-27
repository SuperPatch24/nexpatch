// Publishes the NexpatchOnline agent to a customer's Intune as a Win32 app.
// Intune's own installer runs it, so App Control's managed-installer rule trusts the agent without any script.
import { graph, graphAll } from './graph.js';
import { buildContent } from './intunewin.js';
import { uploadContent } from './publisher.js';

const B = '/beta/deviceAppManagement/mobileApps';
export const AGENT_APP_NAME = 'NexpatchOnline Agent';

export function agentAppBody(version) {
  return {
    '@odata.type': '#microsoft.graph.win32LobApp',
    displayName: AGENT_APP_NAME, publisher: 'NexpatchOnline', displayVersion: version,
    description: `NexpatchOnline device agent ${version}. Reports installed apps, winget health and install results to NexpatchOnline. Managed by NexpatchOnline.`,
    notes: 'Managed by NexpatchOnline. Republish it from NexpatchOnline (Devices page) rather than editing it here.',
    developer: 'NexpatchOnline', owner: '', informationUrl: 'https://nexpatchonline.com/', privacyInformationUrl: 'https://nexpatchonline.com/legal/privacy.html', isFeatured: false,
    fileName: 'NexpatchOnlineAgent.intunewin', setupFilePath: 'nexpatch-agent.exe',
    installCommandLine: 'nexpatch-agent.exe install', uninstallCommandLine: 'nexpatch-agent.exe uninstall',
    installExperience: { runAsAccount: 'system', deviceRestartBehavior: 'suppress', maxRunTimeInMinutes: 30 },
    minimumSupportedWindowsRelease: '1809', msiInformation: null, runAs32bit: false, allowedArchitectures: 'x64,arm64', applicableArchitectures: 'none',
    detectionRules: [{ '@odata.type': '#microsoft.graph.win32LobAppRegistryDetection', check32BitOn64System: false, keyPath: 'HKEY_LOCAL_MACHINE\\SOFTWARE\\NexpatchOnline\\Agent',
      valueName: 'Version', detectionType: 'version', operator: 'greaterThanOrEqual', detectionValue: version }],
    returnCodes: [{ returnCode: 0, type: 'success' }, { returnCode: 3010, type: 'softReboot' }, { returnCode: 1618, type: 'retry' }]
  };
}

export const agentAssignment = target => ({ '@odata.type': '#microsoft.graph.mobileAppAssignment', intent: 'required', source: 'direct', target,
  settings: { '@odata.type': '#microsoft.graph.win32LobAppAssignmentSettings', notifications: 'hideAll', deliveryOptimizationPriority: 'notConfigured', restartSettings: null, installTimeSettings: null } });

// Creates or refreshes the agent app (new config inside every time), supersedes older versions and adds assignments.
export async function publishAgent(tid, { exe, config, version, groupIds = [], allDevices = false, log = async () => {} }) {
  const content = buildContent({ 'nexpatch-agent.exe': exe, 'config.json': config });
  const all = (await graphAll(tid, `${B}?$filter=${encodeURIComponent("isof('microsoft.graph.win32LobApp')")}`)).filter(a => a.displayName === AGENT_APP_NAME);
  let app = all.find(a => a.displayVersion === version), created = false;
  if (!app) {
    await log(`Creating ${AGENT_APP_NAME} ${version} in Intune`);
    app = await graph(tid, B, { method: 'POST', body: JSON.stringify(agentAppBody(version)) });
    created = true;
  } else await log(`${AGENT_APP_NAME} ${version} is already in Intune; refreshing its package`);
  try { await uploadContent(tid, app.id, content, log, 'NexpatchOnlineAgent.intunewin'); }
  catch (err) { if (created) await graph(tid, `${B}/${app.id}`, { method: 'DELETE' }).catch(() => {}); throw err; }
  const older = all.filter(a => a.id !== app.id).sort((a, b) => Date.parse(b.createdDateTime) - Date.parse(a.createdDateTime));
  if (created && older.length) {
    await graph(tid, `${B}/${app.id}/updateRelationships`, { method: 'POST', body: JSON.stringify({ relationships: [{ '@odata.type': '#microsoft.graph.mobileAppSupersedence', supersedenceType: 'update', targetId: older[0].id }] }) }).catch(e => log(`Couldn’t link to the older version: ${e.message}`));
    await log(`Replaces ${AGENT_APP_NAME} ${older[0].displayVersion}`);
  }
  const current = ((await graph(tid, `${B}/${app.id}/assignments`)).value || []).map(a => `${a.target?.['@odata.type']}|${a.target?.groupId || ''}`);
  const wanted = [...(allDevices ? [{ '@odata.type': '#microsoft.graph.allDevicesAssignmentTarget' }] : []), ...groupIds.map(groupId => ({ '@odata.type': '#microsoft.graph.groupAssignmentTarget', groupId }))];
  let added = 0;
  for (const t of wanted) {
    if (current.includes(`${t['@odata.type']}|${t.groupId || ''}`)) continue;
    const body = JSON.stringify(agentAssignment({ ...t, deviceAndAppManagementAssignmentFilterId: null, deviceAndAppManagementAssignmentFilterType: 'none' }));
    try { await graph(tid, `${B}/${app.id}/assignments`, { method: 'POST', body }); }
    catch (err) { if (!/\(400\)/.test(err.message)) throw err; await new Promise(r => setTimeout(r, 15000)); await graph(tid, `${B}/${app.id}/assignments`, { method: 'POST', body }); }
    added++;
  }
  await log(added ? `Assigned as required to ${added} target${added > 1 ? 's' : ''}` : 'Assignments were already in place');
  return { appId: app.id, created, assignmentsAdded: added };
}
