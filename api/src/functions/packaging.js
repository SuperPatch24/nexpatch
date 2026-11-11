import { app } from '@azure/functions';
import { randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { BlobServiceClient, BlobSASPermissions, StorageSharedKeyCredential, generateBlobSASQueryParameters } from '@azure/storage-blob';
import { QueueClient } from '@azure/storage-queue';
import { DefaultAzureCredential } from '@azure/identity';
import { withUser, HttpError, readJson } from '../lib/http.js';
import { getRow, putRow, listRows, audit } from '../lib/store.js';

const CONTAINER='nexpatch-packaging-quarantine';
const QUEUE='nexpatch-packaging-jobs';
const MAX_BYTES=2*1024*1024*1024;
let blobs, queue;
function blobService(){ if(blobs)return blobs; if(process.env.BLOB_STORAGE_CONNECTION) blobs=BlobServiceClient.fromConnectionString(process.env.BLOB_STORAGE_CONNECTION); else if(process.env.BLOB_STORAGE_URL) blobs=new BlobServiceClient(process.env.BLOB_STORAGE_URL,new DefaultAzureCredential()); else throw new HttpError(503,'Private packaging storage is not configured.'); return blobs; }
function queueClient(){ if(queue)return queue; if(process.env.BLOB_STORAGE_CONNECTION) queue=new QueueClient(process.env.BLOB_STORAGE_CONNECTION,QUEUE); else if(process.env.QUEUE_STORAGE_CONNECTION) queue=new QueueClient(process.env.QUEUE_STORAGE_CONNECTION,QUEUE); else throw new HttpError(503,'Packaging queue storage is not configured.'); return queue; }
function safeName(v){const n=String(v||'installer').replace(/[\\/\x00-\x1f]/g,'_').slice(0,160); if(!/\.(msi|exe)$/i.test(n)) throw new HttpError(400,'Only MSI and EXE installers are accepted by the first packaging worker release.'); return n;}
function sasFor(containerName,blobName,permissions,startsOn,expiresOn){
 const conn=process.env.BLOB_STORAGE_CONNECTION||''; const parts=Object.fromEntries(conn.split(';').map(x=>{const i=x.indexOf('=');return i>0?[x.slice(0,i),x.slice(i+1)]:['','']}));
 if(parts.AccountName&&parts.AccountKey){const cred=new StorageSharedKeyCredential(parts.AccountName,parts.AccountKey);return generateBlobSASQueryParameters({containerName,blobName,permissions:BlobSASPermissions.parse(permissions),startsOn,expiresOn},cred).toString();}
 return null;
}
app.http('packagingUploadSession',{methods:['POST'],authLevel:'anonymous',route:'packaging/drafts/{id}/upload-session',handler:withUser(async(req,_ctx,user)=>{
 if(!['admin','owner'].includes(user.role))throw new HttpError(403,'Only an organization Admin or Owner can upload installers.');
 const id=String(req.params.id||''), row=await getRow('PackageDrafts',user.tenantId,id); if(!row)throw new HttpError(404,'Packaging draft not found.'); if(row.jobId)throw new HttpError(409,'This draft already has a packaging job. Create a new draft for another build.');
 if(!['msi','exe'].includes(String(row.installerType).toLowerCase()))throw new HttpError(400,'The first secure worker release supports MSI and EXE source installers only.');
 const b=await readJson(req), fileName=safeName(b.fileName), fileSize=Number(b.fileSize); if(!fileName.toLowerCase().endsWith(`.${String(row.installerType).toLowerCase()}`))throw new HttpError(400,'The uploaded file extension must match the selected installer type.'); if(!Number.isSafeInteger(fileSize)||fileSize<1||fileSize>MAX_BYTES)throw new HttpError(413,'Installer must be between 1 byte and 2 GB.');
 const active=(await listRows('PackageDrafts',user.tenantId,500)).filter(x=>['upload-pending','queued','scanning','packaging'].includes(String(x.status||''))); if(active.length>=5)throw new HttpError(429,'Your organization already has five active packaging uploads/jobs. Wait for one to finish before starting another.');
 const container=blobService().getContainerClient(CONTAINER); await container.createIfNotExists();
 const blobName=`${user.tenantId}/${id}/${randomUUID()}-${fileName}`, blob=container.getBlockBlobClient(blobName);
 const start=new Date(Date.now()-60_000),end=new Date(Date.now()+15*60_000); let sas=sasFor(CONTAINER,blobName,'cw',start,end);
 if(!sas){const key=await blobService().getUserDelegationKey(start,end); const account=process.env.BLOB_STORAGE_ACCOUNT_NAME||new URL(process.env.BLOB_STORAGE_URL).hostname.split('.')[0]; sas=generateBlobSASQueryParameters({containerName:CONTAINER,blobName,permissions:BlobSASPermissions.parse('cw'),startsOn:start,expiresOn:end},key,account).toString();}
 await putRow('PackageDrafts',user.tenantId,id,{stage:'upload-authorized',uploadBlobName:blobName,uploadFileName:fileName,uploadExpectedBytes:fileSize,uploadExpiresAt:end.toISOString(),status:'upload-pending',updatedAt:new Date().toISOString()});
 return {uploadUrl:`${blob.url}?${sas}`,blobName,fileName,expiresAt:end.toISOString(),headers:{'x-ms-blob-type':'BlockBlob','Content-Type':'application/octet-stream'},maxBytes:MAX_BYTES};
},'admin')});

app.http('packagingFinalizeUpload',{methods:['POST'],authLevel:'anonymous',route:'packaging/drafts/{id}/finalize-upload',handler:withUser(async(req,_ctx,user)=>{
 if(!['admin','owner'].includes(user.role))throw new HttpError(403,'Only an organization Admin or Owner can finalize uploads.');
 const id=String(req.params.id||''),row=await getRow('PackageDrafts',user.tenantId,id); if(!row||!row.uploadBlobName)throw new HttpError(404,'No active installer upload was found.'); if(row.jobId)throw new HttpError(409,'This upload has already been queued.');
 if(new Date(row.uploadExpiresAt)<new Date())throw new HttpError(410,'Upload session expired. Start a new upload.');
 const blob=blobService().getContainerClient(CONTAINER).getBlockBlobClient(row.uploadBlobName); let props; try{props=await blob.getProperties();}catch{throw new HttpError(400,'Installer upload is not present in private quarantine storage.');}
 if(Number(props.contentLength)!==Number(row.uploadExpectedBytes)||props.contentLength>MAX_BYTES)throw new HttpError(400,'Uploaded file size does not match the authorized upload.');
 const dl=await blob.download(0),hash=createHash('sha256'); for await(const chunk of dl.readableStreamBody)hash.update(chunk); const sha256=hash.digest('hex');
 const jobId=randomUUID(),now=new Date().toISOString();
 const job={jobId,draftId:id,tenantId:user.tenantId,blobName:row.uploadBlobName,fileName:row.uploadFileName,fileSize:Number(props.contentLength),sha256,installerType:row.installerType,installCommand:String(row.installCommand||''),uninstallCommand:String(row.uninstallCommand||''),detectionRule:String(row.detectionRule||''),detectionType:String(row.detectionType||''),detectionPath:String(row.detectionPath||''),detectionValue:String(row.detectionValue||''),installContext:String(row.installContext||''),restartBehavior:String(row.restartBehavior||''),returnCodes:String(row.returnCodes||''),dependencies:String(row.dependencies||''),supersedence:String(row.supersedence||''),deploymentSchedule:String(row.deploymentSchedule||''),deploymentRings:String(row.deploymentRings||''),notificationSettings:String(row.notificationSettings||''),reportingNotes:String(row.reportingNotes||''),name:String(row.name||''),publisher:String(row.publisher||''),version:String(row.version||''),architecture:String(row.architecture||'unknown'),status:'queued',stage:'queued',createdAt:now,updatedAt:now,requestedBy:user.email||user.userId};
 await putRow('PackagingJobs',user.tenantId,jobId,job,'Replace'); await putRow('PackageDrafts',user.tenantId,id,{status:'queued',stage:'quarantine',jobId,sha256,uploadFileSize:Number(props.contentLength),updatedAt:now});
 const manifestContainer=blobService().getContainerClient('nexpatch-packaging-manifests'); await manifestContainer.createIfNotExists(); await manifestContainer.getBlockBlobClient(`${user.tenantId}/${jobId}.json`).uploadData(Buffer.from(JSON.stringify({tenantId:user.tenantId,jobId,blobName:row.uploadBlobName,fileName:row.uploadFileName,sha256,fileSize:Number(props.contentLength),installerType:row.installerType,installCommand:String(row.installCommand||''),uninstallCommand:String(row.uninstallCommand||''),detectionType:String(row.detectionType||''),detectionPath:String(row.detectionPath||''),detectionValue:String(row.detectionValue||''),installContext:String(row.installContext||''),restartBehavior:String(row.restartBehavior||''),returnCodes:String(row.returnCodes||''),dependencies:String(row.dependencies||''),supersedence:String(row.supersedence||''),deploymentSchedule:String(row.deploymentSchedule||''),deploymentRings:String(row.deploymentRings||''),notificationSettings:String(row.notificationSettings||''),reportingNotes:String(row.reportingNotes||''),name:String(row.name||''),version:String(row.version||'')})),{blobHTTPHeaders:{blobContentType:'application/json'}});
 await queueClient().createIfNotExists(); await queueClient().sendMessage(Buffer.from(JSON.stringify({tenantId:user.tenantId,jobId})).toString('base64'));
 await audit(user.tenantId,user.email||user.userId,'queued secure installer packaging',`${row.name} (${row.uploadFileName}), SHA256 ${sha256}`);
 return {jobId,status:'queued',sha256,message:'Upload verified and queued. No installer has executed on the API service.'};
},'admin')});

app.http('packagingJobs',{methods:['GET'],authLevel:'anonymous',route:'packaging/jobs',handler:withUser(async(_req,_ctx,user)=>({jobs:(await listRows('PackagingJobs',user.tenantId,500)).sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt))).map(j=>({id:j.rowKey,draftId:j.draftId,name:j.name,fileName:j.fileName,status:j.status,stage:j.stage,sha256:j.sha256,signatureStatus:j.signatureStatus,signatureSubject:j.signatureSubject,artifactSha256:j.artifactSha256,scanStatus:j.scanStatus,packageStatus:j.packageStatus,testStatus:j.testStatus,createdAt:j.createdAt,updatedAt:j.updatedAt,artifactName:j.artifactName,error:j.error}))}),'viewer')});

app.http('packagingWorkerComplete',{methods:['POST'],authLevel:'anonymous',route:'packaging/worker/jobs/{id}/complete',handler:async(req,ctx)=>{
 const expected=process.env.PACKAGING_WORKER_TOKEN||'',provided=req.headers.get('x-packaging-worker-token')||''; if(!expected||!provided||Buffer.byteLength(expected)!==Buffer.byteLength(provided)||!timingSafeEqual(Buffer.from(expected),Buffer.from(provided)))return {status:401,jsonBody:{error:'Worker authentication failed.'}};
 try{const b=await readJson(req),tenantId=String(b.tenantId||''),jobId=String(req.params.id||''),job=await getRow('PackagingJobs',tenantId,jobId);if(!job)return {status:404,jsonBody:{error:'Packaging job not found.'}};
 const allowed=new Set(['scan-failed','signature-rejected','packaged-awaiting-test','test-passed','test-failed','worker-error']);if(!allowed.has(b.status))return {status:400,jsonBody:{error:'Invalid worker status.'}};
 const now=new Date().toISOString(),fields={status:b.status,stage:String(b.stage||b.status).slice(0,80),scanStatus:String(b.scanStatus||'unknown').slice(0,40),signatureStatus:String(b.signatureStatus||'unknown').slice(0,80),packageStatus:String(b.packageStatus||'not-created').slice(0,40),testStatus:String(b.testStatus||'not-run').slice(0,40),artifactBlobName:String(b.artifactBlobName||'').slice(0,500),artifactName:String(b.artifactName||'').slice(0,180),artifactSha256:String(b.artifactSha256||'').slice(0,64),signatureSubject:String(b.signatureSubject||'').slice(0,300),workerSha256:String(b.sha256||'').slice(0,64),error:String(b.error||'').slice(0,1500),updatedAt:now,workerCompletedAt:now};
 await putRow('PackagingJobs',tenantId,jobId,fields);await putRow('PackageDrafts',tenantId,job.draftId,{status:b.status,stage:fields.stage,scanStatus:fields.scanStatus,signatureStatus:fields.signatureStatus,packageStatus:fields.packageStatus,testStatus:fields.testStatus,artifactName:fields.artifactName,updatedAt:now});await audit(tenantId,'packaging-worker','packaging worker result',`${job.name}: ${b.status}; scan=${fields.scanStatus}; test=${fields.testStatus}`);return {status:200,jsonBody:{updated:true}};
 }catch(e){ctx.error('Packaging worker callback failed',e);return {status:500,jsonBody:{error:'Worker callback failed.'}};}
}});

app.http('packagingArtifactDownload',{methods:['GET'],authLevel:'anonymous',route:'packaging/jobs/{id}/artifact',handler:withUser(async(req,_ctx,user)=>{
 const job=await getRow('PackagingJobs',user.tenantId,String(req.params.id||''));if(!job||!job.artifactBlobName)throw new HttpError(404,'No packaged artifact is available for this job.');
 const containerName='nexpatch-packaging-artifacts',blob=blobService().getContainerClient(containerName).getBlockBlobClient(job.artifactBlobName),start=new Date(Date.now()-60_000),end=new Date(Date.now()+5*60_000);let sas=sasFor(containerName,job.artifactBlobName,'r',start,end);
 if(!sas){const key=await blobService().getUserDelegationKey(start,end),account=process.env.BLOB_STORAGE_ACCOUNT_NAME||new URL(process.env.BLOB_STORAGE_URL).hostname.split('.')[0];sas=generateBlobSASQueryParameters({containerName,blobName:job.artifactBlobName,permissions:BlobSASPermissions.parse('r'),startsOn:start,expiresOn:end},key,account).toString();}
 return {url:`${blob.url}?${sas}`,fileName:job.artifactName,expiresAt:end.toISOString(),status:job.status,testStatus:job.testStatus||'not-run'};
},'admin')});
