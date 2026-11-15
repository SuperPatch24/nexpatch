import { app } from '@azure/functions';
import { withUser, HttpError, readJson } from '../lib/http.js';
import { listRows, putRow, audit } from '../lib/store.js';
import { platformRole } from '../lib/platform.js';
import { listVendorPackages } from '../lib/appfinder.js';
import { runVersionWatch } from '../lib/versionwatch.js';
import { emailIsConfigured, sendBrevoEmail, adminEmailRecipients } from '../lib/email.js';
import { renderEmail } from '../lib/email-templates.js';

const GLOBAL = 'global';
const requireCatalogAdmin = user => { if (!['superadmin', 'catalog'].includes(platformRole(user))) throw new HttpError(403, 'Your platform administrator role does not allow this action.'); };

async function watch(opts, context) {
  const rows = await listRows('Catalog', GLOBAL, 5000);
  const out = await runVersionWatch({
    rows,
    update: (id, patch) => putRow('Catalog', GLOBAL, id, patch, 'Merge'),
    audit: (_who, msg) => audit(GLOBAL, 'system', 'catalog.versions-detected', msg)
  }, opts);
  context?.log?.(`Version watch: ${out.checked} checked, ${out.failed} failed, ${out.changes.length} new version(s)`);
  return out;
}

// Every two hours, a batch of the apps that were checked longest ago (each app at most about once a day).
// Runs before the daily tenant sync so customers see fresh "Latest" versions.
app.timer('versionWatch', {
  schedule: '0 15 */2 * * *',
  handler: async (_t, context) => {
    const out = await watch({ limit: 80 }, context);
    if (out.changes.length && process.env.VERSION_WATCH_EMAIL === 'on' && emailIsConfigured()) {
      try {
        const body = out.changes.slice(0, 40).map(c => `- ${c.name}: ${c.from} to ${c.to}`).join('\n');
        const { html, text } = renderEmail({ template: 'announcement', headline: `${out.changes.length} new app version(s) detected`, body: `These catalog apps have a newer version from their vendor:\n\n${body}\n\nOpen the Admin Center catalog to review them.` });
        for (const to of await adminEmailRecipients()) await sendBrevoEmail({ to, subject: `${out.changes.length} new app version(s) detected`, htmlContent: html, textContent: text, tags: ['version-watch'] }, context);
      } catch (err) { context.warn(`Version watch email failed: ${err.message}`); }
    }
  }
});

app.http('platformCatalogCheckVersions', { methods: ['POST'], authLevel: 'anonymous', route: 'platform/catalog/check-versions', handler: withUser(async (_req, ctx, user) => {
  requireCatalogAdmin(user);
  return await watch({ limit: 40, force: true }, ctx);
}, 'any') });

// Apps whose vendor version went up in the last 45 days.
app.http('platformCatalogUpdates', { methods: ['GET'], authLevel: 'anonymous', route: 'platform/catalog/updates', handler: withUser(async (_req, _ctx, user) => {
  requireCatalogAdmin(user);
  const since = Date.now() - 45 * 864e5;
  const rows = (await listRows('Catalog', GLOBAL, 5000)).filter(r => r.latestChangedAt && Date.parse(r.latestChangedAt) >= since && r.previousVersion);
  return { updates: rows.sort((a, b) => String(b.latestChangedAt).localeCompare(String(a.latestChangedAt))).map(r => ({ id: r.rowKey, name: r.name, from: r.previousVersion, to: r.latestVersion, at: r.latestChangedAt })) };
}, 'any') });

// Everything one vendor publishes on WinGet, marked with what is already in the catalog.
app.http('platformCatalogVendor', { methods: ['POST'], authLevel: 'anonymous', route: 'platform/catalog/vendor', handler: withUser(async (req, _ctx, user) => {
  requireCatalogAdmin(user);
  const { vendor } = await readJson(req);
  let r; try { r = await listVendorPackages(vendor); } catch (err) { throw new HttpError(400, err.message); }
  const have = new Set((await listRows('Catalog', GLOBAL, 5000)).map(x => String(x.winget || '').toLowerCase()).filter(Boolean));
  return { ...r, packages: r.packages.map(p => ({ ...p, inCatalog: have.has(p.id.toLowerCase()) })) };
}, 'any') });
