import { app } from '@azure/functions';
import { withUser, HttpError } from '../lib/http.js';
import { getTenant } from '../lib/store.js';
import { grantedRoles } from '../lib/graph.js';
import { BUNDLE_IDS, bundleStatus } from '../lib/bundles.js';

// GET /api/tenant/permissions – which permission sets this organization has approved, read from Microsoft itself.
// Core is required. App Control and Automation are optional add-ons, each approved on its own.
app.http('tenantPermissions', { methods: ['GET'], authLevel: 'anonymous', route: 'tenant/permissions',
  handler: withUser(async (_req, _c, user) => {
    const t = await getTenant(user.tenantId);
    if (!t || t.status !== 'active') throw new HttpError(409, 'Connect your organization first.');
    const bundles = await Promise.all(BUNDLE_IDS.map(async id => bundleStatus(id, await grantedRoles(user.tenantId, id), t)));
    return { bundles };
  }, 'viewer') });
