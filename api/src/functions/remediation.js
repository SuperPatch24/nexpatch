import { app } from '@azure/functions';
import { withUser, HttpError, readJson } from '../lib/http.js';
import { listRows, putRow, getRow, audit } from '../lib/store.js';
import { platformRole } from '../lib/platform.js';

const TABLE = 'RemediationScripts';
const ID = /^[a-z0-9][a-z0-9-]{1,70}$/;
function requirePlatform(user) {
  if (!['superadmin', 'catalog'].includes(platformRole(user))) throw new HttpError(403, 'Only authorized NexpatchOnline platform administrators can manage remediation script definitions.');
}
const shape = r => ({ id:r.rowKey, name:r.name||'', description:r.description||'', category:r.category||'General', platform:r.platform||'Windows', scriptType:r.scriptType||'PowerShell', version:r.version||'1.0.0', approvalStatus:r.approvalStatus||'draft', content:r.content||'', updatedAt:r.updatedAt||null, updatedBy:r.updatedBy||'' });

// This phase manages script definitions and approval metadata only. It does not execute scripts.
app.http('platformRemediationList', { methods:['GET'], authLevel:'anonymous', route:'platform/remediation-scripts', handler:withUser(async(_req,_ctx,user)=>{ requirePlatform(user); return { scripts:(await listRows(TABLE,'global',1000)).map(shape).sort((a,b)=>a.name.localeCompare(b.name)) }; },'any') });
app.http('platformRemediationSave', { methods:['PUT'], authLevel:'anonymous', route:'platform/remediation-scripts/{id}', handler:withUser(async(req,_ctx,user)=>{
  requirePlatform(user); const id=String(req.params.id||'').toLowerCase(); if(!ID.test(id)) throw new HttpError(400,'Use a lowercase script ID with letters, numbers and dashes.');
  const b=await readJson(req); const name=String(b.name||'').trim().slice(0,120), content=String(b.content||'');
  if(!name) throw new HttpError(400,'Enter a script name.'); if(!content.trim()||content.length>65536) throw new HttpError(400,'Script content is required and must be 64 KB or smaller.');
  const prior=await getRow(TABLE,'global',id); const approvalStatus=prior?.approvalStatus==='approved'?'draft':(b.approvalStatus==='draft'?'draft':'draft');
  const row=await putRow(TABLE,'global',id,{name,description:String(b.description||'').slice(0,1000),category:String(b.category||'General').slice(0,60),platform:String(b.platform||'Windows').slice(0,40),scriptType:'PowerShell',version:String(b.version||'1.0.0').slice(0,30),approvalStatus,content,updatedAt:new Date().toISOString(),updatedBy:user.email||user.userId},'Replace');
  await audit('global',user.email||user.userId,'saved remediation script',`${name} (${id})`); return shape(row);
},'any') });
