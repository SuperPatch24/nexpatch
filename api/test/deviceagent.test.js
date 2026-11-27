import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { cleanReport, explainExit, deviceHealth, fleetReport, toChunks, fromChunks, agentConfig, compareVersions, AGENT_LIMITS } from '../src/lib/deviceagent.js';
import { AGENT_RELEASE } from '../src/lib/agentrelease.js';

const read = p => readFileSync(new URL(p, import.meta.url), 'utf8');
const NOW = Date.parse('2026-11-26T12:00:00Z');

test('reports are cleaned: unknown fields dropped, strings bounded, ids checked, heartbeats carry no app list', () => {
  const r = cleanReport({ kind: 'full', evil: 1, sentAt: 'nope', device: { name: 'PC-1\u0000' + 'x'.repeat(500), intuneDeviceId: 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE', os: { build: '22631', ubr: 4460 } },
    health: { winget: { found: true, ok: false, exitCode: -1073741701, error: 'x' } },
    apps: [{ name: 'Chrome', version: '131', scope: 'weird', arch: 'arm', installDate: '2026-01-01', productCode: '{12345678-1234-1234-1234-123456789ABC}' }, { name: '' }],
    results: [{ id: 'Google.Chrome', exitCode: '0', action: 'install', at: '2026-11-25T00:00:00Z' }, { id: '../etc', exitCode: 0 }] });
  assert.equal(r.evil, undefined);
  assert.equal(r.device.name.length, 100); assert.ok(!r.device.name.includes('\u0000'));
  assert.equal(r.device.intuneDeviceId, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  assert.deepEqual(r.apps, [{ name: 'Chrome', version: '131', publisher: '', scope: 'machine', arch: 'x64', installDate: '', productCode: '{12345678-1234-1234-1234-123456789ABC}' }]);
  assert.deepEqual(r.results.map(x => x.id), ['Google.Chrome']);
  assert.equal(r.results[0].exitCode, 0);
  const hb = cleanReport({ kind: 'heartbeat', apps: [{ name: 'X' }] });
  assert.equal(hb.apps, undefined);
  assert.equal(cleanReport({ kind: 'full', apps: Array.from({ length: 3000 }, (_, i) => ({ name: 'a' + i })) }).apps.length, AGENT_LIMITS.maxApps);
});

test('exit codes are explained in plain words, including winget codes given as signed numbers', () => {
  assert.deepEqual(explainExit(0), { status: 'ok', text: 'Installed' });
  assert.equal(explainExit(-1978335189).text, 'Already up to date');            // 0x8A15002B
  assert.equal(explainExit(-1978335212).status, 'fail');                         // 0x8A150014
  assert.equal(explainExit(-1978334975).status, 'retry');                        // 0x8A150101 app in use
  assert.match(explainExit(-1073741701).text, /Visual C\+\+/);
  assert.equal(explainExit(42).text, 'Exit code 42');
});

test('device health: stale, winget, runtime, disk, restart and failed installs are flagged', () => {
  const ok = { lastSeenAt: '2026-11-26T11:00:00Z', health: { winget: { ok: true }, vcRuntime: { dlls: true } }, device: { diskFreeGB: 80, diskTotalGB: 256 } };
  assert.deepEqual(deviceHealth(ok, NOW), { status: 'healthy', issues: [] });
  assert.equal(deviceHealth({ ...ok, lastSeenAt: '2026-11-20T00:00:00Z' }, NOW).status, 'stale');
  const bad = deviceHealth({ ...ok, health: { winget: { ok: false, found: true, error: 'winget can’t start' }, vcRuntime: { dlls: false } }, device: { diskFreeGB: 3, diskTotalGB: 128, rebootPending: true }, results: [{ exitCode: 1603 }, { exitCode: 0 }] }, NOW);
  assert.equal(bad.status, 'attention');
  assert.deepEqual(bad.issues, ['winget can’t start', 'Visual C++ runtime files missing', 'Low disk space (3 GB free)', 'Restart pending', '1 failed install']);
  assert.equal(deviceHealth({ status: 'revoked' }, NOW).status, 'revoked');
});

test('fleet report: counts, Windows builds, app versions behind the newest, install success per app', () => {
  const dev = (name, chrome, results, extra = {}) => ({ lastSeenAt: '2026-11-26T11:00:00Z', agentVersion: '1.0.0', health: { winget: { ok: true }, vcRuntime: { dlls: true } },
    device: { os: { product: 'Windows 11 Pro', displayVersion: '24H2', build: '26100', ubr: 2605 } }, apps: [{ name: 'Google Chrome', version: chrome, publisher: 'Google' }, { name: '7-Zip', version: '24.08' }], results, ...extra });
  const rows = [dev('a', '131.0.6778.86', [{ id: 'Google.Chrome', exitCode: 0, at: '2026-11-25T00:00:00Z' }]),
    dev('b', '130.0.6723.117', [{ id: 'Google.Chrome', exitCode: 1603, at: '2026-11-25T01:00:00Z' }]),
    dev('c', '131.0.6778.86', [{ id: 'Google.Chrome', exitCode: -1978334975, at: '2026-11-24T00:00:00Z' }], { health: { winget: { ok: false }, vcRuntime: { dlls: true } } }),
    { status: 'revoked' }];
  const f = fleetReport(rows, NOW);
  assert.deepEqual(f.counts, { devices: 3, healthy: 1, attention: 2, stale: 0, revoked: 1, wingetBroken: 1, vcMissing: 0, rebootPending: 0, lowDisk: 0 });
  assert.deepEqual(f.builds, [{ build: 'Windows 11 Pro 24H2 26100.2605', devices: 3 }]);
  const chrome = f.apps.find(a => a.name === 'Google Chrome');
  assert.equal(chrome.newest, '131.0.6778.86'); assert.equal(chrome.behind, 1); assert.equal(chrome.devices, 3);
  assert.equal(f.apps[0].name, 'Google Chrome');   // apps with devices behind come first
  const inst = f.installs[0];
  assert.deepEqual({ ok: inst.ok, fail: inst.fail, retry: inst.retry, successRate: inst.successRate }, { ok: 1, fail: 1, retry: 1, successRate: 33 });
  assert.deepEqual(inst.reasons.map(r => r.reason).sort(), ['App was in use', 'Installer failed (1603)']);
});

test('versions compare part by part', () => {
  assert.equal(compareVersions('131.0.6778.86', '131.0.6778.108'), -1);
  assert.equal(compareVersions('24.08', '24.8'), 0);
  assert.equal(compareVersions('2.0-beta', '2.0'), 1);
});

test('long JSON is split across table fields and read back; too much is refused', () => {
  const apps = Array.from({ length: 1500 }, (_, i) => ({ name: 'App number ' + i, version: '1.2.3.' + i, publisher: 'Vendor ' + i }));
  const f = toChunks('apps', apps);
  assert.ok(f.appsParts > 1);
  for (const [k, v] of Object.entries(f)) if (typeof v === 'string') assert.ok(v.length <= 30000, k);
  assert.deepEqual(fromChunks(f, 'apps'), apps);
  assert.equal(f.apps23, '');                                    // unused fields are cleared, so a smaller report doesn't leave old parts behind
  assert.throws(() => toChunks('x', 'y'.repeat(30000 * 30)), /Too much/);
  assert.equal(fromChunks({}, 'apps'), null);
});

test('the agent package config is complete and https only', () => {
  const c = JSON.parse(agentConfig({ tenantId: '11111111-1111-1111-1111-111111111111', key: 'k', endpoint: 'https://api.example.com/api/agent' }));
  assert.deepEqual(c, { endpoint: 'https://api.example.com/api/agent/', tenantId: '11111111-1111-1111-1111-111111111111', enrollKey: 'k', logLevel: 'info' });
  assert.throws(() => agentConfig({ tenantId: 'x', key: 'k', endpoint: 'https://a' }));
  assert.throws(() => agentConfig({ tenantId: '11111111-1111-1111-1111-111111111111', key: 'k', endpoint: 'http://a' }));
});

test('the shipped agent exe is the one recorded in agentrelease.js', () => {
  const exe = readFileSync(new URL('../assets/agent/nexpatch-agent.exe', import.meta.url));
  assert.equal(exe.length, AGENT_RELEASE.size);
  assert.equal(createHash('sha256').update(exe).digest('hex'), AGENT_RELEASE.sha256);
  assert.equal(exe.subarray(0, 2).toString(), 'MZ');
  assert.match(read('../../agent/main.go'), new RegExp(`AgentVersion = "${AGENT_RELEASE.version.replace(/\./g, '\\.')}"`));
});

test('wiring: device routes have no sign-in but check key, token and Intune; company routes need roles', () => {
  const f = read('../src/functions/agent.js');
  for (const r of ["'agent/enroll'", "'agent/report'", "'agent/devices'", "'agent/devices/{id}'", "'agent/report'", "'agent/settings'", "'agent/publish'", "'agent/manual'"]) assert.ok(f.includes(r), r);
  const enroll = f.slice(f.indexOf("app.http('agentEnroll'"), f.indexOf("app.http('agentReport'"));
  assert.match(enroll, /secretMatches\(t\.agKeyHash, key\)/); assert.match(enroll, /DeviceInventory/); assert.match(enroll, /tenantEnrollsPerHour/); assert.doesNotMatch(enroll, /withUser/);
  const rep = f.slice(f.indexOf("app.http('agentReport'"), f.indexOf('const shapeRow'));
  assert.match(rep, /secretMatches\(row\.tokenHash, token\)/); assert.match(rep, /revoked/); assert.match(rep, /maxBody/); assert.match(rep, /cleanReport\(body\)/);
  assert.match(f.slice(f.indexOf("app.http('agentPublish'")), /'admin'\)/);
  assert.match(f.slice(f.indexOf("app.http('agentDevices'"), f.indexOf("app.http('agentDevice',")), /'viewer'\)/);
  assert.match(read('../src/lib/store.js'), /'AgentDevices'/);
});

test('wiring: the agent app is installed by Intune with no script, detected by its registry version', async () => {
  const p = read('../src/lib/agentpublish.js');
  assert.match(p, /installCommandLine: 'nexpatch-agent\.exe install'/);
  assert.match(p, /win32LobAppRegistryDetection/);
  assert.match(p, /SOFTWARE\\\\NexpatchOnline\\\\Agent/);
  assert.match(p, /Managed by NexpatchOnline/);           // so "remove from Intune" recognises it as ours
  assert.doesNotMatch(p, /powershell/i);
});

test('the install script writes one fixed result line for the agent, for installs and uninstalls', async () => {
  const { WRAPPER } = await import('../src/lib/templates.js');
  assert.match(WRAPPER, /NEXPATCH-RESULT action=\{0\} exit=\{1\} at=\{2\}/);
  assert.ok(WRAPPER.indexOf('NEXPATCH-RESULT') < WRAPPER.indexOf('Stop-Transcript | Out-Null\nexit $exit'));
  assert.equal((WRAPPER.match(/__ACTION__/g) || []).length, 2);
  assert.match(read('../src/lib/publisher.js'), /replaceAll\('__ACTION__'/);
});

test('large packages are uploaded in 6 MB parts with fixed-length block ids', async () => {
  const src = read('../src/lib/publisher.js');
  assert.match(src, /BLOCK_SIZE = 6 \* 1024 \* 1024/);
  assert.match(src, /ids\.map\(id => `<Latest>\$\{id\}<\/Latest>`\)/);
});
