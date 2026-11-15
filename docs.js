import { app } from '@azure/functions';
import { withUser, HttpError, readJson } from '../lib/http.js';
import { listRows, getRow, putRow, deleteRow, audit } from '../lib/store.js';
import { platformRole } from '../lib/platform.js';

const T = 'AdminDocs', GLOBAL = 'global', ID = /^[a-z0-9][a-z0-9-]{1,70}$/;
const requireEditor = user => { if (!['superadmin', 'support'].includes(platformRole(user))) throw new HttpError(403, 'Your platform role cannot edit documentation.'); };
const shape = r => ({ id: r.rowKey, audience: r.audience === 'customer' ? 'customer' : 'admin', topic: r.topic || 'General', title: r.title || '', body: r.body || '', published: r.published !== false, updatedBy: r.updatedBy || '', updatedAt: r.updatedAt || '' });

app.http('platformDocsList', { methods: ['GET'], authLevel: 'anonymous', route: 'platform/docs', handler: withUser(async (_q, _c, user) => {
  if (!platformRole(user)) throw new HttpError(403, 'Platform administrators only.');
  return { docs: (await listRows(T, GLOBAL, 1000)).map(shape).sort((a, b) => a.topic.localeCompare(b.topic) || a.title.localeCompare(b.title)) };
}, 'any') });

app.http('platformDocsSave', { methods: ['PUT'], authLevel: 'anonymous', route: 'platform/docs/{id}', handler: withUser(async (req, _c, user) => {
  requireEditor(user);
  const id = String(req.params.id || '').toLowerCase(); if (!ID.test(id)) throw new HttpError(400, 'The guide ID can only use lowercase letters, numbers and dashes.');
  const b = await readJson(req), title = String(b.title || '').trim().slice(0, 140), body = String(b.body || '').slice(0, 30000);
  if (!title || !body.trim()) throw new HttpError(400, 'Enter a title and the guide text.');
  await putRow(T, GLOBAL, id, { audience: b.audience === 'customer' ? 'customer' : 'admin', topic: String(b.topic || 'General').trim().slice(0, 60) || 'General', title, body, published: b.published !== false, updatedBy: user.email || user.userId, updatedAt: new Date().toISOString() }, 'Replace');
  await audit(GLOBAL, user.email || user.userId, 'docs.saved', `${title} (${id})`);
  return shape(await getRow(T, GLOBAL, id));
}, 'any') });

app.http('platformDocsDelete', { methods: ['DELETE'], authLevel: 'anonymous', route: 'platform/docs/{id}', handler: withUser(async (req, _c, user) => {
  requireEditor(user); const id = String(req.params.id || '');
  await deleteRow(T, GLOBAL, id); await audit(GLOBAL, user.email || user.userId, 'docs.removed', id); return { removed: true };
}, 'any') });

// Published guides for customers; shown inside the portal's Documentation page next to the built-in guides.
app.http('customerDocs', { methods: ['GET'], authLevel: 'anonymous', route: 'docs', handler: withUser(async () => ({
  docs: (await listRows(T, GLOBAL, 1000)).map(shape).filter(d => d.audience === 'customer' && d.published).map(({ id, topic, title, body }) => ({ id, topic, title, body })) }), 'viewer') });
