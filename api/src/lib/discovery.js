// WinGet discovery: finds apps from trusted vendors in the public WinGet repository and checks each one
// before a platform admin adds it to the shared catalog. This file has no storage code; network access is
// passed in (fetchFn), so every decision can be tested.
//
// "Ready" means every check passed: HTTPS downloads with a SHA-256 hash, from the vendor's own website,
// a whole-device installer that installs silently, and a named publisher and licence.
// "Review" means it can be packaged but one check needs a person (usually a download from a third-party host).
// "Skip" means it can't be deployed by Intune as is (portable or per-user only).
import { compareVersions } from './winget.js';

const GH_API = 'https://api.github.com';
const GH_RAW = 'https://raw.githubusercontent.com/microsoft/winget-pkgs/master';
const UA = { 'User-Agent': 'nexpatch-discovery' };
export const VENDOR_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{1,60}$/;
export const WINGET_ID = /^[A-Za-z0-9][A-Za-z0-9.+_-]{1,100}$/;
export const RECHECK_DAYS = 7;

// Publisher folder names as they appear in microsoft/winget-pkgs (checked against the repository).
// Platform admins can add or remove vendors in the Admin Center.
export const DEFAULT_VENDORS = ['Adobe', 'Amazon', 'AgileBits', 'Atlassian', 'Audacity', 'Bitwarden', 'BlenderFoundation', 'Box', 'Brave',
  'Cisco', 'Citrix', 'Dell', 'Discord', 'Docker', 'DominikReichl', 'Dropbox', 'Figma', 'Foxit', 'GIMP', 'Git', 'GitHub', 'Google',
  'Greenshot', 'HP', 'IgorPavlov', 'Inkscape', 'Intel', 'IrfanSkiljan', 'JetBrains', 'KeePassXCTeam', 'Lenovo', 'Logitech',
  'Malwarebytes', 'Mattermost', 'Microsoft', 'Mozilla', 'Notepad++', 'Notion', 'OBSProject', 'OpenJS', 'Opera', 'Oracle', 'Postman',
  'PuTTY', 'Python', 'RARLab', 'RealVNC', 'RingCentral', 'ShareX', 'SlackTechnologies', 'Splashtop', 'Spotify', 'SumatraPDF',
  'TeamViewer', 'TheDocumentFoundation', 'VideoLAN', 'Vivaldi', 'VMware', 'WinSCP', 'WiresharkFoundation', 'Zoom'];

const SILENT_TYPES = new Set(['msi', 'wix', 'burn', 'nullsoft', 'inno', 'msix', 'appx']);
const unq = v => String(v ?? '').trim().replace(/^(['"])(.*)\1$/, '$2');

// Reads the parts of a WinGet installer manifest we need. Root-level installer fields apply to every installer
// unless the installer overrides them (that is how WinGet itself reads them).
export function parseInstallerManifest(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const root = {}, installers = [];
  let inList = false, cur = null, nested = null, nestedIndent = 0, rootNested = null;
  const setKV = (obj, key, val) => { obj[key] = unq(val); };
  for (const raw of lines) {
    if (!raw.trim() || /^\s*#/.test(raw)) continue;
    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();
    if (indent === 0 && !line.startsWith('- ')) {
      inList = false; cur = null; nested = null; rootNested = null;
      const m = /^([A-Za-z0-9]+):\s*(.*)$/.exec(line); if (!m) continue;
      if (m[1] === 'Installers') { inList = true; continue; }
      if (m[2] === '') { rootNested = m[1]; root[m[1]] = {}; } else setKV(root, m[1], m[2]);
      continue;
    }
    if (rootNested && indent > 0 && !inList) { const m = /^([A-Za-z0-9]+):\s*(.*)$/.exec(line); if (m && typeof root[rootNested] === 'object') setKV(root[rootNested], m[1], m[2]); continue; }
    if (!inList) continue;
    if (indent === 0 && line.startsWith('- ')) {
      cur = {}; installers.push(cur); nested = null;
      const m = /^-\s+([A-Za-z0-9]+):\s*(.*)$/.exec(line); if (m) { if (m[2] === '') { nested = m[1]; nestedIndent = 2; cur[m[1]] = {}; } else setKV(cur, m[1], m[2]); }
      continue;
    }
    if (!cur) continue;
    const m = /^-?\s*([A-Za-z0-9]+):\s*(.*)$/.exec(line);
    if (indent === 2 && m && !line.startsWith('-')) {
      nested = null;
      if (m[2] === '') { nested = m[1]; nestedIndent = indent; cur[m[1]] = {}; } else setKV(cur, m[1], m[2]);
    } else if (nested && (indent > nestedIndent || (indent === nestedIndent && line.startsWith('-'))) && m && typeof cur[nested] === 'object' && !Array.isArray(cur[nested])) {
      if (!(m[1] in cur[nested])) setKV(cur[nested], m[1], m[2]);   // first DisplayName in AppsAndFeaturesEntries wins
    }
  }
  const pick = (i, k) => i[k] !== undefined ? i[k] : root[k];
  const list = installers.map(i => ({
    arch: pick(i, 'Architecture') || '', type: String(pick(i, 'InstallerType') || '').toLowerCase(),
    nestedType: String(pick(i, 'NestedInstallerType') || '').toLowerCase(), scope: String(pick(i, 'Scope') || '').toLowerCase(),
    url: i.InstallerUrl || '', sha256: i.InstallerSha256 || '',
    silent: !!((i.InstallerSwitches || root.InstallerSwitches || {}).Silent || (i.InstallerSwitches || root.InstallerSwitches || {}).SilentWithProgress),
    displayName: (i.AppsAndFeaturesEntries || root.AppsAndFeaturesEntries || {}).DisplayName || '',
    productCode: i.ProductCode || root.ProductCode || ''
  }));
  return { id: root.PackageIdentifier || '', version: root.PackageVersion || '', installers: list };
}

export function parseLocaleManifest(text) {
  const t = String(text || '').replace(/\r/g, '');
  const get = k => { const m = new RegExp(`^${k}:[ \\t]*(.+)$`, 'm').exec(t); return m ? unq(m[1]) : ''; };
  const tags = []; const tm = /^Tags:\s*\n((?:\s*-\s*.+\n?)+)/m.exec(t);
  if (tm) for (const l of tm[1].split('\n')) { const x = /^\s*-\s*(.+)$/.exec(l); if (x) tags.push(unq(x[1]).toLowerCase()); }
  return { publisher: get('Publisher'), name: get('PackageName'), license: get('License'), publisherUrl: get('PublisherUrl'),
    packageUrl: get('PackageUrl'), supportUrl: get('PublisherSupportUrl'), description: get('ShortDescription'), tags };
}

const TWO_PART = /\.(co|com|net|org|gov|ac|edu)\.[a-z]{2}$/;
export function siteOf(url) {
  let h; try { const u = new URL(url); if (u.protocol !== 'https:' && u.protocol !== 'http:') return ''; h = u.hostname.toLowerCase(); } catch { return ''; }
  const parts = h.split('.'); if (parts.length < 2) return h;
  return parts.slice(TWO_PART.test(h) ? -3 : -2).join('.');
}
// Code hosts are never "the vendor's website" by themselves; their downloads are matched by repository owner instead.
const CODE_HOSTS = new Set(['github.com', 'githubusercontent.com', 'sourceforge.net', 'gitlab.com']);
// Download domains a vendor runs under another name (confirmed vendor-owned).
const SITE_ALIASES = { 'mozilla.org': ['mozilla.net'] };
const githubOwner = url => { try { const u = new URL(url); return u.hostname.toLowerCase() === 'github.com' ? (u.pathname.split('/')[1] || '').toLowerCase() : ''; } catch { return ''; } };

const ARCH_RANK = { x64: 3, neutral: 2, x86: 1, arm64: 0 };
const deployable = i => i.type !== 'portable' && !(i.type === 'zip' && (!i.nestedType || i.nestedType === 'portable')) && i.scope !== 'user';
const silentOk = i => SILENT_TYPES.has(i.type) || SILENT_TYPES.has(i.nestedType) || i.silent;

// The installer Intune would get: whole-device, silent, preferring x64.
export function bestInstaller(installers) {
  return [...installers].filter(i => deployable(i) && silentOk(i))
    .sort((a, b) => (ARCH_RANK[b.arch] ?? -1) - (ARCH_RANK[a.arch] ?? -1) || (b.scope === 'machine') - (a.scope === 'machine'))[0] || null;
}

export function categoryOf(tags = [], name = '', description = '') {
  const t = ` ${tags.join(' ')} ${name} ${description} `.toLowerCase();
  const rules = [['Browsers', /browser|chromium/], ['Security', /password|vpn|antivirus|security|encrypt/], ['Communication', /chat|meeting|video call|messag|voip|conferenc/],
    ['Developer tools', /developer|ide\b|editor|git\b|sdk|runtime|terminal|database|api/], ['Media', /media|video|audio|music|player|photo|image/],
    ['Documents', /pdf|office|document|spreadsheet|note/], ['Utilities', /zip|archive|compress|utility|screenshot|remote/]];
  return (rules.find(([, re]) => re.test(t)) || ['Other'])[0];
}

// Checks one package version. Returns the verdict and the reasons a person can read.
export function assessPackage({ id, version, installerText, localeText }) {
  const m = parseInstallerManifest(installerText), loc = parseLocaleManifest(localeText);
  const checks = [], add = (name, ok, detail = '') => checks.push({ name, ok: !!ok, detail });
  const all = m.installers;
  add('Manifest matches the package', m.id.toLowerCase() === String(id).toLowerCase() && all.length > 0, m.id || 'no installer manifest');
  const best = bestInstaller(all);
  add('Installs for the whole device', all.some(deployable), all.some(deployable) ? '' : 'Only portable or per-user installers');
  add('Installs silently', !!best, best ? best.type : 'No silent, whole-device installer');
  const urls = all.map(i => i.url).filter(Boolean);
  add('Downloads use HTTPS', urls.length > 0 && urls.every(u => /^https:\/\//i.test(u)), urls.find(u => !/^https:/i.test(u)) || '');
  add('Every download has a SHA-256 hash', all.length > 0 && all.every(i => /^[0-9a-f]{64}$/i.test(i.sha256)));
  const vendorSites = new Set([loc.publisherUrl, loc.packageUrl, loc.supportUrl].map(siteOf).filter(s => s && !CODE_HOSTS.has(s)));
  // A GitHub download counts as the vendor's own when the repository owner is the vendor (listed on GitHub, or named like its website).
  const owners = new Set([loc.publisherUrl, loc.packageUrl, loc.supportUrl].map(githubOwner).filter(Boolean));
  for (const s of vendorSites) owners.add(s.split('.')[0]);
  for (const s of [...vendorSites]) for (const alias of SITE_ALIASES[s] || []) vendorSites.add(alias);
  const from = best?.url || urls[0] || '';
  const own = !!from && (vendorSites.has(siteOf(from)) || (!!githubOwner(from) && owners.has(githubOwner(from))));
  add('Download comes from the vendor’s own website', own, from ? siteOf(from) + (vendorSites.size ? ' (vendor: ' + [...vendorSites].join(', ') + ')' : ' (no vendor website listed)') : '');
  add('Publisher, name and licence listed', !!(loc.publisher && loc.name && loc.license), [loc.publisher, loc.license].filter(Boolean).join(', '));
  const failed = checks.filter(c => !c.ok).map(c => c.name);
  const cannot = failed.some(n => n === 'Installs for the whole device' || n === 'Installs silently' || n === 'Manifest matches the package');
  const verdict = cannot ? 'skip' : failed.length ? 'review' : 'ready';
  return {
    id, version: version || m.version, verdict, checks, reason: failed.join('; '),
    name: (loc.name || id).slice(0, 120), publisher: (loc.publisher || '').slice(0, 120), license: (loc.license || '').slice(0, 80),
    description: (loc.description || '').slice(0, 300), category: categoryOf(loc.tags, loc.name, loc.description),
    installerType: best?.type || '', arch: best?.arch || '', displayName: (best?.displayName || String(loc.name || '').replace(/\s*\([^)]*\)\s*$/, '')).slice(0, 200),   // the name in Installed apps, used for detection (prefix match)
    vendorSite: [...vendorSites][0] || ''
  };
}

// Packages to (re)check for one vendor: never checked or checked more than RECHECK_DAYS ago, oldest first.
export function packagesDue(packages, results, { now = Date.now(), limit = 40 } = {}) {
  const seen = new Map(results.map(r => [String(r.id).toLowerCase(), r]));
  const age = p => { const r = seen.get(p.id.toLowerCase()); return r?.checkedAt ? now - Date.parse(r.checkedAt) : Infinity; };
  return packages.filter(p => age(p) > RECHECK_DAYS * 864e5).sort((a, b) => age(b) - age(a)).slice(0, limit);
}

export function summarize(results) {
  const c = { ready: 0, review: 0, skip: 0, inCatalog: 0, total: results.length };
  for (const r of results) { if (c[r.verdict] !== undefined) c[r.verdict]++; if (r.inCatalog) c.inCatalog++; }
  return c;
}

const ghHeaders = token => ({ Accept: 'application/vnd.github+json', ...UA, ...(token ? { Authorization: `Bearer ${token}` } : {}) });
const pkgPath = id => ['manifests', id.split('.')[0][0].toLowerCase(), ...id.split('.')].map(encodeURIComponent).join('/');

export class RateLimited extends Error {}

// Reads the newest version's manifests for one package and assesses it.
export async function discoverPackage(id, { fetchFn = fetch, token = process.env.GITHUB_TOKEN } = {}) {
  if (!WINGET_ID.test(id)) throw new Error('Invalid package ID.');
  const r = await fetchFn(`${GH_API}/repos/microsoft/winget-pkgs/contents/${pkgPath(id)}`, { headers: ghHeaders(token), signal: AbortSignal.timeout(12000) });
  if (r.status === 403 || r.status === 429) throw new RateLimited('GitHub’s rate limit was reached. Add a GITHUB_TOKEN app setting, or wait an hour.');
  if (!r.ok) throw new Error(`GitHub returned HTTP ${r.status}.`);
  const versions = (await r.json()).filter(i => i.type === 'dir' && /^[0-9]/.test(i.name)).map(i => i.name);
  if (!versions.length) return { id, verdict: 'skip', reason: 'No versions found', checks: [], name: id.split('.').slice(1).join(' '), version: '' };
  const version = versions.sort(compareVersions).pop();
  const base = `${GH_RAW}/${pkgPath(id)}/${encodeURIComponent(version)}/${id}`;
  const get = async u => { try { const x = await fetchFn(u, { headers: UA, signal: AbortSignal.timeout(12000) }); return x.ok ? await x.text() : ''; } catch { return ''; } };
  const [installerText, localeText] = await Promise.all([get(`${base}.installer.yaml`), get(`${base}.locale.en-US.yaml`)]);
  return assessPackage({ id, version, installerText, localeText });
}
