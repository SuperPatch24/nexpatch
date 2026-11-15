import test from 'node:test';
import assert from 'node:assert/strict';
import { updateAppName, isUpdateAppName, jobDisplayName } from '../src/lib/naming.js';
import { nextDailyRun, sniffImage, cleanProfile, SYNC_SCHEDULE } from '../src/lib/org.js';

test('update-only apps are named "Update for <app> <version>"', () => {
  assert.equal(updateAppName('Google Chrome', '130.0.1'), 'Update for Google Chrome 130.0.1');
  assert.equal(updateAppName('Google Chrome', ''), 'Update for Google Chrome');
});
test('an update app belongs to its own app only, not to apps whose names start the same way', () => {
  assert.ok(isUpdateAppName('Update for Chrome 130.0', 'Chrome'));
  assert.ok(!isUpdateAppName('Update for Chrome Remote Desktop 1.0', 'Chrome'));
  assert.ok(!isUpdateAppName('Chrome', 'Chrome'));
  assert.ok(isUpdateAppName('Update for 7-Zip (x64) 24.08', '7-Zip (x64)'));   // regex characters in names are escaped
});
test('deployment list names: update jobs show the version once known; normal deployments keep the app name', () => {
  assert.equal(jobDisplayName({ operationType: 'update', appName: 'Zoom', version: '6.2.1' }), 'Update for Zoom 6.2.1');
  assert.equal(jobDisplayName({ operationType: 'update', appName: 'Zoom', version: '' }), 'Update for Zoom');
  assert.equal(jobDisplayName({ operationType: 'update', appName: 'Zoom', version: 'Microsoft Store managed' }), 'Update for Zoom');
  assert.equal(jobDisplayName({ operationType: 'deployment', appName: 'Zoom', version: '6.2.1' }), 'Zoom');
});
test('next sync is the next 07:00 UTC', () => {
  assert.equal(SYNC_SCHEDULE.hourUtc, 7);
  assert.equal(nextDailyRun(new Date('2026-11-13T05:00:00Z')), '2026-11-13T07:00:00.000Z');
  assert.equal(nextDailyRun(new Date('2026-11-13T07:00:00Z')), '2026-11-14T07:00:00.000Z');
  assert.equal(nextDailyRun(new Date('2026-12-31T23:30:00Z')), '2027-01-01T07:00:00.000Z');
});
test('logos are checked by file signature; SVG and fakes are refused', () => {
  assert.equal(sniffImage(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0])), 'image/png');
  assert.equal(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0])), 'image/jpeg');
  assert.equal(sniffImage(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')])), 'image/webp');
  assert.equal(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), '');
  assert.equal(sniffImage(Buffer.from('GIF89a......')), '');
});
test('company name is required and tidied', () => {
  assert.ok(cleanProfile({ companyName: '  ' }).error);
  assert.equal(cleanProfile({ companyName: '  Contoso   Ltd ' }).value.companyName, 'Contoso Ltd');
});
