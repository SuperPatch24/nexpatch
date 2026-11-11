import test from 'node:test';
import assert from 'node:assert/strict';
import { emailIsConfigured, adminEmailRecipients, escapeHtml, sendBrevoEmail } from '../src/lib/email.js';

test('email configuration requires a key and a valid verified sender address', () => {
  const old = { key: process.env.BREVO_API_KEY, sender: process.env.BREVO_SENDER_EMAIL };
  try {
    delete process.env.BREVO_API_KEY; process.env.BREVO_SENDER_EMAIL = 'notifications@nexpatchonline.com';
    assert.equal(emailIsConfigured(), false);
    process.env.BREVO_API_KEY = 'test-secret';
    assert.equal(emailIsConfigured(), true);
    process.env.BREVO_SENDER_EMAIL = 'not-an-email';
    assert.equal(emailIsConfigured(), false);
  } finally {
    if (old.key === undefined) delete process.env.BREVO_API_KEY; else process.env.BREVO_API_KEY = old.key;
    if (old.sender === undefined) delete process.env.BREVO_SENDER_EMAIL; else process.env.BREVO_SENDER_EMAIL = old.sender;
  }
});

test('admin recipients are parsed and invalid addresses are discarded', () => {
  const old = process.env.BREVO_ADMIN_EMAILS;
  try {
    process.env.BREVO_ADMIN_EMAILS = 'admin@example.com; bad-address, ops@example.com';
    assert.deepEqual(adminEmailRecipients(), ['admin@example.com', 'ops@example.com']);
  } finally { if (old === undefined) delete process.env.BREVO_ADMIN_EMAILS; else process.env.BREVO_ADMIN_EMAILS = old; }
});

test('HTML escaping protects email templates', () => {
  assert.equal(escapeHtml(`<script>\"x\" & 'y'</script>`), '&lt;script&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/script&gt;');
});

test('Brevo send uses API key header and returns message ID', async () => {
  const oldEnv = { key: process.env.BREVO_API_KEY, sender: process.env.BREVO_SENDER_EMAIL, name: process.env.BREVO_SENDER_NAME };
  const oldFetch = globalThis.fetch;
  let captured;
  try {
    process.env.BREVO_API_KEY = 'test-secret';
    process.env.BREVO_SENDER_EMAIL = 'notifications@nexpatchonline.com';
    process.env.BREVO_SENDER_NAME = 'NexpatchOnline';
    globalThis.fetch = async (url, options) => { captured = { url, options }; return { ok: true, status: 201, json: async () => ({ messageId: 'test-message-id' }) }; };
    const result = await sendBrevoEmail({ to: 'person@example.com', subject: 'Test', htmlContent: '<p>Hi</p>' });
    assert.equal(result.sent, true);
    assert.equal(result.messageId, 'test-message-id');
    assert.equal(captured.url, 'https://api.brevo.com/v3/smtp/email');
    assert.equal(captured.options.headers['api-key'], 'test-secret');
    assert.deepEqual(JSON.parse(captured.options.body).to, [{ email: 'person@example.com' }]);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldEnv.key === undefined) delete process.env.BREVO_API_KEY; else process.env.BREVO_API_KEY = oldEnv.key;
    if (oldEnv.sender === undefined) delete process.env.BREVO_SENDER_EMAIL; else process.env.BREVO_SENDER_EMAIL = oldEnv.sender;
    if (oldEnv.name === undefined) delete process.env.BREVO_SENDER_NAME; else process.env.BREVO_SENDER_NAME = oldEnv.name;
  }
});
