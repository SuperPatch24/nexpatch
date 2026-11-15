import test from 'node:test';
import assert from 'node:assert/strict';
import { TEMPLATES, renderEmail, safeColor, safeUrl, fillVars } from '../src/lib/email-templates.js';

test('every built-in template renders and has a visible accent color', () => {
  for (const id of Object.keys(TEMPLATES)) {
    const { html, text } = renderEmail({ template: id, headline: TEMPLATES[id].headline, body: TEMPLATES[id].body, vars: { name: 'Sam', date: 'Friday' } });
    assert.ok(html.includes('NexpatchOnline') && text.length > 0, id);
    assert.ok(!/\{\{/.test(html), `${id} left an unfilled variable`);
  }
});
test('admin text is escaped, bullets become a list, and only https buttons are allowed', () => {
  const { html } = renderEmail({ headline: '<script>x</script>', body: 'Hi <b>there</b>\n\n- one\n- two', ctaText: 'Open', ctaUrl: 'https://example.com/a?b=1&c=2' });
  assert.ok(!html.includes('<script>') && !html.includes('<b>there'));
  assert.ok(html.includes('<ul') && html.includes('<li'));
  assert.ok(html.includes('href="https://example.com/a?b=1&amp;c=2"'));
  assert.equal(renderEmail({ body: 'x', ctaText: 'Go', ctaUrl: 'javascript:alert(1)' }).html.includes('javascript:'), false);
  assert.equal(safeUrl('http://insecure.test'), ''); assert.equal(safeUrl('https://ok.test'), 'https://ok.test/');
});
test('brand color is validated and variables are filled', () => {
  assert.equal(safeColor('red'), '#3B4FD8'); assert.equal(safeColor('#112233'), '#112233');
  assert.equal(fillVars('Hello {{ name }} / {{missing}}', { name: 'Sam' }), 'Hello Sam / ');
});
