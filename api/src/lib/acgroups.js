// Groups for App Control policy assignments. Pure helpers so the rules can be tested.
const GUID = /^\{?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}?$/i;
export const isGroupId = v => GUID.test(String(v || '').trim());
export const bareId = v => String(v || '').trim().replace(/[{}]/g, '').toLowerCase();

// Accepts what the page sends (ids, names, or {id,name} objects, possibly repeated) and what older saved
// settings hold (plain ids). Returns a clean list: [{ id } | { name }], no duplicates, at most 25.
export function normalizeGroupInputs(list) {
  const out = [], seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    const v = raw && typeof raw === 'object' ? (raw.id || raw.name || '') : raw;
    const s = String(v || '').trim().slice(0, 256);
    if (!s) continue;
    const item = isGroupId(s) ? { id: bareId(s) } : { name: s };
    const key = item.id ? 'id:' + item.id : 'name:' + item.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key); out.push(item);
    if (out.length >= 25) break;
  }
  return out;
}

// After assigning, Intune is asked what it saved. Every requested group must be there.
export function checkAssignments({ groupIds = [], allDevices = false }, saved = []) {
  const got = new Set(), all = saved.some(a => String(a?.target?.['@odata.type'] || '').endsWith('allDevicesAssignmentTarget'));
  for (const a of saved) if (a?.target?.groupId) got.add(bareId(a.target.groupId));
  const missing = groupIds.map(bareId).filter(id => !got.has(id));
  const ok = !missing.length && (!allDevices || all);
  return { ok, missing, allDevicesSaved: all, count: saved.length };
}
