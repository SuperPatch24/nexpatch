import { app } from '@azure/functions';
import { randomUUID } from 'node:crypto';
import { BlobServiceClient, BlobSASPermissions, StorageSharedKeyCredential, generateBlobSASQueryParameters } from '@azure/storage-blob';
import { DefaultAzureCredential } from '@azure/identity';
import { withUser, HttpError, readJson } from '../lib/http.js';
import { putRow, getRow, listRows, listAllTenants, audit } from '../lib/store.js';
import { platformRole } from '../lib/platform.js';
import { escapeHtml, notifyPlatformAdmins, sendBrevoEmail } from '../lib/email.js';

const CONTAINER = 'nexpatch-request-installers';
const MAX_BYTES = 50 * 1024 * 1024;
const STATUSES = new Set(['submitted','under-review','need-information','packaging','testing','approved','published','rejected']);
let blobService;
function service() {
  if (blobService) return blobService;
  if (process.env.BLOB_STORAGE_CONNECTION) blobService = BlobServiceClient.fromConnectionString(process.env.BLOB_STORAGE_CONNECTION);
  else if (process.env.BLOB_STORAGE_URL) blobService = new BlobServiceClient(process.env.BLOB_STORAGE_URL, new DefaultAzureCredential());
  else throw new HttpError(503, 'Installer uploads are not configured. Set BLOB_STORAGE_CONNECTION or BLOB_STORAGE_URL.');
  return blobService;
}
const shape = r => ({ id:r.rowKey, tenantId:r.partitionKey, name:r.name, publisher:r.publisher||'', website:r.website||'', downloadUrl:r.downloadUrl||'', version:r.version||'', architecture:r.architecture||'unknown', notes:r.notes||'', status:r.status||'submitted', adminNotes:r.adminNotes||'', createdAt:r.createdAt, updatedAt:r.updatedAt||r.createdAt, fileName:r.fileName||'', fileSize:r.fileSize||0, fileType:r.fileType||'', scanStatus:r.scanStatus||'not-uploaded' });

app.http('requestCreate', { methods:['POST'], authLevel:'anonymous', route:'requests', handler:withUser(async(req,_ctx,user)=>{
  const b=await readJson(req); const name=String(b.name||'').trim().slice(0,160);
  if(!name) throw new HttpError(400,'Enter the application name.');
  const downloadUrl=String(b.downloadUrl||'').trim().slice(0,2048);
  if(downloadUrl && !/^https:\/\//i.test(downloadUrl)) throw new HttpError(400,'Download links must use HTTPS.');
  const id=randomUUID(), now=new Date().toISOString();
  const row={name,publisher:String(b.publisher||'').trim().slice(0,160),website:String(b.website||'').trim().slice(0,2048),downloadUrl,version:String(b.version||'').trim().slice(0,80),architecture:String(b.architecture||'unknown').slice(0,20),notes:String(b.notes||'').trim().slice(0,3000),status:'submitted',adminNotes:'',createdAt:now,updatedAt:now,requestedBy:user.email||user.userId,scanStatus:'not-uploaded'};
  await putRow('AppRequests',user.tenantId,id,row,'Replace');
  await audit(user.tenantId,user.email||user.userId,'submitted application request',name);
  const safeName=escapeHtml(name);
  if (user.email) await sendBrevoEmail({to:user.email,subject:`Application request received: ${name}`,htmlContent:`<p>Hi ${escapeHtml(user.name || '')},</p><p>We received your request for <strong>${safeName}</strong>.</p><p>You can track its progress in your NexpatchOnline dashboard.</p>`,textContent:`We received your request for ${name}. You can track its progress in your NexpatchOnline dashboard.`,tags:['application-request','client-confirmation']},_ctx);
  await notifyPlatformAdmins({subject:`New application request: ${name}`,htmlContent:`<p>A client submitted a new application request.</p><p><strong>Application:</strong> ${safeName}</p><p><strong>Publisher:</strong> ${escapeHtml(row.publisher)}</p><p><strong>Requester:</strong> ${escapeHtml(user.email || user.userId)}</p><p>Review it in the NexpatchOnline Admin Center.</p>`,textContent:`New application request: ${name}. Requester: ${user.email || user.userId}.`},_ctx);
  return {request:shape({partitionKey:user.tenantId,rowKey:id,...row})};
},'viewer') });

app.http('requestList', { methods:['GET'], authLevel:'anonymous', route:'requests', handler:withUser(async(_req,_ctx,user)=>({requests:(await listRows('AppRequests',user.tenantId,500)).map(shape).sort((a,b)=>b.createdAt.localeCompare(a.createdAt))}),'viewer') });

app.http('requestUpload', { methods:['PUT'], authLevel:'anonymous', route:'requests/{id}/file', handler:withUser(async(req,_ctx,user)=>{
  const id=String(req.params.id||''); const row=await getRow('AppRequests',user.tenantId,id); if(!row) throw new HttpError(404,'Request not found.');
  const type=(req.headers.get('content-type')||'application/octet-stream').split(';')[0].toLowerCase();
  const name=decodeURIComponent(req.headers.get('x-file-name')||'installer.bin').replace(/[\\/]/g,'_').slice(0,180);
  const len=Number(req.headers.get('content-length')||0); if(len>MAX_BYTES) throw new HttpError(413,'Installer files must be 50 MB or smaller.');
  const bytes=Buffer.from(await req.arrayBuffer()); if(!bytes.length||bytes.length>MAX_BYTES) throw new HttpError(413,'Installer file is empty or exceeds 50 MB.');
  const allowed=/\.(msi|msix|appx|exe|zip|intunewin)$/i; if(!allowed.test(name)) throw new HttpError(400,'Supported installer extensions: MSI, MSIX, APPX, EXE, ZIP and INTUNEWIN.');
  const container=service().getContainerClient(CONTAINER); await container.createIfNotExists();
  const blobName=`${user.tenantId}/${id}/${randomUUID()}-${name}`; const blob=container.getBlockBlobClient(blobName);
  await blob.uploadData(bytes,{blobHTTPHeaders:{blobContentType:'application/octet-stream'},metadata:{tenant:user.tenantId,request:id,originalname:Buffer.from(name).toString('base64').slice(0,200)}});
  await putRow('AppRequests',user.tenantId,id,{blobName,fileName:name,fileSize:bytes.length,fileType:type,scanStatus:'pending',updatedAt:new Date().toISOString()});
  await audit(user.tenantId,user.email||user.userId,'uploaded installer for request',name);
  return {uploaded:true,fileName:name,fileSize:bytes.length,scanStatus:'pending'};
},'viewer') });

app.http('platformRequests', { methods:['GET'], authLevel:'anonymous', route:'platform/requests', handler:withUser(async(_req,_ctx,user)=>{
  if(!['superadmin','support'].includes(platformRole(user))) throw new HttpError(403,'Your platform role cannot view client requests.');
  const all=[]; for(const t of await listAllTenants()) for(const r of await listRows('AppRequests',t.rowKey,1000)) all.push(shape(r));
  return {requests:all.sort((a,b)=>b.createdAt.localeCompare(a.createdAt))};
},'any') });

app.http('platformRequestUpdate', { methods:['PUT'], authLevel:'anonymous', route:'platform/requests/{tenantId}/{id}', handler:withUser(async(req,_ctx,user)=>{
  if(!['superadmin','support'].includes(platformRole(user))) throw new HttpError(403,'Your platform role cannot update client requests.');
  const tid=String(req.params.tenantId||''), id=String(req.params.id||''), row=await getRow('AppRequests',tid,id); if(!row) throw new HttpError(404,'Request not found.');
  const b=await readJson(req), status=String(b.status||row.status); if(!STATUSES.has(status)) throw new HttpError(400,'Choose a valid request status.');
  const adminNotes=String(b.adminNotes??row.adminNotes??'').slice(0,3000), scanStatus=String(b.scanStatus??row.scanStatus??'not-uploaded');
  if(!['not-uploaded','pending','clean','rejected'].includes(scanStatus)) throw new HttpError(400,'Choose a valid installer scan status.');
  if(scanStatus==='clean' && row.blobName && b.scanConfirmation!==true) throw new HttpError(400,'Confirm that the uploaded installer was scanned with your approved malware scanner.');
  const now=new Date().toISOString();
  await putRow('AppRequests',tid,id,{status,adminNotes,scanStatus,updatedAt:now,updatedBy:user.email||user.userId});
  await audit(tid,user.email||user.userId,'updated application request',`${row.name}: ${status}`);
  if (row.requestedBy && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.requestedBy)) await sendBrevoEmail({to:row.requestedBy,subject:`Application request update: ${row.name}`,htmlContent:`<p>Your application request for <strong>${escapeHtml(row.name)}</strong> has been updated.</p><p><strong>New status:</strong> ${escapeHtml(status.replaceAll('-', ' '))}</p>${adminNotes ? `<p><strong>Team note:</strong> ${escapeHtml(adminNotes)}</p>` : ''}<p>Sign in to NexpatchOnline to view your request.</p>`,textContent:`Your request for ${row.name} is now ${status.replaceAll('-', ' ')}. ${adminNotes ? `Team note: ${adminNotes}` : ''}`,tags:['application-request','status-update']},_ctx);
  return {request:shape({...row,partitionKey:tid,rowKey:id,status,adminNotes,scanStatus,updatedAt:now})};
},'any') });


app.http('platformRequestFile', { methods:['GET'], authLevel:'anonymous', route:'platform/requests/{tenantId}/{id}/file', handler:withUser(async(req,_ctx,user)=>{
  if(!['superadmin','support'].includes(platformRole(user))) throw new HttpError(403,'Your platform role cannot access uploaded installers.');
  const tid=String(req.params.tenantId||''),id=String(req.params.id||''),row=await getRow('AppRequests',tid,id);
  if(!row||!row.blobName) throw new HttpError(404,'No installer was uploaded for this request.');
  const container=service().getContainerClient(CONTAINER),blob=container.getBlockBlobClient(row.blobName);
  const start=new Date(Date.now()-60_000),end=new Date(Date.now()+5*60_000);let sas;
  const conn=process.env.BLOB_STORAGE_CONNECTION||'';
  const parts=Object.fromEntries(conn.split(';').map(x=>{const i=x.indexOf('=');return i>0?[x.slice(0,i),x.slice(i+1)]:['','']}));
  if(parts.AccountName&&parts.AccountKey){const cred=new StorageSharedKeyCredential(parts.AccountName,parts.AccountKey);sas=generateBlobSASQueryParameters({containerName:CONTAINER,blobName:row.blobName,permissions:BlobSASPermissions.parse('r'),startsOn:start,expiresOn:end},cred).toString();}
  else {const account=process.env.BLOB_STORAGE_ACCOUNT_NAME||new URL(process.env.BLOB_STORAGE_URL).hostname.split('.')[0];const key=await service().getUserDelegationKey(start,end);sas=generateBlobSASQueryParameters({containerName:CONTAINER,blobName:row.blobName,permissions:BlobSASPermissions.parse('r'),startsOn:start,expiresOn:end},key,account).toString();}
  await audit(tid,user.email||user.userId,'generated installer download link',row.fileName||id);
  return {url:blob.url+'?'+sas,expiresAt:end.toISOString(),fileName:row.fileName||'installer'};
},'any') });
