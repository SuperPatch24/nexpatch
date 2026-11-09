import { app } from '@azure/functions';
import { listActiveTenants } from '../lib/store.js';
import { syncInventory } from '../lib/inventory.js';
import { planStatus } from '../lib/plan.js';

// Every day at 07:00 UTC (early morning in North America), refresh every connected organization.
app.timer('nightlySync', {
  schedule: '0 0 7 * * *',
  handler: async (_timer, context) => {
    const tenants = await listActiveTenants();
    context.log(`Nightly sync for ${tenants.length} tenant(s)`);
    for (const t of tenants.filter(x => planStatus(x).active)) {
      try {
        const r = await syncInventory(t.rowKey, 'nightly');
        context.log(`Tenant ${t.rowKey}: ${r.count} app versions`);
      } catch (err) {
        context.warn(`Tenant ${t.rowKey}: sync failed – ${err.message}`);
      }
    }
  }
});
