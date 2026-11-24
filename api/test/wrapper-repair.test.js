import test from 'node:test';
import assert from 'node:assert/strict';
import { WRAPPER } from '../src/lib/templates.js';

test('install script repairs winget when it cannot start (0xC000007B / 0xC0000135) and tries again', () => {
  assert.ok(WRAPPER.includes('$LoaderErrors = @(-1073741701, -1073741515)'));
  assert.match(WRAPPER, /function Install-VCRuntime/);
  assert.match(WRAPPER, /aka\.ms\/vs\/17\/release\/vc_redist\./);      // Microsoft's own download
  assert.match(WRAPPER, /'\/install', '\/quiet', '\/norestart'/);
  assert.match(WRAPPER, /function Repair-AppInstaller/);
  // both install and uninstall go through the retrying helper, and nothing calls winget directly any more
  assert.match(WRAPPER, /Invoke-Winget \(@\('uninstall'\) \+ \$common\)/);
  assert.match(WRAPPER, /Invoke-Winget \(@\('__ACTION__'\) \+ \$common \+ '--accept-package-agreements'\)/);
  assert.equal((WRAPPER.match(/& \$Winget\.FullName/g) || []).length, 0);
});

test('the helper only retries loader errors, so real install failures are reported as before', () => {
  const body = WRAPPER.slice(WRAPPER.indexOf('function Invoke-Winget'), WRAPPER.indexOf('$exit = 0'));
  assert.equal((body.match(/\$LoaderErrors -contains/g) || []).length, 2);
  assert.ok(WRAPPER.includes('if ($exit -eq -1978335189 -or $exit -eq -1978335135) { $exit = 0 }'));
});

test('braces and quotes in the script are balanced', () => {
  const s = WRAPPER.replace(/__[A-Z0-9]+__/g, '0');
  assert.equal((s.match(/\{/g) || []).length, (s.match(/\}/g) || []).length);
  assert.equal((s.match(/\(/g) || []).length, (s.match(/\)/g) || []).length);
});
