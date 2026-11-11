import { app } from '@azure/functions';
import { randomUUID, createHash } from 'node:crypto';
import ExcelJS from 'exceljs';
import { withUser, HttpError, readJson } from '../lib/http.js';
import { graphAll } from '../lib/graph.js';
import { listRows, putRow, deleteRow, audit } from '../lib/store.js';

const clean = (v, n=200) => String(v ?? '').trim().slice(0,n);
const safeJson = v => { try { return JSON.parse(v || '{}'); } catch { return {}; } };

app.http('appleOverview', { methods:['GET'], authLevel:'anonymous', route:'apple/overview', handler:withUser(async (_req,_ctx,user) => {
  const [devices, apps, drafts] = await Promise.all([
    listRows('AppleDevices', user.tenantId, 20000), listRows('AppleApps', user.tenantId, 10000), listRows('PackageDrafts', user.tenantId, 1000)
  ]);
  return { syncedAt: devices[0]?.syncedAt || apps[0]?.syncedAt || null, devices:devices.map(x=>({id:x.rowKey,name:x.deviceName,model:x.model,osVersion:x.osVersion,serialNumber:x.serialNumber,ownership:x.ownership,complianceState:x.complianceState,lastSyncDateTime:x.lastSyncDateTime,userPrincipalName:x.userPrincipalName})), apps:apps.map(x=>({id:x.rowKey,name:x.displayName,publisher:x.publisher,version:x.version,platform:x.platform,deviceCount:Number(x.deviceCount)||0,source:x.source,managedAppId:x.managedAppId})), packageDrafts:['admin','owner'].includes(user.role)?drafts.map(x=>({id:x.rowKey,name:x.name,publisher:x.publisher,version:x.version,installerType:x.installerType,status:x.status,createdAt:x.createdAt,notes:x.notes})):[] };
}, 'viewer') });

app.http('appleSync', { methods:['POST'], authLevel:'anonymous', route:'apple/sync', handler:withUser(async (_req,_ctx,user) => {
  if (!['admin','owner'].includes(user.role)) throw new HttpError(403,'Only an organization Admin or Owner can sync Apple inventory.');
  // Graph device inventory is tenant-scoped. Filter locally to include iOS and iPadOS labels consistently.
  const [allDevices, detected, mobileApps] = await Promise.all([
    graphAll(user.tenantId, '/v1.0/deviceManagement/managedDevices?$select=id,deviceName,model,operatingSystem,osVersion,serialNumber,managedDeviceOwnerType,complianceState,lastSyncDateTime,userPrincipalName,managementAgent'),
    graphAll(user.tenantId, '/beta/deviceManagement/detectedApps?$select=id,displayName,publisher,version,platform,deviceCount'),
    graphAll(user.tenantId, '/beta/deviceAppManagement/mobileApps?$select=id,displayName,publisher,version,platform,appStoreUrl,packageId')
  ]);
  const devices = allDevices.filter(d => /ios|ipados/i.test(`${d.operatingSystem||''} ${d.model||''}`));
  const apps = detected.filter(a => /ios|ipados/i.test(String(a.platform||'')));
  const appleCatalog = mobileApps.filter(a => /ios|ipad/i.test(String(a['@odata.type']||'')) || /ios|ipad/i.test(String(a.platform||'')));
  const appRows = [...apps.map(a=>({id:`detected:${a.id}:${a.version||''}`,displayName:a.displayName,publisher:a.publisher,version:a.version,platform:a.platform,deviceCount:a.deviceCount,source:'Intune detected apps'})), ...appleCatalog.map(a=>({id:`catalog:${a.id}`,displayName:a.displayName,publisher:a.publisher,version:a.displayVersion||a.version,platform:'iOS/iPadOS',deviceCount:0,source:'Intune app catalog',managedAppId:a.id}))];
  const at = new Date().toISOString();
  for (const d of devices) await putRow('AppleDevices', user.tenantId, createHash('sha1').update(d.id).digest('hex'), { deviceId:d.id, deviceName:clean(d.deviceName), model:clean(d.model), osVersion:clean(d.osVersion), serialNumber:clean(d.serialNumber), ownership:clean(d.managedDeviceOwnerType), complianceState:clean(d.complianceState), lastSyncDateTime:clean(d.lastSyncDateTime), userPrincipalName:clean(d.userPrincipalName), syncedAt:at }, 'Replace');
  for (const a of appRows) await putRow('AppleApps', user.tenantId, createHash('sha1').update(a.id).digest('hex'), { detectedAppId:a.id, managedAppId:clean(a.managedAppId), displayName:clean(a.displayName), publisher:clean(a.publisher), version:clean(a.version), platform:clean(a.platform), deviceCount:Number(a.deviceCount)||0, source:a.source, syncedAt:at }, 'Replace');
  const oldDevices=await listRows('AppleDevices',user.tenantId,20000), keepDevices=new Set(devices.map(d=>createHash('sha1').update(d.id).digest('hex')));
  for(const old of oldDevices) if(!keepDevices.has(old.rowKey)) await deleteRow('AppleDevices',user.tenantId,old.rowKey);
  const oldApps=await listRows('AppleApps',user.tenantId,10000), keepApps=new Set(appRows.map(a=>createHash('sha1').update(a.id).digest('hex')));
  for(const old of oldApps) if(!keepApps.has(old.rowKey)) await deleteRow('AppleApps',user.tenantId,old.rowKey);
  await audit(user.tenantId,user.email||user.userId,'synced Apple inventory',`${devices.length} iOS/iPadOS devices; ${apps.length} detected apps; ${mobileApps.length} managed app catalog records checked`);
  return { devices:devices.length, apps:apps.length, catalogApps:appleCatalog.length, managedAppsChecked:mobileApps.length, syncedAt:at, note:'Detected app records are version observations, not proof that a newer compatible version is available. Intune mobile app catalog entries are checked separately.' };
}, 'admin') });

app.http('packageDraftCreate', { methods:['POST'], authLevel:'anonymous', route:'packaging/drafts', handler:withUser(async (req,_ctx,user) => {
  if (!['admin','owner'].includes(user.role)) throw new HttpError(403,'Only an organization Admin or Owner can create packaging drafts.');
  const b=await readJson(req); const name=clean(b.name,160), publisher=clean(b.publisher,160), installerType=clean(b.installerType,20).toLowerCase();
  if (!name || !['msi','exe'].includes(installerType)) throw new HttpError(400,'Enter an application name and a supported MSI or EXE installer type for the secure Windows packaging worker.');
  const sourceUrl=clean(b.sourceUrl,1000); if(sourceUrl && !/^https:\/\//i.test(sourceUrl)) throw new HttpError(400,'Installer URL must use HTTPS.');
  const id=randomUUID(), at=new Date().toISOString();
  const fields={ name,publisher,version:clean(b.version,80),installerType,sourceUrl,architecture:clean(b.architecture,20)||'unknown',installCommand:clean(b.installCommand,500),uninstallCommand:clean(b.uninstallCommand,500),detectionRule:clean(b.detectionRule,1000),detectionType:clean(b.detectionType,40),detectionPath:clean(b.detectionPath,500),detectionValue:clean(b.detectionValue,300),installContext:clean(b.installContext,30),restartBehavior:clean(b.restartBehavior,40),returnCodes:clean(b.returnCodes,1000),dependencies:JSON.stringify(Array.isArray(b.dependencies)?b.dependencies.filter(x=>x&&typeof x.id==='string').slice(0,50).map(x=>({id:x.id.slice(0,100),name:clean(x.name,160)})):[]),dependencyType:clean(b.dependencyType,40),supersedence:JSON.stringify(Array.isArray(b.supersedence)?b.supersedence.filter(x=>x&&typeof x.id==='string').slice(0,50).map(x=>({id:x.id.slice(0,100),name:clean(x.name,160)})):[]),uninstallSuperseded:!!b.uninstallSuperseded,detectionScript:clean(b.detectionScript,12000),deploymentSchedule:'manual',deploymentRings:'',notificationSettings:'',reportingNotes:'',notes:'',status:'draft',stage:'intake',createdAt:at,createdBy:clean(user.email||user.userId,200),uploadReceived:false,packagingExecuted:false };
  await putRow('PackageDrafts',user.tenantId,id,fields,'Replace'); await audit(user.tenantId,user.email||user.userId,'created packaging draft',`${name} (${installerType})`);
  return { id,...fields, message:'Packaging draft saved. No installer was uploaded, executed, scanned or converted.' };
}, 'admin') });

app.http('appleReportExcel', { methods:['GET'], authLevel:'anonymous', route:'apple/reports.xlsx', handler:withUser(async (_req,_ctx,user) => {
  const [devices,apps]=await Promise.all([listRows('AppleDevices',user.tenantId,20000),listRows('AppleApps',user.tenantId,10000)]);
  const wb=new ExcelJS.Workbook(); wb.creator='NexpatchOnline'; wb.created=new Date();
  const summary=wb.addWorksheet('Executive Summary'); summary.addRows([['NexpatchOnline | Apple Fleet Report'],['Generated',new Date().toISOString()],[],['Metric','Count'],['iOS/iPadOS devices',devices.length],['Compliant devices',devices.filter(x=>String(x.complianceState).toLowerCase()==='compliant').length],['Noncompliant devices',devices.filter(x=>String(x.complianceState).toLowerCase()==='noncompliant').length],['Detected app/version records',apps.length],['Apps with device installs',apps.filter(x=>Number(x.deviceCount)>0).length]]); summary.getRow(1).font={bold:true,size:16,color:{argb:'FF0E6B70'}}; summary.getColumn(1).width=34; summary.getColumn(2).width=32;
  const d=wb.addWorksheet('Apple Devices'); d.columns=[{header:'Device',key:'deviceName',width:28},{header:'Model',key:'model',width:26},{header:'OS version',key:'osVersion',width:16},{header:'Serial number',key:'serialNumber',width:22},{header:'Ownership',key:'ownership',width:16},{header:'Compliance',key:'complianceState',width:18},{header:'Primary user',key:'userPrincipalName',width:32},{header:'Last check-in',key:'lastSyncDateTime',width:28}]; d.addRows(devices); d.getRow(1).font={bold:true,color:{argb:'FFFFFFFF'}}; d.getRow(1).fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF16323A'}}; d.autoFilter='A1:H1';
  const a=wb.addWorksheet('Detected Apps'); a.columns=[{header:'Application',key:'displayName',width:32},{header:'Publisher',key:'publisher',width:28},{header:'Observed version',key:'version',width:20},{header:'Platform',key:'platform',width:16},{header:'Device count',key:'deviceCount',width:16},{header:'Source',key:'source',width:26}]; a.addRows(apps); a.getRow(1).font={bold:true,color:{argb:'FFFFFFFF'}}; a.getRow(1).fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF16323A'}}; a.autoFilter='A1:F1';
  const buf=await wb.xlsx.writeBuffer(); return {filename:`nexpatch-apple-fleet-${new Date().toISOString().slice(0,10)}.xlsx`,contentType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',base64:Buffer.from(buf).toString('base64')};
}, 'viewer') });
