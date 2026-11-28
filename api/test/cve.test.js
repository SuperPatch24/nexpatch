import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cleanCpeProduct, splitCpe, cmpVersion, scoreOf, compactCve, ruleHits, affects, mergeCves, vulnerabilityReport, cpeCandidates, blobNameFor } from '../src/lib/cve.js';

const read = p => readFileSync(new URL(p, import.meta.url), 'utf8');
// Shaped like NVD CVE API 2.0 records
const nvd = (id, score, sev, matches, extra = {}) => ({ id, published: '2026-10-01T10:00:00.000', descriptions: [{ lang: 'en', value: `${id} lets an attacker do something bad.` }],
  metrics: { cvssMetricV31: [{ type: 'Primary', cvssData: { baseScore: score, baseSeverity: sev } }] },
  configurations: [{ nodes: [{ operator: 'OR', negate: false, cpeMatch: matches }] }], ...extra });
const chrome = (v, range = {}) => ({ vulnerable: true, criteria: `cpe:2.3:a:google:chrome:${v}:*:*:*:*:*:*:*`, ...range });

test('CPE products are cleaned and checked', () => {
  assert.deepEqual(cleanCpeProduct('Google:Chrome'), { value: 'google:chrome' });
  assert.deepEqual(cleanCpeProduct('cpe:2.3:a:mozilla:firefox:*:*:*'), { value: 'mozilla:firefox' });
  assert.deepEqual(cleanCpeProduct(''), { value: '' });
  assert.match(cleanCpeProduct('chrome').error, /vendor:product/);
  assert.match(cleanCpeProduct('bad vendor:x').error, /vendor:product/);
  assert.deepEqual(splitCpe('cpe:2.3:a:notepad-plus-plus:notepad\\+\\+:8.6:*'), ['cpe', '2.3', 'a', 'notepad-plus-plus', 'notepad\\+\\+', '8.6', '*']);
  assert.match(blobNameFor('notepad-plus-plus:notepad\\+\\+'), /^[a-z0-9._-]+\.json$/i);
});

test('versions compare part by part', () => {
  assert.equal(cmpVersion('131.0.6778.86', '131.0.6778.108'), -1);
  assert.equal(cmpVersion('24.08', '24.8'), 0);
  assert.equal(cmpVersion('10.0', '10'), 0);
  assert.equal(cmpVersion('3.0.21', '3.0.3'), 1);
});

test('scores use the newest CVSS version available', () => {
  assert.deepEqual(scoreOf({ cvssMetricV31: [{ cvssData: { baseScore: 8.8, baseSeverity: 'HIGH' } }], cvssMetricV2: [{ cvssData: { baseScore: 6.8 }, baseSeverity: 'MEDIUM' }] }), { score: 8.8, severity: 'HIGH', version: '31' });
  assert.equal(scoreOf({ cvssMetricV2: [{ cvssData: { baseScore: 9.3 } }] }).severity, 'CRITICAL');
  assert.equal(scoreOf({}).severity, 'UNKNOWN');
});

test('only vulnerable entries for our own product are kept, with their version rules and the CISA flag', () => {
  const c = compactCve(nvd('CVE-2026-0001', 9.6, 'CRITICAL', [chrome('*', { versionEndExcluding: '131.0.6778.85' }), { vulnerable: false, criteria: 'cpe:2.3:o:microsoft:windows:-:*:*:*:*:*:*:*' }, { vulnerable: true, criteria: 'cpe:2.3:a:microsoft:edge:*:*:*:*:*:*:*:*', versionEndExcluding: '131' }],
    { cisaExploitAdd: '2026-10-05', cisaActionDue: '2026-10-26' }), 'google:chrome');
  assert.deepEqual(c.rules, [{ ee: '131.0.6778.85' }]);
  assert.equal(c.kev, '2026-10-05'); assert.equal(c.kevDue, '2026-10-26'); assert.equal(c.sev, 'CRITICAL'); assert.equal(c.pub, '2026-10-01');
  assert.equal(compactCve(nvd('CVE-X', 5, 'MEDIUM', [{ vulnerable: true, criteria: 'cpe:2.3:a:mozilla:firefox:*:*:*:*:*:*:*:*' }]), 'google:chrome'), null);
  assert.equal(compactCve({ id: 'N', configurations: [{ nodes: [{ negate: true, cpeMatch: [chrome('*')] }] }] }, 'google:chrome'), null);
});

test('version rules: ranges with each kind of bound, exact versions, and "-"', () => {
  assert.equal(ruleHits({ ee: '131.0.6778.85' }, '130.0.6723.117'), true);
  assert.equal(ruleHits({ ee: '131.0.6778.85' }, '131.0.6778.85'), false);
  assert.equal(ruleHits({ ei: '131.0.6778.85' }, '131.0.6778.85'), true);
  assert.equal(ruleHits({ si: '120', ee: '125' }, '119.9'), false);
  assert.equal(ruleHits({ se: '120', ee: '125' }, '120'), false);
  assert.equal(ruleHits({ se: '120', ee: '125' }, '120.0.1'), true);
  assert.equal(ruleHits({ v: '24.07' }, '24.07'), true);
  assert.equal(ruleHits({ v: '24.07' }, '24.08'), false);
  assert.equal(ruleHits({}, '1.0'), true);
  assert.equal(ruleHits({ none: true }, '1.0'), false);
  assert.equal(ruleHits({ ee: '2' }, ''), false);
});

test('a fresh download replaces older copies of the same CVE', () => {
  const m = mergeCves([{ id: 'A', pub: '2026-01-01', score: 5 }, { id: 'B', pub: '2026-02-01' }], [{ id: 'A', pub: '2026-01-01', score: 9 }, { id: 'C', pub: '2026-03-01' }]);
  assert.deepEqual(m.map(c => c.id), ['C', 'B', 'A']); assert.equal(m.find(c => c.id === 'A').score, 9);
});

test('report: exposed versions, known-exploited first, whether updating fixes it, and apps not checked', () => {
  const cves = [
    compactCve(nvd('CVE-2026-1001', 8.8, 'HIGH', [chrome('*', { versionEndExcluding: '131.0.6778.85' })]), 'google:chrome'),
    compactCve(nvd('CVE-2026-1002', 9.8, 'CRITICAL', [chrome('*', { versionStartIncluding: '129', versionEndExcluding: '130.0.6723.116' })], { cisaExploitAdd: '2026-10-05' }), 'google:chrome'),
    compactCve(nvd('CVE-2026-1003', 4.3, 'MEDIUM', [chrome('*', { versionEndIncluding: '131.0.6778.86' })]), 'google:chrome')
  ];
  const catalog = [{ id: 'chrome', name: 'Google Chrome', reg: 'Google Chrome', cpe: 'google:chrome', latestVersion: '131.0.6778.108' },
    { id: 'zip', name: '7-Zip', reg: '7-Zip', cpe: '', latestVersion: '24.08' }, { id: 'vlc', name: 'VLC media player', reg: 'VLC media player', cpe: 'videolan:vlc_media_player' }];
  const inventory = [{ displayName: 'Google Chrome', version: '131.0.6778.108', deviceCount: 50 }, { displayName: 'Google Chrome', version: '130.0.6723.70', deviceCount: 7 },
    { displayName: 'Google Chrome', version: '131.0.6778.86', deviceCount: 3 }, { displayName: '7-Zip 24.08 (x64)', version: '24.08', deviceCount: 20 }, { displayName: 'VLC media player', version: '3.0.21', deviceCount: 4 }];
  const r = vulnerabilityReport({ catalog, inventory, caches: new Map([['google:chrome', { fetchedAt: '2026-11-26T00:00:00Z', cves }]]) });
  assert.deepEqual(r.exposures.map(e => [e.version, e.devices, e.cveCount, e.knownExploited, e.maxSeverity]), [['130.0.6723.70', 7, 3, 1, 'CRITICAL'], ['131.0.6778.86', 3, 1, 0, 'MEDIUM']]);
  assert.deepEqual(r.exposures[0].fix, { status: 'fixed', version: '131.0.6778.108' });
  assert.equal(r.exposures[0].top[0].id, 'CVE-2026-1002');           // the known-exploited one first
  assert.deepEqual(r.summary, { appsAffected: 1, versionsAffected: 2, deviceInstallsExposed: 10, knownExploitedInstalls: 7, knownExploited: 1, cves: { CRITICAL: 1, HIGH: 1, MEDIUM: 1, LOW: 0, UNKNOWN: 0 } });
  assert.deepEqual(r.notChecked.map(n => [n.app, n.reason]), [['7-Zip', 'not-linked'], ['VLC media player', 'not-downloaded']]);
  assert.equal(r.dataAsOf, '2026-11-26T00:00:00Z');
});

test('CPE search results are grouped by product, current ones first', () => {
  const c = cpeCandidates({ products: [
    { cpe: { cpeName: 'cpe:2.3:a:google:chrome:131.0.6778.85:*:*:*:*:*:*:*', deprecated: false, titles: [{ lang: 'en', title: 'Google Chrome 131.0.6778.85' }] } },
    { cpe: { cpeName: 'cpe:2.3:a:google:chrome:130.0:*:*:*:*:*:*:*', deprecated: false, titles: [] } },
    { cpe: { cpeName: 'cpe:2.3:a:google:chrome_os:1:*:*:*:*:*:*:*', deprecated: true, titles: [{ lang: 'en', title: 'Google Chrome OS 1' }] } },
    { cpe: { cpeName: 'cpe:2.3:o:google:chrome_os:1:*:*:*:*:*:*:*', deprecated: false } }] });
  assert.deepEqual(c.map(x => [x.cpe, x.examples, x.deprecated]), [['google:chrome', 2, false], ['google:chrome_os', 1, true]]);
  assert.equal(c[0].title, 'Google Chrome');
});

test('wiring: daily NVD sync with pacing, the report needs a member, catalog admins link products', () => {
  const f = read('../src/functions/cve.js');
  assert.match(f, /app\.timer\('cveSync'/); assert.match(f, /NVD_API_KEY/); assert.match(f, /6500/);
  assert.match(f, /route: 'reports\/vulnerabilities'/); assert.match(f.slice(f.indexOf("'vulnReport'")), /'viewer'\)/);
  assert.equal((f.match(/requireCatalog\(user\)/g) || []).length, 3);
  assert.match(read('../src/functions/platform.js'), /cleanCpeProduct\(b\.cpe === undefined \? prev\.cpe : b\.cpe\)/);
});
