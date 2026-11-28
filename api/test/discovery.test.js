import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseInstallerManifest, parseLocaleManifest, assessPackage, siteOf, bestInstaller, packagesDue, summarize, discoverPackage, DEFAULT_VENDORS, RateLimited } from '../src/lib/discovery.js';

const fx = (id, kind) => readFileSync(new URL(`./fixtures/winget/${id}.${kind}.yaml`, import.meta.url), 'utf8');
const assess = id => assessPackage({ id, installerText: fx(id, 'installer'), localeText: fx(id, 'locale') });

test('reads real WinGet manifests: installers, root defaults, nested switches and Apps & Features names', () => {
  const m = parseInstallerManifest(fx('VideoLAN.VLC', 'installer'));
  assert.equal(m.id, 'VideoLAN.VLC'); assert.ok(m.installers.length >= 4);
  const msi = m.installers.find(i => i.type === 'wix');
  assert.match(msi.url, /^https:\/\/download\.videolan\.org\//); assert.match(msi.sha256, /^[0-9A-F]{64}$/); assert.equal(msi.scope, 'machine');
  assert.equal(m.installers.find(i => i.type === 'zip').nestedType, 'portable');
  const l = parseLocaleManifest(fx('VideoLAN.VLC', 'locale'));
  assert.equal(l.publisher, 'VideoLAN'); assert.equal(l.name, 'VLC media player'); assert.equal(l.license, 'GPL-2.0');
  const rootTyped = parseInstallerManifest('PackageIdentifier: A.B\nPackageVersion: 1.0\nInstallerType: inno\nScope: machine\nInstallerSwitches:\n  Silent: /VERYSILENT\nInstallers:\n- Architecture: x64\n  InstallerUrl: https://a.example/b.exe\n  InstallerSha256: ' + 'A'.repeat(64) + '\n  AppsAndFeaturesEntries:\n  - DisplayName: B App\n    Publisher: A\n');
  assert.deepEqual([rootTyped.installers[0].type, rootTyped.installers[0].scope, rootTyped.installers[0].silent, rootTyped.installers[0].displayName], ['inno', 'machine', true, 'B App']);
});

test('verdicts on real packages: ready, review (third-party download host) and skip (per-user only)', () => {
  const vlc = assess('VideoLAN.VLC');
  assert.equal(vlc.verdict, 'ready', vlc.reason); assert.equal(vlc.arch, 'x64'); assert.equal(vlc.category, 'Media');
  const npp = assess('Notepad++.Notepad++');
  assert.equal(npp.verdict, 'ready', npp.reason);   // GitHub download from the vendor's own GitHub owner
  const winscp = assess('WinSCP.WinSCP');
  assert.equal(winscp.verdict, 'review'); assert.match(winscp.reason, /vendor’s own website/);
  const postman = assess('Postman.Postman');
  assert.equal(postman.verdict, 'skip'); assert.match(postman.reason, /whole device/);
  const ff = assessPackage({ id: 'Mozilla.Firefox', installerText: fx('VideoLAN.VLC', 'installer').replace(/VideoLAN\.VLC/g, 'Mozilla.Firefox'), localeText: 'PackageName: Mozilla Firefox (en-US)\nPublisher: Mozilla\nLicense: MPL-2.0\n' });
  assert.equal(ff.displayName, 'Mozilla Firefox');   // matches "Mozilla Firefox (x64 en-US)" in Installed apps
});

test('a download from an unrelated GitHub account, plain HTTP or without a hash is never ready', () => {
  const loc = 'Publisher: Contoso\nPackageName: Tool\nLicense: MIT\nPublisherUrl: https://contoso.com/\n';
  const inst = (url, sha = 'B'.repeat(64)) => `PackageIdentifier: Contoso.Tool\nPackageVersion: 2.0\nInstallers:\n- Architecture: x64\n  InstallerType: msi\n  Scope: machine\n  InstallerUrl: ${url}\n  InstallerSha256: ${sha}\n`;
  assert.equal(assessPackage({ id: 'Contoso.Tool', installerText: inst('https://contoso.com/t.msi'), localeText: loc }).verdict, 'ready');
  assert.equal(assessPackage({ id: 'Contoso.Tool', installerText: inst('https://github.com/someone-else/t/releases/t.msi'), localeText: loc }).verdict, 'review');
  assert.equal(assessPackage({ id: 'Contoso.Tool', installerText: inst('https://github.com/contoso/t/releases/t.msi'), localeText: loc }).verdict, 'ready');
  assert.equal(assessPackage({ id: 'Contoso.Tool', installerText: inst('http://contoso.com/t.msi'), localeText: loc }).verdict, 'review');
  assert.equal(assessPackage({ id: 'Contoso.Tool', installerText: inst('https://contoso.com/t.msi', ''), localeText: loc }).verdict, 'review');
  assert.equal(assessPackage({ id: 'Other.Id', installerText: inst('https://contoso.com/t.msi'), localeText: loc }).verdict, 'skip');
  assert.equal(siteOf('https://download.contoso.co.uk/x'), 'contoso.co.uk'); assert.equal(siteOf('ftp://x.y'), '');
  assert.equal(bestInstaller([{ type: 'exe', arch: 'x64', scope: '', silent: false }]), null);
});

test('scheduling: unchecked and week-old packages first, limited per run; counts', () => {
  const now = Date.parse('2026-11-28T00:00:00Z');
  const pk = ['A.One', 'A.Two', 'A.Three'].map(id => ({ id }));
  const res = [{ id: 'A.One', checkedAt: '2026-11-27T00:00:00Z' }, { id: 'a.two', checkedAt: '2026-11-01T00:00:00Z' }];
  assert.deepEqual(packagesDue(pk, res, { now, limit: 5 }).map(p => p.id), ['A.Three', 'A.Two']);
  assert.deepEqual(packagesDue(pk, res, { now, limit: 1 }).map(p => p.id), ['A.Three']);
  assert.deepEqual(summarize([{ verdict: 'ready', inCatalog: true }, { verdict: 'review' }, { verdict: 'skip' }]), { ready: 1, review: 1, skip: 1, inCatalog: 1, total: 3 });
  assert.ok(DEFAULT_VENDORS.includes('VideoLAN') && DEFAULT_VENDORS.every(v => /^[A-Za-z0-9][A-Za-z0-9._+-]+$/.test(v)));
});

test('reads the newest version from GitHub and stops cleanly on the rate limit', async () => {
  const calls = [];
  const fetchFn = async url => { calls.push(url);
    if (url.includes('/contents/')) return { ok: true, status: 200, json: async () => [{ type: 'dir', name: '3.0.9' }, { type: 'dir', name: '3.0.24' }, { type: 'dir', name: 'Nightly' }] };
    return { ok: true, status: 200, text: async () => fx('VideoLAN.VLC', url.includes('installer') ? 'installer' : 'locale') }; };
  const r = await discoverPackage('VideoLAN.VLC', { fetchFn, token: '' });
  assert.equal(r.verdict, 'ready'); assert.equal(r.version, '3.0.24'); assert.ok(calls.some(u => u.includes('/3.0.24/VideoLAN.VLC.installer.yaml')));
  await assert.rejects(discoverPackage('VideoLAN.VLC', { fetchFn: async () => ({ ok: false, status: 403 }), token: '' }), RateLimited);
});
