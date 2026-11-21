// Catalog entries that belong to one company. They live in that company's own partition of the Catalog table,
// so the shared catalog ('global') and other companies never see them.
const WINGET_ID = /^[A-Za-z0-9][A-Za-z0-9.+_-]{1,100}$/;
export const TENANT_ID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export const privateId = (name, winget) => 'p-' + String(winget || name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 70);

export function cleanPrivateApp(b = {}) {
  const name = String(b.name || '').trim().slice(0, 160);
  if (!name) return { error: 'Enter the application name.' };
  const winget = String(b.winget || '').trim();
  if (winget && !WINGET_ID.test(winget)) return { error: 'The WinGet ID isn’t valid. Leave it empty for an app you packaged yourself.' };
  const id = privateId(name, winget);
  if (id.length < 4) return { error: 'Use a name with letters or numbers.' };
  return { id, value: {
    name, winget, vendor: String(b.vendor || '').trim().slice(0, 160), reg: String(b.reg || name).trim().slice(0, 200),
    procs: String(b.procs || '').slice(0, 300), exe: String(b.exe || '').slice(0, 400), category: String(b.category || '').slice(0, 60),
    requestId: String(b.requestId || '').slice(0, 80), source: 'winget', private: true, enabled: b.enabled !== false
  } };
}
