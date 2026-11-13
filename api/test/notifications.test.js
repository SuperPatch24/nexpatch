import test from 'node:test';
import assert from 'node:assert/strict';
import { NOTICE_TEMPLATES, cleanNotice, cleanSettings, buildToastScript, fill } from '../src/lib/notifications.js';

test('outage templates exist and fill their variables', () => {
  for (const k of ['outage', 'degraded', 'maintenance', 'restored', 'custom']) assert.ok(NOTICE_TEMPLATES[k], k);
  assert.equal(fill(NOTICE_TEMPLATES.outage.title, { service: 'VPN' }), 'Service outage: VPN');
});
test('cleanNotice validates and normalizes', () => {
  assert.match(cleanNotice({ title: '', message: 'x' }).error, /title/);
  assert.match(cleanNotice({ title: 'a', message: 'x', ctaUrl: 'http://x.test' }).error, /https/);
  const v = cleanNotice({ title: 'VPN down', message: 'Working on it', severity: 'bogus', expiresInHours: 9999 }).value;
  assert.equal(v.severity, 'info'); assert.equal(v.expiresInHours, 168);
});
test('settings reject a bad color or email', () => {
  assert.ok(cleanSettings({ color: 'blue' }).error); assert.ok(cleanSettings({ supportEmail: 'nope' }).error);
  assert.equal(cleanSettings({ orgName: ' Contoso ', color: '#112233' }).value.orgName, 'Contoso');
});
test('toast script escapes quotes/XML, honors expiry and only embeds https links', () => {
  const s = buildToastScript({ title: `It's <down> & "bad"`, message: "Line1\nLine2 ' end", severity: 'critical', ctaText: 'Status', ctaUrl: 'https://status.example.com/?a=1&b=2', expiresAt: '2030-01-01T00:00:00Z', orgName: 'Contoso' });
  assert.ok(s.includes("It&apos;s &lt;down&gt; &amp; &quot;bad&quot;"));
  assert.ok(s.includes('2030-01-01T00:00:00.000Z') && s.includes('exit 0'));
  assert.ok(s.includes("activationType=''protocol''") && s.includes('a=1&amp;b=2'));
  assert.ok(!buildToastScript({ title: 't', message: 'm', ctaUrl: 'javascript:alert(1)', expiresAt: '2030-01-01' }).includes('javascript:'));
});
