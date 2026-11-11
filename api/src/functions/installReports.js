import { createHash } from 'node:crypto';
import { app } from '@azure/functions';
import { withUser, HttpError, readJson } from '../lib/http.js';
import { putRow, audit } from '../lib/store.js';

app.http('installReportsImport', {
  methods: ['POST'], authLevel: 'anonymous', route: 'reports/install-results',
  handler: withUser(async (req, _ctx, user) => {
    const body = await readJson(req);
    if (!Array.isArray(body.reports) || body.reports.length > 500) throw new HttpError(400, 'Provide up to 500 application install-result rows.');
    const at = new Date().toISOString();
    let saved = 0;
    for (const item of body.reports) {
      const appName = String(item?.app || '').trim().slice(0, 160);
      if (!appName) continue;
      const key = createHash('sha1').update(appName.toLowerCase()).digest('hex');
      const fields = {
        app: appName,
        version: String(item.version || '').slice(0, 80),
        installed: Math.max(0, Math.min(10000000, Number(item.installed) || 0)),
        pending: Math.max(0, Math.min(10000000, Number(item.pending) || 0)),
        failed: Math.max(0, Math.min(10000000, Number(item.failed) || 0)),
        other: Math.max(0, Math.min(10000000, Number(item.other) || 0)),
        errors: JSON.stringify(Array.isArray(item.errors) ? item.errors.slice(0, 30) : []),
        source: 'Intune device install status export',
        importedAt: at,
        importedBy: user.email || user.userId
      };
      await putRow('InstallReports', user.tenantId, key, fields, 'Replace');
      saved++;
    }
    await audit(user.tenantId, user.email || user.userId, 'imported Intune install reports', `${saved} applications`);
    return { saved, importedAt: at };
  }, 'admin')
});
