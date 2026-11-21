// Automation rules: "add devices to a group a while after they enroll".
// Entra dynamic membership rules cannot express "2 hours after enrollment", so these rules keep an ordinary
// (assigned) security group up to date from a timer. This file has no storage or network code of its own: the
// Graph functions are passed in, so every decision here can be tested.

export const MAX_RULES = 10;
export const MAX_PER_RUN = 200;                       // devices added per rule per run; the rest wait for the next run
export const INTERVALS = [15, 30, 60, 120, 240, 720, 1440];   // minutes between checks (the timer ticks every 15)
export const MIN_DELAY = 0, MAX_DELAY = 60 * 24 * 90; // minutes: 0 to 90 days
export const OS_CHOICES = ['all', 'Windows', 'iOS', 'macOS', 'Android'];
export const OWNER_CHOICES = ['all', 'company', 'personal'];
export const SCOPES = ['new', 'all'];                 // new = only devices enrolled after the rule was created
const ZERO_GUID = '00000000-0000-0000-0000-000000000000';
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isGuid = v => GUID.test(String(v || ''));

export const ruleId = () => 'r' + Math.random().toString(36).slice(2, 10);
export const doneKey = (tenantId, id) => `${tenantId}_${id}`;

// Validates the editable fields of a rule. Returns { error } or { fields }.
export function cleanRule(b = {}, { partial = false } = {}) {
  const f = {};
  const has = k => b[k] !== undefined;
  if (!partial || has('name')) {
    const name = String(b.name || '').trim().slice(0, 80);
    if (!name) return { error: 'Give the rule a name.' };
    f.name = name;
  }
  if (!partial || has('delayMinutes')) {
    const d = Math.floor(Number(b.delayMinutes));
    if (!Number.isFinite(d) || d < MIN_DELAY || d > MAX_DELAY) return { error: 'Choose a delay between 0 minutes and 90 days.' };
    f.delayMinutes = d;
  }
  if (!partial || has('intervalMinutes')) {
    const i = Math.floor(Number(b.intervalMinutes));
    if (!INTERVALS.includes(i)) return { error: 'Check every 15, 30 or 60 minutes, or every 2, 4, 12 or 24 hours.' };
    f.intervalMinutes = i;
  }
  if (!partial || has('os')) { if (!OS_CHOICES.includes(b.os || 'all')) return { error: 'Choose All, Windows, iOS, macOS or Android.' }; f.os = b.os || 'all'; }
  if (!partial || has('ownership')) { if (!OWNER_CHOICES.includes(b.ownership || 'all')) return { error: 'Choose all, company-owned or personal devices.' }; f.ownership = b.ownership || 'all'; }
  if (!partial || has('scope')) { if (!SCOPES.includes(b.scope || 'new')) return { error: 'Choose new devices only, or all devices.' }; f.scope = b.scope || 'new'; }
  if (has('enabled')) f.enabled = b.enabled === true;
  else if (!partial) f.enabled = true;
  return { fields: f };
}

// A rule is due when it is on and at least one interval has passed (a minute and a half of timer jitter is allowed).
export function isDue(rule, now = Date.now()) {
  if (!rule || rule.enabled === false || rule.enabled === 'false') return false;
  if (rule.lockUntil && Date.parse(rule.lockUntil) > now) return false;
  if (!rule.lastRunAt) return true;
  return now - Date.parse(rule.lastRunAt) >= (Number(rule.intervalMinutes) || 15) * 60000 - 90000;
}

const osOf = d => String(d.operatingSystem || '').toLowerCase();
const isCompany = d => String(d.managedDeviceOwnerType || '').toLowerCase() === 'company';
const isPersonal = d => String(d.managedDeviceOwnerType || '').toLowerCase() === 'personal';

// Which Intune devices should be added right now. `done` is the set of Intune device ids this rule already handled.
export function selectEligible(devices, rule, done = new Set(), now = Date.now()) {
  const delay = (Number(rule.delayMinutes) || 0) * 60000;
  const since = rule.scope === 'all' ? 0 : Date.parse(rule.createdAt || 0) || 0;
  const out = [];
  for (const d of devices || []) {
    if (!d?.id || done.has(d.id)) continue;
    if (!isGuid(d.azureADDeviceId) || d.azureADDeviceId === ZERO_GUID) continue;   // not registered in Entra (yet)
    const enrolled = Date.parse(d.enrolledDateTime || '');
    if (!Number.isFinite(enrolled) || enrolled < since) continue;
    if (now - enrolled < delay) continue;
    if (rule.os && rule.os !== 'all' && osOf(d) !== String(rule.os).toLowerCase()) continue;
    if (rule.ownership === 'company' && !isCompany(d)) continue;
    if (rule.ownership === 'personal' && !isPersonal(d)) continue;
    out.push(d);
  }
  return out.sort((a, b) => Date.parse(a.enrolledDateTime) - Date.parse(b.enrolledDateTime));
}

// When will a device that enrolled at `enrolledAt` be picked up? (delay, then the next check)
export const eligibleAt = (enrolledAt, rule) => new Date(Date.parse(enrolledAt) + (Number(rule.delayMinutes) || 0) * 60000).toISOString();

const dirRef = id => `https://graph.microsoft.com/v1.0/directoryObjects/${id}`;
const chunks = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };

// Only assigned (static) security groups can have devices added by hand.
export function groupProblem(g) {
  if (!g || !g.id) return 'That group wasn’t found.';
  if ((g.groupTypes || []).includes('DynamicMembership')) return 'That is a dynamic group, so its members are decided by a rule and can’t be added to. Pick an assigned security group, or let NexpatchOnline create one.';
  if ((g.groupTypes || []).includes('Unified') || g.securityEnabled !== true) return 'Devices can only be added to security groups. Pick a security group.';
  if (g.onPremisesSyncEnabled === true) return 'That group is synced from on-premises Active Directory and can’t be changed here.';
  if (g.isAssignableToRole === true) return 'That group can be assigned to Entra roles, so NexpatchOnline won’t change its members.';
  return '';
}

export const PERMISSION_HELP = 'The Automation permissions haven\u2019t been approved in this organization yet. An administrator can approve them on the Connect page, under Automation.';

// Runs one rule. deps = { graph, graphAll } for the customer's tenant. Returns what happened; the caller stores it.
// dryRun lists who would be added without changing anything.
export async function runRule({ graph, graphAll }, rule, done, { now = Date.now(), dryRun = false } = {}) {
  const res = { checked: 0, eligible: 0, added: [], skippedMember: [], notInEntra: 0, remaining: 0, wouldAdd: [] };
  const devices = await graphAll('/v1.0/deviceManagement/managedDevices?$select=id,deviceName,azureADDeviceId,operatingSystem,enrolledDateTime,managedDeviceOwnerType&$top=999');
  res.checked = devices.length;
  const eligible = selectEligible(devices, rule, done, now);
  res.eligible = eligible.length;
  if (!eligible.length) return res;

  const batch = eligible.slice(0, MAX_PER_RUN);
  res.remaining = eligible.length - batch.length;

  const grp = await graph(`/v1.0/groups/${encodeURIComponent(rule.groupId)}?$select=id,displayName,groupTypes,securityEnabled,onPremisesSyncEnabled,isAssignableToRole`).catch(e => { if (e.status === 404 || /\(404\)|not found|does not exist/i.test(e.message)) return null; throw e; });
  const problem = groupProblem(grp);
  if (problem) { const e = new Error(problem); e.status = 409; e.groupGone = !grp; throw e; }

  // Entra device object ids (Intune knows the device id; groups need the directory object id)
  const objectOf = new Map();
  for (const part of chunks(batch, 20)) {
    const r = await graph('/v1.0/$batch', { method: 'POST', body: JSON.stringify({ requests: part.map((d, i) => ({ id: String(i), method: 'GET', url: `/devices?$filter=deviceId eq '${d.azureADDeviceId}'&$select=id,deviceId` })) }) });
    for (const x of r?.responses || []) {
      const d = part[Number(x.id)];
      const v = x.status === 200 ? x.body?.value?.[0] : null;
      if (d && v?.id) objectOf.set(d.id, v.id);
      else if (d && x.status === 403) { const e = new Error(PERMISSION_HELP); e.status = 403; throw e; }
    }
  }
  const members = new Set((await graphAll(`/v1.0/groups/${encodeURIComponent(rule.groupId)}/members?$select=id&$top=999`)).map(m => m.id));

  const toAdd = [];
  for (const d of batch) {
    const oid = objectOf.get(d.id);
    if (!oid) { res.notInEntra++; continue; }            // not visible in Entra yet: try again on the next run
    if (members.has(oid)) { res.skippedMember.push({ id: d.id, name: d.deviceName || '' }); continue; }
    toAdd.push({ d, oid });
  }
  if (dryRun) { res.wouldAdd = toAdd.map(x => ({ id: x.d.id, name: x.d.deviceName || '', enrolledAt: x.d.enrolledDateTime })); return res; }

  for (const part of chunks(toAdd, 20)) {
    try {
      await graph(`/v1.0/groups/${encodeURIComponent(rule.groupId)}`, { method: 'PATCH', body: JSON.stringify({ 'members@odata.bind': part.map(x => dirRef(x.oid)) }) });
      for (const x of part) res.added.push({ id: x.d.id, name: x.d.deviceName || '' });
    } catch (err) {
      if (err.status === 403) { const e = new Error(PERMISSION_HELP); e.status = 403; throw e; }
      for (const x of part) {                              // one device at a time, so one bad device doesn't block the rest
        try { await graph(`/v1.0/groups/${encodeURIComponent(rule.groupId)}/members/$ref`, { method: 'POST', body: JSON.stringify({ '@odata.id': dirRef(x.oid) }) }); res.added.push({ id: x.d.id, name: x.d.deviceName || '' }); }
        catch (e2) { if (/already exist/i.test(e2.message)) res.skippedMember.push({ id: x.d.id, name: x.d.deviceName || '' }); else if (e2.status === 403) { const e = new Error(PERMISSION_HELP); e.status = 403; throw e; } else res.failed = (res.failed || 0) + 1; }
      }
    }
  }
  return res;
}

export function summarize(res) {
  if (!res) return '';
  const bits = [];
  bits.push(res.added.length ? `Added ${res.added.length} device${res.added.length === 1 ? '' : 's'}` : 'Nothing to add');
  if (res.skippedMember.length) bits.push(`${res.skippedMember.length} already in the group`);
  if (res.notInEntra) bits.push(`${res.notInEntra} not in Entra yet`);
  if (res.failed) bits.push(`${res.failed} failed`);
  if (res.remaining) bits.push(`${res.remaining} more next run`);
  return bits.join(', ') + '.';
}
