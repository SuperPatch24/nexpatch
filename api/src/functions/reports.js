import { app } from '@azure/functions';
import ExcelJS from 'exceljs';
import { withUser, HttpError } from '../lib/http.js';
import { listRows, listAllTenants } from '../lib/store.js';
import { platformRole } from '../lib/platform.js';

async function collect(user){
  if(!['superadmin','support'].includes(platformRole(user))) throw new HttpError(403,'Your platform role cannot access platform reports.');
  const [catalog,tenants]=await Promise.all([listRows('Catalog','global',5000),listAllTenants()]);
  const requests=[]; const tenantRows=[];
  for(const t of tenants){const rs=await listRows('AppRequests',t.rowKey,1000);for(const r of rs)requests.push({tenantId:t.rowKey,id:r.rowKey,name:r.name,publisher:r.publisher||'',version:r.version||'',architecture:r.architecture||'unknown',status:r.status||'submitted',createdAt:r.createdAt||'',updatedAt:r.updatedAt||'',fileName:r.fileName||'',scanStatus:r.scanStatus||'not-uploaded'});tenantRows.push({tenantId:t.rowKey,status:t.status||'',plan:t.plan||'trial',activatedAt:t.activatedAt||'',lastSyncAt:t.lastSyncAt||''});}
  const apps=catalog.map(a=>({id:a.rowKey,name:a.name||'',publisher:a.vendor||'',wingetId:a.winget||'',category:a.category||'',enabled:a.enabled!==false,updatedAt:a.updatedAt||''}));
  const counts={catalog:apps.length,enabledApps:apps.filter(a=>a.enabled).length,organizations:tenantRows.length,requests:requests.length,pendingRequests:requests.filter(r=>!['published','rejected'].includes(r.status)).length};
  const byStatus={};for(const r of requests)byStatus[r.status]=(byStatus[r.status]||0)+1;
  return {generatedAt:new Date().toISOString(),counts,byStatus,apps,requests,tenants:tenantRows};
}
app.http('platformReports', {methods:['GET'],authLevel:'anonymous',route:'platform/reports',handler:withUser(async(_req,_ctx,user)=>collect(user),'any')});
app.http('platformReportsExcel', {methods:['GET'],authLevel:'anonymous',route:'platform/reports.xlsx',handler:withUser(async(_req,_ctx,user)=>{
  const data=await collect(user), wb=new ExcelJS.Workbook(); wb.creator='NexpatchOnline';wb.created=new Date();
  const summary=wb.addWorksheet('Summary');summary.addRows([['NexpatchOnline platform report'],['Generated',data.generatedAt],[],['Metric','Count'],['Catalog applications',data.counts.catalog],['Enabled applications',data.counts.enabledApps],['Connected organizations',data.counts.organizations],['Application requests',data.counts.requests],['Open requests',data.counts.pendingRequests],[],['Request status','Count'],...Object.entries(data.byStatus)]);summary.getRow(1).font={bold:true,size:16};summary.getColumn(1).width=30;summary.getColumn(2).width=28;
  const cat=wb.addWorksheet('Catalog');cat.columns=[{header:'ID',key:'id',width:32},{header:'Application',key:'name',width:32},{header:'Publisher',key:'publisher',width:28},{header:'WinGet ID',key:'wingetId',width:32},{header:'Category',key:'category',width:20},{header:'Enabled',key:'enabled',width:12},{header:'Updated',key:'updatedAt',width:26}];cat.addRows(data.apps);cat.getRow(1).font={bold:true};cat.autoFilter='A1:G1';
  const req=wb.addWorksheet('Requests');req.columns=[{header:'Organization ID',key:'tenantId',width:38},{header:'Request ID',key:'id',width:38},{header:'Application',key:'name',width:30},{header:'Publisher',key:'publisher',width:25},{header:'Version',key:'version',width:16},{header:'Architecture',key:'architecture',width:16},{header:'Status',key:'status',width:20},{header:'Submitted',key:'createdAt',width:26},{header:'Installer',key:'fileName',width:30},{header:'Scan status',key:'scanStatus',width:18}];req.addRows(data.requests);req.getRow(1).font={bold:true};req.autoFilter='A1:J1';
  const org=wb.addWorksheet('Organizations');org.columns=[{header:'Tenant ID',key:'tenantId',width:40},{header:'Status',key:'status',width:16},{header:'Plan',key:'plan',width:16},{header:'Activated',key:'activatedAt',width:26},{header:'Last sync',key:'lastSyncAt',width:26}];org.addRows(data.tenants);org.getRow(1).font={bold:true};org.autoFilter='A1:E1';
  const buf=await wb.xlsx.writeBuffer();return {filename:'nexpatch-platform-report-'+new Date().toISOString().slice(0,10)+'.xlsx',contentType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',base64:Buffer.from(buf).toString('base64')};
},'any')});
