import { app } from '@azure/functions';
import { withUser, HttpError } from '../lib/http.js';
import { getTenant } from '../lib/store.js';
import { graph } from '../lib/graph.js';

// GET /api/groups?search=pil – Entra groups whose name starts with the text, for assignment pickers.
app.http('groupsSearch', {
  methods: ['GET'], authLevel: 'anonymous', route: 'groups',
  handler: withUser(async (req, _ctx, user) => {
    const t = await getTenant(user.tenantId);
    if (!t || t.status !== 'active') throw new HttpError(409, 'Connect your organization first.');
    const q = String(req.query.get('search') || '').trim().slice(0, 100);
    if (q.length < 2) return { groups: [] };
    const filter = encodeURIComponent(`startswith(displayName,'${q.replace(/'/g, "''")}')`);
    const res = await graph(user.tenantId, `/v1.0/groups?$filter=${filter}&$select=id,displayName,description,securityEnabled,mailEnabled,groupTypes&$top=15`);
    const groups = (res.value || []).map(g => ({
      id: g.id, name: g.displayName, description: g.description || '',
      kind: (g.groupTypes || []).includes('DynamicMembership') ? 'Dynamic' : (g.groupTypes || []).includes('Unified') ? 'Microsoft 365' : g.securityEnabled ? 'Security' : 'Distribution'
    })).sort((a, b) => a.name.localeCompare(b.name));
    return { groups };
  }, 'admin')
});
