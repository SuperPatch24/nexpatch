// Publishes a Win32 app to a client's Intune, with the deployment options chosen on the website.
// Everything runs in the cloud: the package only contains a small script, and winget installs the app on each device.
import { graph, graphAll } from './graph.js';
import { latestWingetVersion } from './winget.js';
import { buildContent } from './intunewin.js';
import { WRAPPER, DETECT, REQUIREMENT } from './templates.js';

const B = '/beta/deviceAppManagement/mobileApps';
const OS = { W10_1607: '1607', W10_1809: '1809', W10_1909: '1909', W10_21H2: 'Windows10_21H2', W10_22H2: 'Windows10_22H2', W11_21H2: 'Windows11_21H2', W11_22H2: 'Windows11_22H2' };
const ARCH = { x64: 'x64', x64x86: 'x64,x86', arm64: 'arm64', AllWithARM64: 'x64,x86,arm64' };
const TARGET = { group: '#microsoft.graph.groupAssignmentTarget', allDevices: '#microsoft.graph.allDevicesAssignmentTarget', allUsers: '#microsoft.graph.allLicensedUsersAssignmentTarget' };
const GUID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const b64 = t => Buffer.from(t || '', 'utf8').toString('base64');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const psq = v => String(v).replace(/'/g, "''");
// Intune stores local-time schedules as the wall-clock time with a Z suffix when useLocalTime is true.
const localStamp = d => {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:00.000Z`;
};
const fromLocalInput = v => (v ? `${v.length === 16 ? v + ':00' : v.slice(0, 19)}.000Z` : null);

async function findApps(tid, name) {
  const apps = await graphAll(tid, `${B}?$filter=${encodeURIComponent("isof('microsoft.graph.win32LobApp')")}`);
  return apps.filter(a => a.displayName === name).sort((a, b) => Date.parse(a.createdDateTime) - Date.parse(b.createdDateTime));
}

async function resolveGroup(tid, value) {
  if (GUID.test(value)) return value;
  const q = encodeURIComponent(`displayName eq '${psq(value)}'`);
  const found = (await graph(tid, `/v1.0/groups?$filter=${q}&$select=id,displayName`)).value || [];
  if (found.length === 1) return found[0].id;
  throw new Error(found.length ? `Several groups are named \u201c${value}\u201d. Use its object ID instead.` : `No group named \u201c${value}\u201d was found.`);
}

async function resolveFilter(tid, name, cache) {
  cache.list ??= (await graph(tid, '/beta/deviceManagement/assignmentFilters')).value || [];
  const f = cache.list.find(x => x.displayName.toLowerCase() === name.toLowerCase());
  if (!f) throw new Error(`No assignment filter named \u201c${name}\u201d was found.`);
  return f.id;
}

function buildAssignments(o) {
  if (o.method === 'rings') {
    const start = new Date(), out = [];
    for (const r of o.rings || []) {
      if (!r.group) continue;
      const at = new Date(start.getTime() + (+r.defer || 0) * 864e5);
      out.push({ label: r.name, target: 'group', group: r.group, mode: 'include', intent: o.ringIntent, start: localStamp(at),
        deadline: o.ringIntent === 'available' ? null : localStamp(new Date(at.getTime() + (+o.grace || 0) * 36e5)), filter: o.filter, filterMode: o.filterMode });
    }
    if (o.exclude) out.push({ label: o.exclude, target: 'group', group: o.exclude, mode: 'exclude', intent: o.ringIntent });
    return out;
  }
  return (o.assignments || []).map(a => ({
    label: a.target === 'allDevices' ? 'All devices' : a.target === 'allUsers' ? 'All users' : a.group,
    target: a.mode === 'exclude' ? 'group' : a.target, group: a.group, mode: a.mode, intent: a.intent,
    start: fromLocalInput(a.start), deadline: a.intent === 'available' ? null : fromLocalInput(a.deadline), filter: a.filter, filterMode: a.filterMode
  }));
}

async function uploadContent(tid, appId, content, log) {
  const cv = await graph(tid, `${B}/${appId}/microsoft.graph.win32LobApp/contentVersions`, { method: 'POST', body: '{}' });
  const filesUri = `${B}/${appId}/microsoft.graph.win32LobApp/contentVersions/${cv.id}/files`;
  const file = await graph(tid, filesUri, { method: 'POST', body: JSON.stringify({
    '@odata.type': '#microsoft.graph.mobileAppContentFile', name: 'Install-Update.intunewin', size: content.size, sizeEncrypted: content.encrypted.length, manifest: null, isDependency: false }) });
  const fileUri = `${filesUri}/${file.id}`;
  const waitFor = async stage => {
    for (let i = 0; i < 90; i++) {
      const f = await graph(tid, fileUri);
      if (f.uploadState === `${stage}Success`) return f;
      if (/Failed|TimedOut/.test(f.uploadState)) throw new Error(`Intune reported ${f.uploadState}.`);
      await sleep(3000);
    }
    throw new Error(`Intune took too long (${stage}).`);
  };
  const ready = await waitFor('azureStorageUriRequest');
  log('Uploading the package');
  const blockId = Buffer.from('0000').toString('base64');
  let res = await fetch(`${ready.azureStorageUri}&comp=block&blockid=${encodeURIComponent(blockId)}`, { method: 'PUT', headers: { 'x-ms-blob-type': 'BlockBlob' }, body: content.encrypted });
  if (!res.ok) throw new Error(`Uploading the package failed (${res.status}).`);
  res = await fetch(`${ready.azureStorageUri}&comp=blocklist`, { method: 'PUT', headers: { 'Content-Type': 'application/xml' },
    body: `<?xml version="1.0" encoding="utf-8"?><BlockList><Latest>${blockId}</Latest></BlockList>` });
  if (!res.ok) throw new Error(`Finishing the upload failed (${res.status}).`);
  await graph(tid, `${fileUri}/commit`, { method: 'POST', body: JSON.stringify({ fileEncryptionInfo: content.encryptionInfo }) });
  log('Waiting for Intune to process the package');
  await waitFor('commitFile');
  await graph(tid, `${B}/${appId}`, { method: 'PATCH', body: JSON.stringify({ '@odata.type': '#microsoft.graph.win32LobApp', committedContentVersion: cv.id }) });
}

export async function publishApp(tid, app, o, log) {
  const assignments = buildAssignments(o);
  const includes = assignments.filter(a => a.mode !== 'exclude');
  const uninstallOnly = includes.length > 0 && includes.every(a => a.intent === 'uninstall');
  const existing = await findApps(tid, app.name);
  let target, version, superseded = false;

  if (uninstallOnly) {
    target = existing.at(-1);
    if (!target) throw new Error(`${app.name} isn\u2019t in Intune, so there\u2019s nothing to uninstall.`);
    if (/exit 0/.test(target.uninstallCommandLine || '')) throw new Error(`${app.name} was published by an older Nexpatch version without an uninstall command. Publish it again first.`);
    version = target.displayVersion;
    log(`Using ${app.name} ${version}, already in Intune`);
  } else {
    log('Checking winget for the latest version');
    version = await latestWingetVersion(app.winget);
    const same = existing.find(a => a.displayVersion === version);
    if (same) {
      target = same;
      log(`${app.name} ${version} is already in Intune, so only the assignments are added`);
    } else {
      log(`Building ${app.name} ${version}`);
      const procs = (o.procs || []).filter(Boolean).map(p => `'${psq(p)}'`).join(',');
      const wrapper = WRAPPER.replace('__ID__', app.winget).replace('__NAME__', psq(app.name)).replace('__PROCS__', procs)
        .replace('__CONFLICT__', o.conflict || 'Close').replace('__MINUTES__', String(+o.confMin || 10))
        .replace('__PRE64__', b64(o.pre)).replace('__POST64__', b64(o.post)).replace('__ACTION__', o.updateOnly ? 'upgrade' : 'install');
      const content = buildContent({ 'Install-Update.ps1': '\ufeff' + wrapper });

      let detection;
      if (o.detect === 'file' && o.detectFile) {
        const i = o.detectFile.lastIndexOf('\\');
        detection = { '@odata.type': '#microsoft.graph.win32LobAppFileSystemDetection', operator: 'greaterThanOrEqual', detectionValue: version,
          path: o.detectFile.slice(0, i), fileOrFolderName: o.detectFile.slice(i + 1), check32BitOn64System: false, detectionType: 'version' };
      } else {
        const script = o.detect === 'script' && o.detectScript ? o.detectScript : DETECT.replace('__NAME__', app.reg).replace('__VER__', version);
        detection = { '@odata.type': '#microsoft.graph.win32LobAppPowerShellScriptDetection', enforceSignatureCheck: false, runAs32Bit: false, scriptContent: b64(script) };
      }
      const requirementRules = [];
      const scriptReq = (name, script, value) => ({ '@odata.type': '#microsoft.graph.win32LobAppPowerShellScriptRequirement', operator: 'equal', detectionValue: value,
        displayName: name, enforceSignatureCheck: false, runAs32Bit: false, runAsAccount: 'system', scriptContent: b64(script), detectionType: 'string' });
      if (o.updateOnly) requirementRules.push(scriptReq('Requirement.ps1', REQUIREMENT.replace('__NAME__', app.reg), 'Installed'));
      if (o.regKey) requirementRules.push({ '@odata.type': '#microsoft.graph.win32LobAppRegistryRequirement', operator: 'notConfigured', detectionValue: null,
        check32BitOn64System: false, keyPath: o.regKey, valueName: o.regValue || null, detectionType: o.regType || 'exists' });
      if (o.reqScript) requirementRules.push(scriptReq('Requirement-Custom.ps1', o.reqScript, 'Applicable'));

      const body = {
        '@odata.type': '#microsoft.graph.win32LobApp',
        displayName: app.name, description: `${app.name} ${version}, packaged by Nexpatch from winget (${app.winget}).`, publisher: app.vendor || app.name,
        displayVersion: version, developer: '', owner: '', notes: o.notes || '', informationUrl: o.infoUrl || '', privacyInformationUrl: '', isFeatured: !!o.featured,
        fileName: 'Install-Update.intunewin', setupFilePath: 'Install-Update.ps1',
        installCommandLine: 'powershell.exe -ExecutionPolicy Bypass -NoProfile -File .\\Install-Update.ps1',
        uninstallCommandLine: 'powershell.exe -ExecutionPolicy Bypass -NoProfile -File .\\Install-Update.ps1 -Uninstall',
        installExperience: { runAsAccount: 'system', deviceRestartBehavior: o.restart || 'suppress', maxRunTimeInMinutes: +o.maxTime || 60 },
        minimumSupportedWindowsRelease: OS[o.minOS] || '1809', msiInformation: null, runAs32bit: false,
        allowedArchitectures: ARCH[o.arch] || 'x64', applicableArchitectures: 'none',
        detectionRules: [detection],
        returnCodes: [{ returnCode: 0, type: 'success' }, { returnCode: 1707, type: 'success' }, { returnCode: 3010, type: 'softReboot' }, { returnCode: 1641, type: 'hardReboot' }, { returnCode: 1618, type: 'retry' }]
      };
      if (+o.disk > 0) body.minimumFreeDiskSpaceInMB = +o.disk;
      if (+o.mem > 0) body.minimumMemoryInMB = +o.mem;
      if (+o.cpus > 0) body.minimumNumberOfProcessors = +o.cpus;
      if (+o.cpuMhz > 0) body.minimumCpuSpeedInMHz = +o.cpuMhz;
      if (requirementRules.length) body.requirementRules = requirementRules;
      if (o.allowUninst) body.allowAvailableUninstall = true;

      log('Creating the app in Intune');
      target = await graph(tid, B, { method: 'POST', body: JSON.stringify(body) });
      try {
        await uploadContent(tid, target.id, content, log);
      } catch (err) {
        await graph(tid, `${B}/${target.id}`, { method: 'DELETE' }).catch(() => {});
        throw err;
      }

      // Dependencies and supersedence are saved together
      const relationships = [];
      for (const name of o.deps || []) {
        const dep = (await findApps(tid, name)).at(-1);
        if (dep) relationships.push({ '@odata.type': '#microsoft.graph.mobileAppDependency', dependencyType: o.depType === 'Detect' ? 'detect' : 'autoInstall', targetId: dep.id });
        else log(`Dependency \u201c${name}\u201d isn\u2019t in Intune yet, skipped`);
      }
      const old = [];
      if (o.supersede && existing.length) old.push(existing.at(-1));
      for (const name of o.superOther || []) { const x = (await findApps(tid, name)).at(-1); if (x) old.push(x); else log(`\u201c${name}\u201d isn\u2019t in Intune, so it can\u2019t be superseded`); }
      for (const x of old) relationships.push({ '@odata.type': '#microsoft.graph.mobileAppSupersedence', supersedenceType: (o.superType || 'Update').toLowerCase(), targetId: x.id });
      if (relationships.length) {
        await graph(tid, `${B}/${target.id}/updateRelationships`, { method: 'POST', body: JSON.stringify({ relationships }) });
        superseded = old.length > 0;
        if (old.length) log(`Supersedes ${old.map(x => `${x.displayName} ${x.displayVersion}`).join(', ')}`);
        if (relationships.length > old.length) log(`Dependencies: ${(o.deps || []).join(', ')}`);
      }
    }
  }

  // Assignments
  const current = ((await graph(tid, `${B}/${target.id}/assignments`)).value || []).map(a => `${a.target['@odata.type']}|${a.target.groupId || ''}|${a.intent}`);
  const filters = {};
  let added = 0;
  for (const a of assignments) {
    try {
      const groupId = a.target === 'group' ? await resolveGroup(tid, a.group) : null;
      const type = a.mode === 'exclude' ? '#microsoft.graph.exclusionGroupAssignmentTarget' : TARGET[a.target];
      if (current.includes(`${type}|${groupId || ''}|${a.intent}`)) { log(`${a.label}: already assigned`); continue; }
      const t = { '@odata.type': type, groupId: groupId || undefined, deviceAndAppManagementAssignmentFilterId: null, deviceAndAppManagementAssignmentFilterType: 'none' };
      if (a.mode !== 'exclude' && a.filter) { t.deviceAndAppManagementAssignmentFilterId = await resolveFilter(tid, a.filter, filters); t.deviceAndAppManagementAssignmentFilterType = (a.filterMode || 'Include').toLowerCase(); }
      const body = { '@odata.type': '#microsoft.graph.mobileAppAssignment', intent: a.intent, source: 'direct', target: t, settings: null };
      if (a.mode !== 'exclude') {
        body.settings = { '@odata.type': '#microsoft.graph.win32LobAppAssignmentSettings', notifications: o.notify || 'showAll', deliveryOptimizationPriority: o.dop || 'notConfigured', restartSettings: null, installTimeSettings: null };
        if (a.start || a.deadline) body.settings.installTimeSettings = { useLocalTime: true, startDateTime: a.start || null, deadlineDateTime: a.deadline || null };
        if (a.intent !== 'available' && o.graceOn) body.settings.restartSettings = { gracePeriodInMinutes: +o.graceMin || 1440, countdownDisplayBeforeRestartInMinutes: +o.countdown || 15, restartNotificationSnoozeDurationInMinutes: +o.snooze > 0 ? +o.snooze : null };
        if (a.intent === 'available' && o.autoUpd && superseded) body.settings.autoUpdateSettings = { autoUpdateSupersededAppsState: 'enabled' };
      }
      await graph(tid, `${B}/${target.id}/assignments`, { method: 'POST', body: JSON.stringify(body) });
      added++;
      log(`${a.mode === 'exclude' ? 'Excluded' : a.intent[0].toUpperCase() + a.intent.slice(1)}: ${a.label}${a.start ? ', from ' + a.start.slice(0, 16).replace('T', ' ') : a.mode === 'exclude' ? '' : ', as soon as possible'}${a.deadline ? ', deadline ' + a.deadline.slice(0, 16).replace('T', ' ') : ''}`);
    } catch (err) {
      log(`Skipped ${a.label}: ${err.message}`);
    }
  }
  return { appId: target.id, version, assignmentsAdded: added };
}
