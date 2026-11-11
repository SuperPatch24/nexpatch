import { app } from '@azure/functions';
import { randomUUID } from 'node:crypto';
import { TableClient } from '@azure/data-tables';
import { DefaultAzureCredential } from '@azure/identity';
import { escapeHtml, notifyPlatformAdmins } from '../lib/email.js';

let table;
function leadsTable() {
  if (!table) {
    table = process.env.TABLES_CONNECTION
      ? TableClient.fromConnectionString(process.env.TABLES_CONNECTION, 'SalesLeads', { allowInsecureConnection: true })
      : new TableClient(process.env.TABLES_URL, 'SalesLeads', new DefaultAzureCredential());
  }
  return table;
}
const recent = new Map();
app.http('salesContact', { methods: ['POST'], authLevel: 'anonymous', route: 'sales/contact', handler: async (req, context) => {
  try {
    const size = Number(req.headers.get('content-length') || 0);
    if (size > 8192) return { status: 413, jsonBody: { error: 'The enquiry is too large.' } };
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
    const now = Date.now();
    if (now - (recent.get(ip) || 0) < 30_000) return { status: 429, jsonBody: { error: 'Please wait before sending another enquiry.' } };
    const body = await req.json();
    if (body.website) return { status: 200, jsonBody: { ok: true } }; // honeypot
    const name = String(body.name || '').trim().slice(0, 120);
    const email = String(body.email || '').trim().toLowerCase().slice(0, 254);
    const company = String(body.company || '').trim().slice(0, 160);
    const country = String(body.country || '').trim().slice(0, 80);
    const devices = String(body.devices || '').trim().slice(0, 40);
    const message = String(body.message || '').trim().slice(0, 3000);
    if (!name || !company || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { status: 400, jsonBody: { error: 'Enter your name, company and a valid business email.' } };
    if (!body.consent) return { status: 400, jsonBody: { error: 'Please confirm that we may contact you about this enquiry.' } };
    const client = leadsTable();
    await client.createTable().catch(e => { if (e.statusCode !== 409) throw e; });
    const id = randomUUID();
    await client.createEntity({ partitionKey: 'sales', rowKey: id, name, email, company, country, devices, message,
      source: 'public-website', createdAt: new Date().toISOString(), status: 'new' });
    recent.set(ip, now);
    await notifyPlatformAdmins({ subject: `New NexpatchOnline enterprise enquiry: ${company}`, htmlContent: `<p>A new enterprise enquiry was submitted.</p><p><strong>Name:</strong> ${escapeHtml(name)}</p><p><strong>Company:</strong> ${escapeHtml(company)}</p><p><strong>Email:</strong> ${escapeHtml(email)}</p><p><strong>Country:</strong> ${escapeHtml(country)}</p><p><strong>Devices:</strong> ${escapeHtml(devices)}</p><p><strong>Message:</strong><br>${escapeHtml(message).replaceAll('\n','<br>')}</p>`, textContent: `New enterprise enquiry from ${name} at ${company}. Email: ${email}. Country: ${country}. Devices: ${devices}. Message: ${message}`, tags: ['enterprise-enquiry'] }, context);
    return { status: 200, jsonBody: { ok: true, id } };
  } catch (err) {
    context.error('Sales enquiry failed', err);
    return { status: 500, jsonBody: { error: 'We could not submit your enquiry. Please try again later.' } };
  }
} });
