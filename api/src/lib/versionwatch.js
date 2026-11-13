// Checks each catalog app's own vendor source for a newer version.
// Sources: WinGet / Microsoft Store (automatic), GitHub releases, or any RSS/Atom feed.
// This only DETECTS and records versions. It never downloads, packages or publishes anything.
import { wingetLatestVersion, storeLatestVersion } from './appfinder.js';
import { compareVersions } from './winget.js';

const UA = { 'User-Agent': 'nexpatch-versionwatch' };
const DEFAULT_PATTERN = '(\\d+(?:\\.\\d+){1,3})';
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

// Feed URLs are fetched by our server, so only public https addresses are allowed (no IP addresses, localhost or internal names).
export function safeFeedUrl(u) {
  let x; try { x = new URL(String(u || '').trim()); } catch { return ''; }
  const h = x.hostname.toLowerCase();
  if (x.protocol !== 'https:' || x.username || x.password) return '';
  if (/^[\d.]+$/.test(h) || h.includes(':') || h === 'localhost' || !h.includes('.') || /\.(local|internal|lan|corp|home|intranet)$/.test(h)) return '';
  return x.toString();
}

export function cleanVersionSource(b = {}) {
  const type = ['github', 'rss'].includes(b.versionSource) ? b.versionSource : 'auto';
  const out = { versionSource: type, versionRepo: '', versionFeed: '', versionPattern: '' };
  if (type === 'github') {
    out.versionRepo = String(b.versionRepo || '').trim();
    if (!REPO_RE.test(out.versionRepo)) return { error: 'Enter the GitHub repository as owner/name, for example notepad-plus-plus/notepad-plus-plus.' };
  }
  if (type === 'rss') {
    out.versionFeed = safeFeedUrl(b.versionFeed);
    if (!out.versionFeed) return { error: 'Enter the feed address as a public https:// URL.' };
  }
  if (type !== 'auto' && b.versionPattern) {
    const p = String(b.versionPattern).trim();
    if (p.length > 80 || /\([^)]*[+*][^)]*\)[+*{]/.test(p)) return { error: 'That version pattern is too complex. Keep it short, for example v(\\d+\\.\\d+\\.\\d+).' };
    try { new RegExp(p); } catch { return { error: 'The version pattern isn’t a valid regular expression.' }; }
    out.versionPattern = p;
  }
  return { value: out };
}

const decode = s => String(s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&').trim();
const tag = (xml, name) => { const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i').exec(xml); return m ? decode(m[1]) : ''; };

// First entry of an RSS or Atom feed -> version number taken from its title.
export function parseFeedLatest(xml, pattern = '') {
  const first = /<(item|entry)\b[\s\S]*?<\/\1>/i.exec(String(xml || ''))?.[0];
  if (!first) throw new Error('The feed has no entries.');
  const title = tag(first, 'title').slice(0, 300);
  const link = (/<link[^>]*href=["']([^"']+)["']/i.exec(first) || [])[1] || tag(first, 'link');
  const m = new RegExp(pattern || DEFAULT_PATTERN).exec(title);
  if (!m) throw new Error(`No version number found in the newest feed title: “${title.slice(0, 80)}”.`);
  return { version: (m[1] || m[0]).replace(/^v/i, ''), title, link, publishedAt: tag(first, 'updated') || tag(first, 'pubDate') || '' };
}

export async function feedLatest(url, pattern, { fetchFn = fetch } = {}) {
  const safe = safeFeedUrl(url); if (!safe) throw new Error('The feed address isn’t allowed.');
  const r = await fetchFn(safe, { headers: { ...UA, Accept: 'application/atom+xml, application/rss+xml, application/xml, text/xml' }, redirect: 'follow', signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error(`The feed returned HTTP ${r.status}.`);
  const text = await r.text();
  return parseFeedLatest(text.slice(0, 1_000_000), pattern);
}

export async function githubLatest(repo, pattern, { fetchFn = fetch, token = process.env.GITHUB_TOKEN } = {}) {
  if (!REPO_RE.test(String(repo || ''))) throw new Error('Invalid GitHub repository.');
  const headers = { Accept: 'application/vnd.github+json', ...UA }; if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetchFn(`https://api.github.com/repos/${repo}/releases/latest`, { headers, signal: AbortSignal.timeout(12000) });
  if (r.status === 404) throw new Error('That repository has no published releases.');
  if (r.status === 403 || r.status === 429) throw new Error('GitHub’s rate limit was reached. Add a GITHUB_TOKEN app setting.');
  if (!r.ok) throw new Error(`GitHub returned HTTP ${r.status}.`);
  const j = await r.json(), tagName = String(j.tag_name || '');
  const m = new RegExp(pattern || DEFAULT_PATTERN).exec(tagName) || new RegExp(DEFAULT_PATTERN).exec(String(j.name || ''));
  if (!m) throw new Error(`No version number found in the release tag “${tagName.slice(0, 60)}”.`);
  return { version: (m[1] || m[0]).replace(/^v/i, ''), publishedAt: j.published_at || '', link: j.html_url || '' };
}

export async function latestVersionFor(entry, opts = {}) {
  const type = entry.versionSource || 'auto';
  if (type === 'github') return githubLatest(entry.versionRepo, entry.versionPattern, opts);
  if (type === 'rss') return feedLatest(entry.versionFeed, entry.versionPattern, opts);
  if (entry.source === 'msstore') return { version: await storeLatestVersion(entry.storeProductId, opts) };
  return { version: await wingetLatestVersion(entry.winget, opts) };
}

// Walks the catalog, oldest-checked first. Records the newest version on each entry and returns the apps whose version went UP.
// A first-ever check only sets a baseline and is not reported as a change.
export async function runVersionWatch({ rows, update, audit }, { limit = 80, minAgeHours = 20, force = false, now = new Date(), opts = {} } = {}) {
  const due = rows.filter(r => r.enabled !== false && (r.source === 'msstore' ? r.verificationStatus === 'verified' : !!r.winget || r.versionSource === 'github' || r.versionSource === 'rss'))
    .filter(r => force || !r.latestCheckedAt || now - Date.parse(r.latestCheckedAt) > minAgeHours * 3600e3)
    .sort((a, b) => String(a.latestCheckedAt || '').localeCompare(String(b.latestCheckedAt || ''))).slice(0, limit);
  const changes = []; let failed = 0;
  for (const r of due) {
    const stamp = now.toISOString();
    try {
      const v = await latestVersionFor(r, opts);
      const old = r.latestVersion || '';
      const patch = { latestVersion: v.version, latestCheckedAt: stamp, latestError: '' };
      if (old && v.version !== old && compareVersions(v.version, old) > 0) { patch.previousVersion = old; patch.latestChangedAt = stamp; changes.push({ id: r.rowKey, name: r.name, from: old, to: v.version }); }
      else if (!old) patch.latestChangedAt = r.latestChangedAt || '';
      await update(r.rowKey, patch);
    } catch (err) {
      failed++;
      await update(r.rowKey, { latestCheckedAt: stamp, latestError: String(err.message).slice(0, 200) });
    }
  }
  if (changes.length && audit) await audit('system', `${changes.length} new version(s): ${changes.slice(0, 10).map(c => `${c.name} ${c.from}→${c.to}`).join('; ')}`);
  return { checked: due.length, failed, changes };
}
