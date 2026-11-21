import test from 'node:test';
import assert from 'node:assert/strict';
import { COLLECTOR, INSTALLER, installerFor, UNINSTALLER } from '../src/lib/collector.js';

test('installer embeds the agent verbatim, with tenant, key and endpoint filled in', () => {
  const text = installerFor('11111111-2222-3333-4444-555555555555', 'k$&e`y', 'https://x.test/api/appcontrol/ingest');
  assert.ok(text.includes(COLLECTOR.trimEnd()), 'agent script must be embedded unchanged ($ patterns must not be expanded)');
  assert.ok(text.includes("tenantId = '11111111-2222-3333-4444-555555555555'"));
  assert.ok(text.includes("key = 'k$&e`y'"));
  assert.ok(!/__[A-Z]+__/.test(text), 'no placeholders left');
});

test('agent script cannot break out of the installer here-string', () => {
  assert.ok(!/^'@/m.test(COLLECTOR), "no line may start with '@");
  assert.ok(!COLLECTOR.includes('`'), 'no backticks (it lives in a JS template)');
});

test('agent loops, sends heartbeats, backs off and guards against a second copy', () => {
  for (const needle of ['while ($true)', 'Start-Sleep -Seconds $Wait', 'Send-Batch @()', 'AbandonedMutexException', 'x-nexpatch-key', '3077']) assert.ok(COLLECTOR.includes(needle), needle);
  assert.ok(COLLECTOR.indexOf('lastRecordId = $r.LastId') > COLLECTOR.indexOf('Send-Batch ($r.Out'), 'bookmark moves only after a successful send');
});

test('installer runs at boot forever and replaces the old 15-minute task; uninstaller removes both', () => {
  assert.ok(INSTALLER.includes('-AtStartup') && INSTALLER.includes('[TimeSpan]::Zero') && INSTALLER.includes('RestartCount'));
  assert.ok(INSTALLER.includes("Unregister-ScheduledTask -TaskName 'NexpatchOnline App Control collector'"));
  assert.ok(UNINSTALLER.includes('App Control agent') && UNINSTALLER.includes('App Control collector'));
});

test('agent enrolls once, protects its token, and drops the enrollment key', () => {
  for (const n of ['Register-Device', 'ProtectedData]::Protect', "'LocalMachine'", 'Remove-EnrollmentKey', 'x-nexpatch-device', 'x-nexpatch-token', 'EntDMID']) assert.ok(COLLECTOR.includes(n), n);
  const loop = COLLECTOR.slice(COLLECTOR.indexOf('while ($true)'));
  assert.ok(!loop.includes('x-nexpatch-key'), 'the loop never sends the enrollment key');
});
