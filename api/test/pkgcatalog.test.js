import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cleanUploadList, pickMain, defenderResult, cleanPackageSettings, packageWin32Fields, catalogIdFor, safeFileName, PKG_LIMITS } from '../src/lib/pkgcatalog.js';
import { UNINSTALL_BY_NAME } from '../src/lib/templates.js';

const read = p => readFileSync(new URL(p, import.meta.url), 'utf8');
const files = [{ name: 'setup.exe', size: 5e6 }, { name: 'config.xml', size: 300 }];

test('uploads: allowed types only, an installer must be included, sizes are bounded, names are made safe', () => {
  assert.deepEqual(cleanUploadList(files).files, files);
  assert.match(cleanUploadList([{ name: 'notes.txt', size: 10 }]).error, /installer/);
  assert.match(cleanUploadList([{ name: 'virus.scr', size: 10 }]).error, /file type/);
  assert.match(cleanUploadList([{ name: 'a.msi', size: 1 }, { name: 'a.msi', size: 2 }]).error, /twice/);
  assert.match(cleanUploadList([{ name: 'a.msi', size: PKG_LIMITS.totalBytes + 1 }]).error, /more than/);
  assert.match(cleanUploadList([{ name: 'a.msi', size: 0 }]).error, /empty/);
  assert.equal(safeFileName('..\\..\\evil.exe'), '_.._evil.exe');
  assert.equal(safeFileName('../x.exe'), '_x.exe');
});

test('the main installer is an MSI first, then the biggest EXE, unless the admin chose one', () => {
  assert.equal(pickMain([{ name: 'small.exe', size: 1 }, { name: 'big.exe', size: 9 }, { name: 'p.msi', size: 2 }]), 'p.msi');
  assert.equal(pickMain([{ name: 'small.exe', size: 1 }, { name: 'big.exe', size: 9 }]), 'big.exe');
  assert.equal(pickMain([{ name: 'small.exe', size: 1 }, { name: 'big.exe', size: 9 }], 'small.exe'), 'small.exe');
});

test('Defender for Storage results are read from the blob tags', () => {
  const now = Date.parse('2026-11-26T12:00:00Z');
  assert.equal(defenderResult({ tags: { 'Malware Scanning scan result': 'No threats found' } }, now).result, 'clean');
  assert.equal(defenderResult({ tags: { 'Malware Scanning scan result': 'Malicious' } }, now).result, 'malicious');
  assert.equal(defenderResult({ tags: {}, createdOn: '2026-11-26T11:55:00Z' }, now).result, 'pending');
  assert.equal(defenderResult({ tags: {}, createdOn: '2026-11-26T10:00:00Z' }, now).result, 'not-scanned');
  assert.match(defenderResult({ tagError: 'permission' }, now).note, /Storage Blob Data Owner/);
});

test('settings: commands must run the installer, versions and detection rules are checked', () => {
  const base = { name: 'Contoso Widget', version: '2.5.1', mainFile: 'setup.exe', install: '"setup.exe" /S', uninstall: 'powershell.exe -File .\\Uninstall-App.ps1 -Switches "/S"', detection: { type: 'registry', displayName: 'Contoso Widget*' } };
  const ok = cleanPackageSettings(base, files);
  assert.equal(ok.error, undefined); assert.deepEqual(ok.settings.detection, { type: 'registry', displayName: 'Contoso Widget*', version: '2.5.1' });
  assert.match(cleanPackageSettings({ ...base, install: 'calc.exe' }, files).error, /should run setup\.exe/);
  assert.match(cleanPackageSettings({ ...base, version: 'two point five' }, files).error, /version/);
  assert.match(cleanPackageSettings({ ...base, mainFile: 'other.exe' }, files).error, /main installer/);
  assert.match(cleanPackageSettings({ ...base, uninstall: '' }, files).error, /uninstall/);
  assert.match(cleanPackageSettings({ ...base, detection: { type: 'msi', productCode: 'nope' } }, files).error, /product code/);
  assert.match(cleanPackageSettings({ ...base, detection: { type: 'file', path: 'relative\\x', file: 'a.exe' } }, files).error, /folder/);
  const msi = cleanPackageSettings({ ...base, mainFile: 'w.msi', install: 'msiexec /i "w.msi" /qn', detection: { type: 'msi', productCode: '{12345678-90ab-cdef-1234-567890abcdef}', version: '2.5.1' } }, [{ name: 'w.msi', size: 1 }]);
  assert.equal(msi.settings.detection.productCode, '{12345678-90AB-CDEF-1234-567890ABCDEF}');
  assert.equal(cleanPackageSettings({ ...base, install: '"setup.exe" /S\r\nshutdown /s' }, files).settings.install.includes('\n'), false);
  assert.deepEqual(cleanPackageSettings({ ...base, returnCodes: [{ code: 0, type: 'success' }, { code: 1641, type: 'success' }, { code: 99, type: 'retry' }] }, files).settings.returnCodes, [{ code: 99, type: 'retry' }]);
});

test('Win32 fields: MSI product code, file version and registry rules map to Intune detection types', () => {
  const s = { mainFile: 'w.msi', install: 'msiexec /i "w.msi" /qn', uninstall: 'msiexec /x {A} /qn', arch: 'x64', returnCodes: [{ code: 99, type: 'retry' }] };
  const m = packageWin32Fields({ ...s, detection: { type: 'msi', productCode: '{12345678-90AB-CDEF-1234-567890ABCDEF}', version: '2.5' } });
  assert.equal(m.detectionRules[0]['@odata.type'], '#microsoft.graph.win32LobAppProductCodeDetection');
  assert.equal(m.detectionRules[0].productVersionOperator, 'greaterThanOrEqual');
  assert.equal(m.setupFilePath, 'w.msi'); assert.deepEqual(m.returnCodes.at(-1), { returnCode: 99, type: 'retry' });
  const f = packageWin32Fields({ ...s, detection: { type: 'file', path: '%ProgramFiles%\\Contoso', file: 'widget.exe', version: '' } });
  assert.equal(f.detectionRules[0].detectionType, 'exists');
  const r = packageWin32Fields({ ...s, detection: { type: 'registry', displayName: 'Contoso*', version: '2.5' } }, { detectScript: (n, v) => `check ${n} ${v}` });
  assert.equal(Buffer.from(r.detectionRules[0].scriptContent, 'base64').toString(), 'check Contoso* 2.5');
  assert.equal(catalogIdFor('Contoso Widget 2.5 (x64)!'), 'contoso-widget-2-5-x64');
});

test('the uninstall helper finds the app by name, prefers MSI and quiet strings, and reports its result', () => {
  assert.match(UNINSTALL_BY_NAME, /\$Name = '__NAME__'/);
  assert.match(UNINSTALL_BY_NAME, /QuietUninstallString/);
  assert.match(UNINSTALL_BY_NAME, /msiexec\.exe' -ArgumentList @\('\/x'/);
  assert.match(UNINSTALL_BY_NAME, /NEXPATCH-RESULT action=uninstall/);
  assert.doesNotMatch(UNINSTALL_BY_NAME, /\$args\s*=/);   // $args is a PowerShell automatic variable
});

test('wiring: platform routes need a catalog role; publishing reads the package on the server, never from the browser', () => {
  const f = read('../src/functions/packages.js');
  for (const r of ["'platform/packages'", "'platform/packages/{id}'", "'platform/packages/{id}/analyze'", "'platform/packages/{id}/catalog'"]) assert.ok(f.includes(r), r);
  assert.equal((f.match(/requireCatalog\(user\)/g) || []).length, 7);
  assert.match(f, /verdict\.level === 'block'/); assert.match(f, /acknowledge !== true/);
  const pub = read('../src/functions/publish.js');
  assert.match(pub, /async function loadPackage\(catalogId\)/);
  assert.match(pub, /a\.pkg = p\.settings/);
  assert.match(read('../src/lib/publisher.js'), /packageWin32Fields\(pkg/);
  const plat = read('../src/functions/platform.js');
  assert.match(plat, /r\.source === 'package' \? !!r\.packageId/);
  assert.match(plat, /Create packaged apps with Package an installer/);
  assert.match(read('../src/lib/store.js'), /'CatalogPackages'/);
});
