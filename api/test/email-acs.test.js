import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConnectionString, emailProvider, emailIsConfigured, emailSupportsScheduling, signAcsRequest, sendEmail, emailSenderAddress } from '../src/lib/email.js';

const CS = 'endpoint=https://demo.communication.azure.com/;accesskey=c2VjcmV0LWtleS1ieXRlcw==';
const withEnv = async (env, fn) => {
  const keys = ['ACS_EMAIL_CONNECTION_STRING', 'EMAIL_SENDER', 'BREVO_API_KEY', 'BREVO_SENDER_EMAIL', 'EMAIL_SENDER_NAME', 'BREVO_SENDER_NAME'];
  const old = Object.fromEntries(keys.map(k => [k, process.env[k]])); const f = globalThis.fetch;
  keys.forEach(k => delete process.env[k]); Object.assign(process.env, env);
  try { await fn(); } finally { globalThis.fetch = f; keys.forEach(k => old[k] === undefined ? delete process.env[k] : process.env[k] = old[k]); }
};

test('connection string: only a real Azure Communication Services address with a key is accepted', () => {
  assert.deepEqual(parseConnectionString(CS), { endpoint: 'https://demo.communication.azure.com', host: 'demo.communication.azure.com', key: 'c2VjcmV0LWtleS1ieXRlcw==' });
  assert.equal(parseConnectionString('endpoint=https://demo.communication.azure.com/'), null);                 // no key
  assert.equal(parseConnectionString('endpoint=https://evil.example.com/;accesskey=abc'), null);               // the key is never sent to another host
  assert.equal(parseConnectionString('endpoint=http://demo.communication.azure.com/;accesskey=abc'), null);    // https only
  assert.equal(parseConnectionString(''), null);
});

test('provider: Azure when both Azure settings are set, Brevo only as a fallback, otherwise none', async () => {
  await withEnv({}, () => { assert.equal(emailProvider(), ''); assert.equal(emailIsConfigured(), false); });
  await withEnv({ ACS_EMAIL_CONNECTION_STRING: CS }, () => assert.equal(emailProvider(), ''));                          // needs a sender too
  await withEnv({ ACS_EMAIL_CONNECTION_STRING: CS, EMAIL_SENDER: 'bad' }, () => assert.equal(emailProvider(), ''));
  await withEnv({ ACS_EMAIL_CONNECTION_STRING: CS, EMAIL_SENDER: 'notifications@nexpatchonline.com' }, () => { assert.equal(emailProvider(), 'acs'); assert.equal(emailSupportsScheduling(), false); assert.equal(emailSenderAddress(), 'notifications@nexpatchonline.com'); });
  await withEnv({ BREVO_API_KEY: 'k', BREVO_SENDER_EMAIL: 'a@b.co' }, () => { assert.equal(emailProvider(), 'brevo'); assert.equal(emailSupportsScheduling(), true); });
  await withEnv({ ACS_EMAIL_CONNECTION_STRING: CS, EMAIL_SENDER: 'a@b.co', BREVO_API_KEY: 'k', BREVO_SENDER_EMAIL: 'c@d.co' }, () => assert.equal(emailProvider(), 'acs'));
});

test('request signing matches an independent HMAC-SHA256 calculation', () => {
  const h = signAcsRequest({ pathAndQuery: '/emails:send?api-version=2023-03-31', host: 'demo.communication.azure.com', body: '{"a":1}', key: 'c2VjcmV0LWtleS1ieXRlcw==', date: 'Wed, 25 Nov 2026 12:00:00 GMT' });
  assert.equal(h['x-ms-content-sha256'], 'AVq9f1zFei3ZS3WQ8ErYCEJzkF7jPsXOvq5iJ2qX+GI=');
  assert.equal(h.Authorization, 'HMAC-SHA256 SignedHeaders=x-ms-date;host;x-ms-content-sha256&Signature=9K1Tt8CICnjfHGokaqSFfAikThv1M1wqoMM/aZJyeJA=');
});

test('a message goes to the Azure endpoint, signed, with plain text and without click tracking', async () => {
  await withEnv({ ACS_EMAIL_CONNECTION_STRING: CS, EMAIL_SENDER: 'notifications@nexpatchonline.com' }, async () => {
    let seen;
    globalThis.fetch = async (url, o) => { seen = { url, o }; return { ok: true, status: 202, headers: new Headers(), json: async () => ({ id: 'op-1', status: 'Running' }) }; };
    const r = await sendEmail({ to: ['person@example.com', 'not-an-address'], subject: 'Hi', htmlContent: '<p>Hello <b>there</b></p>', replyTo: 'support@nexpatchonline.com', cc: ['cc@example.com'] }, { warn() {} });
    assert.deepEqual(r, { sent: true, messageId: 'op-1' });
    assert.equal(seen.url, 'https://demo.communication.azure.com/emails:send?api-version=2023-03-31');
    assert.match(seen.o.headers.Authorization, /^HMAC-SHA256 SignedHeaders=x-ms-date;host;x-ms-content-sha256&Signature=/);
    const b = JSON.parse(seen.o.body);
    assert.equal(b.senderAddress, 'notifications@nexpatchonline.com');
    assert.deepEqual(b.recipients.to, [{ address: 'person@example.com' }]);
    assert.deepEqual(b.recipients.cc, [{ address: 'cc@example.com' }]);
    assert.deepEqual(b.replyTo, [{ address: 'support@nexpatchonline.com' }]);
    assert.equal(b.content.plainText, 'Hello there');
    assert.equal(b.userEngagementTrackingDisabled, true);
    assert.equal(seen.o.headers['x-ms-content-sha256'], (await import('node:crypto')).createHash('sha256').update(seen.o.body).digest('base64'));
  });
});

test('too many sends at once: wait and try again; real errors are reported, never thrown', async () => {
  await withEnv({ ACS_EMAIL_CONNECTION_STRING: CS, EMAIL_SENDER: 'notifications@nexpatchonline.com' }, async () => {
    let n = 0;
    globalThis.fetch = async () => (++n === 1 ? { ok: false, status: 429, headers: new Headers({ 'retry-after': '0' }), json: async () => ({}) } : { ok: true, status: 202, headers: new Headers(), json: async () => ({ id: 'op-2' }) });
    assert.equal((await sendEmail({ to: 'a@b.co', subject: 's', htmlContent: 'x' }, { warn() {} })).sent, true); assert.equal(n, 2);
    globalThis.fetch = async () => ({ ok: false, status: 401, headers: new Headers(), json: async () => ({ error: { code: 'Unauthorized', message: 'bad key' } }) });
    assert.deepEqual(await sendEmail({ to: 'a@b.co', subject: 's', htmlContent: 'x' }, { warn() {} }), { sent: false, reason: 'provider-error', status: 401 });
    globalThis.fetch = async () => { throw new Error('offline'); };
    assert.equal((await sendEmail({ to: 'a@b.co', subject: 's', htmlContent: 'x' }, { warn() {} })).reason, 'network-error');
    assert.equal((await sendEmail({ to: 'nope', subject: 's' }, { warn() {} })).reason, 'no-valid-recipient');
  });
});
