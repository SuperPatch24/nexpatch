import test from 'node:test';
import assert from 'node:assert/strict';
import { listVendorPackages } from '../src/lib/appfinder.js';
import { safeFeedUrl, cleanVersionSource, parseFeedLatest, githubLatest, latestVersionFor, runVersionWatch } from '../src/lib/versionwatch.js';

const res = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
const tree = (...names) => res({ tree: names.map(([path, sha], i) => ({ path, type: 'tree', sha: sha || `sha-${path}` })), truncated: false });

test('vendor browse walks the repository tree and lists that vendor’s packages', async () => {
  const f = async url => {
    if (url.endsWith('/git/trees/master')) return tree(['manifests', 'S-man']);
    if (url.endsWith('/git/trees/S-man')) return tree(['m', 'S-m'], ['o', 'S-o']);
    if (url.endsWith('/git/trees/S-m')) return tree(['Mozilla'], ['Microsoft', 'S-ms'], ['MicrosoftCorp']);
    if (url.endsWith('/git/trees/S-ms')) return res({ tree: [{ path: 'Edge', type: 'tree' }, { path: 'PowerToys', type: 'tree' }, { path: 'readme.txt', type: 'blob' }] });
    return res({}, 404);
  };
  const r = await listVendorPackages('microsoft', { fetchFn: f, token: 't' });
  assert.equal(r.vendor, 'Microsoft'); assert.deepEqual(r.packages.map(p => p.id), ['Microsoft.Edge', 'Microsoft.PowerToys']);
  const s = await listVendorPackages('Micro', { fetchFn: f, token: 't' });
  assert.equal(s.vendor, ''); assert.deepEqual(s.suggestions, ['Microsoft', 'MicrosoftCorp']);
  await assert.rejects(() => listVendorPackages('x', { fetchFn: f }), /vendor name/);
  await assert.rejects(() => listVendorPackages('Oracle', { fetchFn: async () => res({}, 403) }), /rate limit/);
});

test('feed addresses must be public https', () => {
  assert.ok(safeFeedUrl('https://vendor.example.com/releases.xml'));
  for (const bad of ['http://vendor.example.com/a', 'https://127.0.0.1/a', 'https://localhost/a', 'https://intranet/a', 'https://printer.local/a', 'https://[::1]/a', 'https://user:pw@vendor.example.com/a', 'ftp://x.example.com', 'not a url']) assert.equal(safeFeedUrl(bad), '', bad);
});

test('version source settings are validated', () => {
  assert.equal(cleanVersionSource({}).value.versionSource, 'auto');
  assert.ok(cleanVersionSource({ versionSource: 'github', versionRepo: 'not a repo' }).error);
  assert.equal(cleanVersionSource({ versionSource: 'github', versionRepo: 'owner/name' }).value.versionRepo, 'owner/name');
  assert.ok(cleanVersionSource({ versionSource: 'rss', versionFeed: 'http://x.example.com/f' }).error);
  assert.ok(cleanVersionSource({ versionSource: 'rss', versionFeed: 'https://x.example.com/f', versionPattern: '(a+)+$' }).error);
  assert.ok(cleanVersionSource({ versionSource: 'rss', versionFeed: 'https://x.example.com/f', versionPattern: '([' }).error);
});

test('RSS and Atom feeds: newest entry title gives the version', () => {
  const rss = '<rss><channel><item><title><![CDATA[Acme Tool 4.12.1 released]]></title><link>https://a.example/r</link><pubDate>Mon, 02 Nov 2026</pubDate></item><item><title>Acme Tool 4.11</title></item></channel></rss>';
  const a = parseFeedLatest(rss); assert.equal(a.version, '4.12.1'); assert.equal(a.link, 'https://a.example/r');
  const atom = '<feed><entry><title>v2.5.0</title><link href="https://github.com/o/r/releases/tag/v2.5.0"/><updated>2026-11-01T00:00:00Z</updated></entry></feed>';
  assert.equal(parseFeedLatest(atom).version, '2.5.0');
  assert.equal(parseFeedLatest(rss, 'Tool (\\d+\\.\\d+)').version, '4.12');
  assert.throws(() => parseFeedLatest('<rss></rss>'), /no entries/);
  assert.throws(() => parseFeedLatest('<rss><item><title>No numbers here</title></item></rss>'), /No version number/);
});

test('GitHub latest release gives the version from its tag', async () => {
  const ok = async () => res({ tag_name: 'v8.6.2', name: 'Release 8.6.2', published_at: '2026-10-01T00:00:00Z', html_url: 'https://github.com/o/r/releases/tag/v8.6.2' });
  assert.equal((await githubLatest('o/r', '', { fetchFn: ok })).version, '8.6.2');
  await assert.rejects(() => githubLatest('o/r', '', { fetchFn: async () => res({}, 404) }), /no published releases/);
  await assert.rejects(() => githubLatest('bad repo', '', { fetchFn: ok }), /Invalid/);
});

const mk = (id, extra = {}) => ({ rowKey: id, name: id, source: 'winget', winget: `V.${id}`, enabled: true, ...extra });
const store = rows => ({ rows, update: async (id, patch) => Object.assign(rows.find(r => r.rowKey === id), patch) });

test('first check sets a baseline; a later higher version is reported once; failures keep the old version', async () => {
  const versions = { a: '1.0', b: '2.0' };
  const fetchFn = async url => { const id = /manifests\/v\/V\/(\w+)/.exec(url)?.[1]; return versions[id] ? res([{ type: 'dir', name: versions[id] }]) : res({}, 404); };
  const rows = [mk('a'), mk('b'), mk('gone')]; const s = store(rows);
  let r = await runVersionWatch(s, { force: true, opts: { fetchFn, token: 't' } });
  assert.equal(r.checked, 3); assert.equal(r.failed, 1); assert.equal(r.changes.length, 0);
  assert.equal(rows[0].latestVersion, '1.0'); assert.ok(rows[2].latestError);
  versions.a = '1.1';
  r = await runVersionWatch(s, { force: true, opts: { fetchFn, token: 't' } });
  assert.deepEqual(r.changes.map(c => [c.name, c.from, c.to]), [['a', '1.0', '1.1']]);
  assert.equal(rows[0].previousVersion, '1.0'); assert.ok(rows[0].latestChangedAt);
  versions.a = '1.0';   // a lower version is recorded but is not a "new version"
  r = await runVersionWatch(s, { force: true, opts: { fetchFn, token: 't' } });
  assert.equal(r.changes.length, 0); assert.equal(rows[0].latestVersion, '1.0');
});

test('recently checked apps are skipped, the limit applies, and disabled or unverified Store entries are ignored', async () => {
  const fetchFn = async () => res([{ type: 'dir', name: '1.0' }]);
  const now = new Date('2026-11-13T12:00:00Z');
  const rows = [mk('fresh', { latestCheckedAt: '2026-11-13T10:00:00Z', latestVersion: '1.0' }), mk('old1', { latestCheckedAt: '2026-11-10T00:00:00Z' }), mk('old2'), mk('off', { enabled: false }),
    { rowKey: 'cand', name: 'cand', source: 'msstore', storeProductId: 'ABCDEFGH1234', verificationStatus: 'candidate', enabled: true }];
  const r = await runVersionWatch(store(rows), { now, limit: 1, opts: { fetchFn, token: 't' } });
  assert.equal(r.checked, 1);
  assert.equal(rows.find(x => x.rowKey === 'old2').latestVersion, '1.0');   // never-checked entries go first
  assert.equal(rows.find(x => x.rowKey === 'off').latestVersion, undefined);
  assert.equal(rows.find(x => x.rowKey === 'cand').latestVersion, undefined);
});

test('latestVersionFor picks the right source', async () => {
  const f = async url => url.includes('releases/latest') ? res({ tag_name: 'v3.1' }) : url.includes('packageManifests') ? res({ Data: { Versions: [{ PackageVersion: '9.9' }] } }) : res('<rss><item><title>App 7.7</title></item></rss>');
  assert.equal((await latestVersionFor({ versionSource: 'github', versionRepo: 'o/r' }, { fetchFn: f })).version, '3.1');
  assert.equal((await latestVersionFor({ source: 'msstore', storeProductId: 'ABCDEFGH1234' }, { fetchFn: f })).version, '9.9');
  assert.equal((await latestVersionFor({ versionSource: 'rss', versionFeed: 'https://v.example.com/f' }, { fetchFn: f })).version, '7.7');
});
