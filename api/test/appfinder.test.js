import test from 'node:test';
import assert from 'node:assert/strict';
import { similarity, categoryFrom, yamlScalar, yamlList, installerUrls, verifyStore, verifyWinget, findApps } from '../src/lib/appfinder.js';

const res = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
const storeManifest = { Data: { PackageIdentifier: '9NBLGGH4NNS1', Versions: [{ PackageVersion: '1.0', DefaultLocale: { PackageName: 'Sample App', Publisher: 'Sample Corp', Tags: ['music'] }, Installers: [{ InstallerType: 'msstore' }] }] } };

test('similarity ranks exact above partial above unrelated', () => {
  assert.equal(similarity('Google Chrome', 'google  chrome'), 1);
  assert.ok(similarity('chrome', 'Google Chrome') >= 0.8);
  assert.ok(similarity('chrome', 'Notepad') < 0.3);
});
test('category is derived only from provided text and is blank otherwise', () => {
  assert.equal(categoryFrom(['developer', 'git']), 'Developer and IT');
  assert.equal(categoryFrom('zzz'), '');
});
test('yaml helpers read the flat keys we need', () => {
  const y = 'PackageIdentifier: Google.Chrome\nPublisher: "Google LLC"\nTags:\n- browser\n- web\nInstallers:\n- Architecture: x64\n  InstallerUrl: https://dl.example.com/chrome.msi\n';
  assert.equal(yamlScalar(y, 'PackageIdentifier'), 'Google.Chrome');
  assert.equal(yamlScalar(y, 'Publisher'), 'Google LLC');
  assert.deepEqual(yamlList(y, 'Tags'), ['browser', 'web']);
  assert.deepEqual(installerUrls(y), ['https://dl.example.com/chrome.msi']);
});
test('verifyStore passes only when every check passes', async () => {
  const ok = async url => url.includes('packageManifests') ? res(storeManifest) : res('', 200);
  const v = await verifyStore('9NBLGGH4NNS1', { fetchFn: ok });
  assert.equal(v.status, 'verified'); assert.equal(v.publisher, 'Sample Corp'); assert.equal(v.url, 'https://apps.microsoft.com/detail/9NBLGGH4NNS1');
  const noPage = async url => url.includes('packageManifests') ? res(storeManifest) : res('', 404);
  assert.equal((await verifyStore('9NBLGGH4NNS1', { fetchFn: noPage })).status, 'failed');
  const notFound = async () => res({}, 404);
  assert.equal((await verifyStore('9NBLGGH4NNS1', { fetchFn: notFound })).status, 'failed');
  assert.equal((await verifyStore('bad id', { fetchFn: ok })).status, 'failed');
});
test('verifyStore rejects a manifest whose ID differs from the requested one', async () => {
  const wrong = async url => url.includes('packageManifests') ? res({ Data: { ...storeManifest.Data, PackageIdentifier: 'OTHERPRODUCT1' } }) : res('', 200);
  assert.equal((await verifyStore('9NBLGGH4NNS1', { fetchFn: wrong })).status, 'failed');
});
test('verifyWinget needs repo entry, matching manifest, reachable installer and publisher', async () => {
  const inst = 'PackageIdentifier: Acme.Tool\nPackageVersion: 2.0\nInstallerType: msi\nInstallers:\n- InstallerUrl: https://dl.acme.test/tool.msi\n';
  const loc = 'PackageIdentifier: Acme.Tool\nPublisher: Acme\nPackageName: Tool\nTags:\n- developer\n';
  const f = async (url, init = {}) => {
    if (url.includes('api.github.com')) return res([{ type: 'dir', name: '1.0' }, { type: 'dir', name: '2.0' }]);
    if (url.endsWith('Acme.Tool.installer.yaml')) return res(inst);
    if (url.endsWith('Acme.Tool.locale.en-US.yaml')) return res(loc);
    if (url === 'https://dl.acme.test/tool.msi') return res('', 200);
    return res('', 404);
  };
  const v = await verifyWinget('Acme.Tool', { fetchFn: f, token: 't' });
  assert.equal(v.status, 'verified'); assert.equal(v.version, '2.0'); assert.equal(v.category, 'Developer and IT');
  const dead = async (url, init) => url === 'https://dl.acme.test/tool.msi' ? res('', 404) : f(url, init);
  assert.equal((await verifyWinget('Acme.Tool', { fetchFn: dead, token: 't' })).status, 'failed');
});
test('findApps reports unverified matches without inventing IDs, and notes a missing GitHub token', async () => {
  const f = async url => {
    if (url.includes('manifestSearch')) return res({ Data: [{ PackageIdentifier: '9NBLGGH4NNS1', PackageName: 'Sample App', Publisher: 'Sample Corp' }] });
    if (url.includes('packageManifests')) return res(storeManifest);
    return res('', 200);
  };
  const old = process.env.GITHUB_TOKEN; delete process.env.GITHUB_TOKEN;
  const r = await findApps('sample app', { fetchFn: f, token: '' });
  if (old) process.env.GITHUB_TOKEN = old;
  assert.equal(r.results.length, 1); assert.equal(r.results[0].status, 'verified'); assert.equal(r.results[0].id, '9NBLGGH4NNS1');
  assert.ok(r.notes.some(n => /GITHUB_TOKEN/.test(n)));
  await assert.rejects(() => findApps('a'), /two characters/);
});
