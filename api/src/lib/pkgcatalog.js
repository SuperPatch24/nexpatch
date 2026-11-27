// Rules for installer packages made in the Admin Center and published as catalog apps. Pure, so it can be tested.
export const PKG_CONTAINER = 'nexpatch-catalog-packages';
export const PKG_LIMITS = { files: 20, totalBytes: 400 * 1024 * 1024, mainBytes: 400 * 1024 * 1024 };
const ALLOWED = /\.(msi|exe|mst|msp|cab|ps1|cmd|bat|xml|ini|json|txt|cfg|reg|iss|config|dll|zip)$/i;
const GUIDB = /^\{[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\}$/i;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,39}$/;
const ARCH = ['x64', 'x86', 'arm64', 'x64x86', 'AllWithARM64'];
const RESTART = ['suppress', 'allow', 'basedOnReturnCode', 'force'];
const RC_TYPES = ['success', 'softReboot', 'hardReboot', 'retry', 'failed'];

export function safeFileName(v) {
  const n = String(v || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '').trim().slice(0, 120);
  return n && ALLOWED.test(n) ? n : '';
}

// The files an admin wants to upload: allowed types, no duplicates, size limits.
export function cleanUploadList(list) {
  const files = Array.isArray(list) ? list : [];
  if (!files.length) return { error: 'Choose at least one file.' };
  if (files.length > PKG_LIMITS.files) return { error: `Upload at most ${PKG_LIMITS.files} files.` };
  const out = [], seen = new Set();
  let total = 0;
  for (const f of files) {
    const name = safeFileName(f?.name), size = Number(f?.size);
    if (!name) return { error: `${String(f?.name || 'A file')} isn’t a file type that can go in a package.` };
    if (seen.has(name.toLowerCase())) return { error: `${name} is listed twice.` };
    if (!Number.isSafeInteger(size) || size < 1) return { error: `${name} is empty.` };
    seen.add(name.toLowerCase()); total += size; out.push({ name, size });
  }
  if (total > PKG_LIMITS.totalBytes) return { error: `The files add up to more than ${Math.round(PKG_LIMITS.totalBytes / 1048576)} MB.` };
  if (!out.some(f => /\.(msi|exe|ps1|cmd|bat)$/i.test(f.name))) return { error: 'Include the installer itself (an MSI or EXE).' };
  return { files: out };
}

// The main installer: an MSI first, then the biggest EXE.
export function pickMain(files, wanted = '') {
  if (wanted && files.some(f => f.name === wanted)) return wanted;
  const msi = files.filter(f => /\.msi$/i.test(f.name)).sort((a, b) => b.size - a.size)[0];
  const exe = files.filter(f => /\.exe$/i.test(f.name)).sort((a, b) => b.size - a.size)[0];
  return (msi || exe || files.find(f => /\.(ps1|cmd|bat)$/i.test(f.name)) || files[0])?.name || '';
}

// What Microsoft Defender for Storage wrote on the blob.
export function defenderResult(info, now = Date.now()) {
  if (!info) return { result: 'missing' };
  if (info.tagError) return { result: 'unknown', note: info.tagError === 'permission' ? 'NexpatchOnline can’t read the scan result. Give the Function App the Storage Blob Data Owner role on the storage account.' : 'The scan result couldn’t be read.' };
  const v = info.tags?.['Malware Scanning scan result'];
  if (v === 'No threats found') return { result: 'clean', at: info.tags['Malware Scanning scan time UTC'] || '' };
  if (v === 'Malicious') return { result: 'malicious', at: info.tags['Malware Scanning scan time UTC'] || '' };
  if (v) return { result: 'unknown', note: `Defender reported: ${String(v).slice(0, 80)}` };
  const age = now - Date.parse(info.createdOn || 0);
  return age < 15 * 60_000 ? { result: 'pending' } : { result: 'not-scanned' };
}

const line = (v, n) => String(v ?? '').replace(/[\r\n\u0000]/g, ' ').trim().slice(0, n);

// The settings an admin confirms before the package goes into the catalog.
export function cleanPackageSettings(b = {}, files = []) {
  const names = files.map(f => f.name);
  const s = {
    name: line(b.name, 120), vendor: line(b.vendor, 120), version: line(b.version, 40), category: line(b.category, 60), notes: line(b.notes, 500),
    mainFile: names.includes(b.mainFile) ? b.mainFile : '', install: line(b.install, 1024), uninstall: line(b.uninstall, 1024),
    uninstallName: line(b.uninstallName || b.detection?.displayName || b.name, 200),
    arch: ARCH.includes(b.arch) ? b.arch : 'x64', restart: RESTART.includes(b.restart) ? b.restart : 'suppress',
    maxRunTime: Math.min(720, Math.max(10, Math.trunc(Number(b.maxRunTime) || 60))),
    returnCodes: (Array.isArray(b.returnCodes) ? b.returnCodes : []).slice(0, 10).map(r => ({ code: Math.trunc(Number(r?.code)), type: RC_TYPES.includes(r?.type) ? r.type : 'success' })).filter(r => Number.isFinite(r.code) && ![0, 1707, 3010, 1641, 1618].includes(r.code))
  };
  if (!s.name) return { error: 'Enter the app name.' };
  if (!VERSION.test(s.version)) return { error: 'Enter the version, for example 24.08 or 2.5.1.' };
  if (!s.mainFile) return { error: 'Choose the main installer file.' };
  if (!s.install) return { error: 'Enter the install command.' };
  if (!s.uninstall) return { error: 'Enter the uninstall command. Intune needs one.' };
  const main = s.mainFile.toLowerCase(), cmd = s.install.toLowerCase();
  if (!cmd.includes(main) && !/^msiexec(\.exe)?\s/.test(cmd) && !/^(powershell|cmd)(\.exe)?\s/.test(cmd)) return { error: `The install command should run ${s.mainFile}.` };
  const d = b.detection || {};
  if (d.type === 'msi') {
    const pc = String(d.productCode || '').toUpperCase();
    if (!GUIDB.test(pc)) return { error: 'Enter the MSI product code, like {12345678-1234-1234-1234-123456789ABC}.' };
    s.detection = { type: 'msi', productCode: pc, version: VERSION.test(String(d.version || '')) ? String(d.version) : '' };
  } else if (d.type === 'file') {
    const path = line(d.path, 260), file = line(d.file, 120);
    if (!/^(%[A-Za-z]+%|[A-Za-z]:)\\/.test(path) || !file || /[\\/]/.test(file)) return { error: 'For a file rule, enter the folder (like %ProgramFiles%\\Contoso) and the file name.' };
    s.detection = { type: 'file', path, file, version: VERSION.test(String(d.version || '')) ? String(d.version) : '' };
  } else {
    const displayName = line(d.displayName || s.name, 200);
    if (!displayName) return { error: 'Enter the name the app shows in Installed apps.' };
    s.detection = { type: 'registry', displayName, version: d.version === '' ? '' : (VERSION.test(String(d.version || s.version)) ? String(d.version || s.version) : '') };
  }
  return { settings: s };
}

const b64 = t => Buffer.from(String(t || ''), 'utf8').toString('base64');

// The Win32 app fields for one package. detectScript fills the registry rule (the same check winget apps use).
export function packageWin32Fields(s, { detectScript } = {}) {
  let detection;
  if (s.detection.type === 'msi') detection = { '@odata.type': '#microsoft.graph.win32LobAppProductCodeDetection', productCode: s.detection.productCode,
    productVersionOperator: s.detection.version ? 'greaterThanOrEqual' : 'notConfigured', productVersion: s.detection.version || null };
  else if (s.detection.type === 'file') detection = { '@odata.type': '#microsoft.graph.win32LobAppFileSystemDetection', path: s.detection.path, fileOrFolderName: s.detection.file,
    check32BitOn64System: s.arch === 'x86', detectionType: s.detection.version ? 'version' : 'exists', operator: s.detection.version ? 'greaterThanOrEqual' : 'notConfigured', detectionValue: s.detection.version || null };
  else detection = { '@odata.type': '#microsoft.graph.win32LobAppPowerShellScriptDetection', enforceSignatureCheck: false, runAs32Bit: false,
    scriptContent: b64(detectScript(s.detection.displayName, s.detection.version || '0')) };
  return {
    fileName: 'NexpatchOnlinePackage.intunewin', setupFilePath: s.mainFile, installCommandLine: s.install, uninstallCommandLine: s.uninstall,
    detectionRules: [detection],
    returnCodes: [{ returnCode: 0, type: 'success' }, { returnCode: 1707, type: 'success' }, { returnCode: 3010, type: 'softReboot' }, { returnCode: 1641, type: 'hardReboot' }, { returnCode: 1618, type: 'retry' },
      ...s.returnCodes.map(r => ({ returnCode: r.code, type: r.type }))]
  };
}

export const catalogIdFor = name => String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'package';
