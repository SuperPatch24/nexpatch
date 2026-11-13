// App finder: searches WinGet (community repo) and the Microsoft Store (winget msstore source) by name,
// then VERIFIES each match before it can enter the catalog. Nothing here invents an ID: every value
// returned comes from a manifest that was just fetched, and a result is only `verified` when every check passes.
// All network access goes through an injectable `fetchFn` so the logic is unit-testable without internet.
const STORE_API = 'https://storeedgefd.dsx.mp.microsoft.com/v9.0';
const GH_API = 'https://api.github.com';
const GH_RAW = 'https://raw.githubusercontent.com/microsoft/winget-pkgs/master';
const UA = { 'User-Agent': 'nexpatch-appfinder' };
const WINGET_ID = /^[A-Za-z0-9][A-Za-z0-9.+_-]{1,100}$/;
const STORE_ID = /^[A-Z0-9]{8,16}$/i;

export const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
export function similarity(query, name) {
  const q = norm(query), n = norm(name);
  if (!q || !n) return 0;
  if (q === n) return 1;
  const qt = q.split(' '), nt = new Set(n.split(' '));
  const hit = qt.filter(t => nt.has(t)).length / qt.length;
  return (n.includes(q) || q.includes(n)) ? Math.max(0.8, hit) : hit * 0.7;
}

// Category: derived only from tags / description the source returned; blank when nothing matches (admin can fill it in).
const CATEGORY_RULES = [
  ['Browsers and utilities', /\b(browser|web ?browser|utility|utilities|archiver|compression|file manager|pdf)\b/],
  ['Developer and IT', /\b(developer|programming|ide|code editor|git|terminal|devops|sysadmin|remote desktop|vpn|database|api)\b/],
  ['Communication', /\b(chat|messaging|video call|conferenc|email|collaboration|voip)\b/],
  ['Media', /\b(music|video|audio|player|streaming|podcast|media)\b/],
  ['Security', /\b(security|antivirus|password|encryption|firewall)\b/],
  ['Design and creative', /\b(design|photo|image editor|graphics|drawing|3d|illustration)\b/],
  ['Productivity', /\b(productivity|office|notes|note-taking|calendar|task|document|spreadsheet|writing)\b/],
];
export function categoryFrom(...texts) {
  const hay = texts.flat().filter(Boolean).join(' ').toLowerCase();
  for (const [cat, re] of CATEGORY_RULES) if (re.test(hay)) return cat;
  return '';
}

// Minimal reader for the flat keys we need from a WinGet YAML manifest (avoids a YAML dependency).
export function yamlScalar(text, key) {
  const m = new RegExp(`^${key}:[ \\t]*(.+?)[ \\t]*$`, 'mi').exec(text);
  return m ? m[1].replace(/^['"]|['"]$/g, '') : '';
}
export function yamlList(text, key) {
  const m = new RegExp(`^${key}:[ \\t]*\\r?\\n((?:[ \\t]*-[ \\t]*.+\\r?\\n?)+)`, 'mi').exec(text);
  return m ? m[1].split(/\r?\n/).map(l => l.replace(/^[ \t]*-[ \t]*/, '').trim().replace(/^['"]|['"]$/g, '')).filter(Boolean) : [];
}
export const installerUrls = text => [...text.matchAll(/^[ \t-]*InstallerUrl:[ \t]*(\S+)/gmi)].map(m => m[1].replace(/^['"]|['"]$/g, ''));

async function reachable(url, fetchFn) {
  try {
    const u = new URL(url); if (u.protocol !== 'https:') return false;
    let r = await fetchFn(url, { method: 'HEAD', redirect: 'follow', headers: UA, signal: AbortSignal.timeout(10000) });
    if (r.status === 405 || r.status === 403) r = await fetchFn(url, { method: 'GET', redirect: 'follow', headers: { ...UA, Range: 'bytes=0-0' }, signal: AbortSignal.timeout(10000) });
    return r.ok || r.status === 206;
  } catch { return false; }
}
const check = (name, ok, detail = '') => ({ name, ok: !!ok, detail });
const verdict = checks => (checks.length && checks.every(c => c.ok)) ? 'verified' : 'failed';

// ---------------------------------------------------------------- Microsoft Store (winget msstore source)
export async function verifyStore(productId, { fetchFn = fetch } = {}) {
  const id = String(productId || '').toUpperCase();
  const checks = [check('Product ID format', STORE_ID.test(id), id)];
  if (!checks[0].ok) return { status: 'failed', checks };
  let manifest = null;
  try {
    const r = await fetchFn(`${STORE_API}/packageManifests/${id}`, { headers: { ...UA, Accept: 'application/json' }, signal: AbortSignal.timeout(12000) });
    if (r.ok) manifest = (await r.json())?.Data || null;
    checks.push(check('Store manifest found', !!manifest, r.ok ? '' : `HTTP ${r.status}`));
  } catch (e) { checks.push(check('Store manifest found', false, 'Could not reach the Microsoft Store service.')); }
  if (!manifest) return { status: 'failed', checks };
  const ver = (manifest.Versions || [])[0] || {};
  const loc = ver.DefaultLocale || {};
  checks.push(check('Product ID matches the manifest', String(manifest.PackageIdentifier || '').toUpperCase() === id, manifest.PackageIdentifier));
  checks.push(check('Publisher present', !!loc.Publisher, loc.Publisher || ''));
  checks.push(check('Name present', !!loc.PackageName, loc.PackageName || ''));
  checks.push(check('Installable from the Store source', (ver.Installers || []).some(i => String(i.InstallerType).toLowerCase() === 'msstore'), ''));
  const url = `https://apps.microsoft.com/detail/${id}`;
  checks.push(check('Store page reachable', await reachable(url, fetchFn), url));
  return { status: verdict(checks), checks, name: loc.PackageName || '', publisher: loc.Publisher || '', url, version: ver.PackageVersion || '',
    category: categoryFrom(loc.Tags, loc.ShortDescription, loc.PackageName) };
}

export async function searchStore(query, { fetchFn = fetch } = {}) {
  const r = await fetchFn(`${STORE_API}/manifestSearch`, { method: 'POST', headers: { ...UA, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ MaximumResults: 10, Query: { KeyWord: String(query).slice(0, 100), MatchType: 'Substring' } }), signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error(`The Microsoft Store search failed (HTTP ${r.status}).`);
  return ((await r.json())?.Data || []).map(x => ({ id: String(x.PackageIdentifier || ''), name: x.PackageName || '', publisher: x.Publisher || '' })).filter(x => STORE_ID.test(x.id));
}

// ---------------------------------------------------------------- WinGet community repository
function ghHeaders(token) { const h = { Accept: 'application/vnd.github+json', ...UA }; if (token) h.Authorization = `Bearer ${token}`; return h; }
const pkgPath = id => ['manifests', id.split('.')[0][0].toLowerCase(), ...id.split('.')].map(encodeURIComponent).join('/');

export async function verifyWinget(id, { fetchFn = fetch, token = process.env.GITHUB_TOKEN, compare } = {}) {
  const checks = [check('Package ID format', WINGET_ID.test(String(id || '')), id)];
  if (!checks[0].ok) return { status: 'failed', checks };
  let version = '';
  try {
    const r = await fetchFn(`${GH_API}/repos/microsoft/winget-pkgs/contents/${pkgPath(id)}`, { headers: ghHeaders(token), signal: AbortSignal.timeout(12000) });
    if (r.ok) {
      const dirs = (await r.json()).filter(i => i.type === 'dir' && /^[0-9]/.test(i.name)).map(i => i.name);
      version = dirs.sort(compare || ((a, b) => a.localeCompare(b, undefined, { numeric: true }))).pop() || '';
    }
    checks.push(check('Package exists in the WinGet repository', !!version, r.ok ? '' : `HTTP ${r.status}`));
  } catch { checks.push(check('Package exists in the WinGet repository', false, 'Could not reach GitHub.')); }
  if (!version) return { status: 'failed', checks };
  const base = `${GH_RAW}/${pkgPath(id)}/${encodeURIComponent(version)}/${id}`;
  const get = async url => { try { const r = await fetchFn(url, { headers: UA, signal: AbortSignal.timeout(12000) }); return r.ok ? await r.text() : ''; } catch { return ''; } };
  const [inst, loc] = await Promise.all([get(`${base}.installer.yaml`), get(`${base}.locale.en-US.yaml`)]);
  checks.push(check('Installer manifest matches the ID', yamlScalar(inst, 'PackageIdentifier').toLowerCase() === id.toLowerCase(), version));
  const urls = installerUrls(inst);
  const okUrl = urls.length ? await reachable(urls[0], fetchFn) : false;
  checks.push(check('Installer download reachable', okUrl, urls[0] || 'no InstallerUrl'));
  const publisher = yamlScalar(loc, 'Publisher'), name = yamlScalar(loc, 'PackageName');
  checks.push(check('Publisher and name present', !!(publisher && name), `${publisher} / ${name}`));
  return { status: verdict(checks), checks, name, publisher, version, installerType: yamlScalar(inst, 'InstallerType'),
    category: categoryFrom(yamlList(loc, 'Tags'), yamlScalar(loc, 'ShortDescription'), name) };
}

export async function searchWinget(query, { fetchFn = fetch, token = process.env.GITHUB_TOKEN } = {}) {
  if (!token) throw new Error('WinGet search needs a GITHUB_TOKEN app setting (GitHub only allows code search when signed in). Store search still works.');
  const q = encodeURIComponent(`${String(query).slice(0, 80)} repo:microsoft/winget-pkgs path:manifests extension:yaml in:path`);
  const r = await fetchFn(`${GH_API}/search/code?q=${q}&per_page=20`, { headers: ghHeaders(token), signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error(`The WinGet search failed (HTTP ${r.status}).`);
  const ids = new Set();
  for (const item of (await r.json()).items || []) {
    const m = /\/([^/]+)\.(?:installer|locale\.[^.]+|)\.?yaml$/i.exec(item.path || '');
    const id = m ? m[1].replace(/\.(installer|locale\.[A-Za-z-]+)$/i, '') : '';
    if (WINGET_ID.test(id)) ids.add(id);
  }
  return [...ids].map(id => ({ id, name: id.split('.').slice(1).join(' ') || id, publisher: id.split('.')[0] }));
}

// ---------------------------------------------------------------- Orchestration
// Returns the best verified matches for a name. Unverified matches are reported with the failed check so the admin can see why.
export async function findApps(query, opts = {}) {
  const q = String(query || '').trim();
  if (q.length < 2) throw new Error('Enter at least two characters of the app name.');
  const notes = [], out = [];
  const [store, winget] = await Promise.allSettled([searchStore(q, opts), searchWinget(q, opts)]);
  if (store.status === 'rejected') notes.push(store.reason.message);
  if (winget.status === 'rejected') notes.push(winget.reason.message);
  const rank = list => list.map(x => ({ ...x, score: similarity(q, x.name || x.id) })).sort((a, b) => b.score - a.score).slice(0, 3);
  const jobs = [
    ...(store.status === 'fulfilled' ? rank(store.value).map(x => ['msstore', x]) : []),
    ...(winget.status === 'fulfilled' ? rank(winget.value).map(x => ['winget', x]) : [])];
  await Promise.all(jobs.map(async ([source, x]) => {
    const v = source === 'msstore' ? await verifyStore(x.id, opts) : await verifyWinget(x.id, opts);
    const name = v.name || x.name;
    out.push({ source, id: x.id, name, publisher: v.publisher || x.publisher, category: v.category || '', version: v.version || '',
      url: source === 'msstore' ? v.url : '', status: v.status, checks: v.checks, score: Math.max(x.score, similarity(q, name)) });
  }));
  out.sort((a, b) => (b.status === 'verified') - (a.status === 'verified') || b.score - a.score);
  return { results: out, notes };
}

// ---------------------------------------------------------------- Vendor browsing and latest-version lookups
export async function wingetLatestVersion(id, { fetchFn = fetch, token = process.env.GITHUB_TOKEN } = {}) {
  if (!WINGET_ID.test(String(id || ''))) throw new Error('That isn’t a valid WinGet package ID.');
  const r = await fetchFn(`${GH_API}/repos/microsoft/winget-pkgs/contents/${pkgPath(id)}`, { headers: ghHeaders(token), signal: AbortSignal.timeout(12000) });
  if (r.status === 404) throw new Error(`WinGet has no package called ${id}.`);
  if (r.status === 403 || r.status === 429) throw new Error('GitHub’s rate limit was reached. Add a GITHUB_TOKEN app setting.');
  if (!r.ok) throw new Error(`WinGet lookup failed (HTTP ${r.status}).`);
  const dirs = (await r.json()).filter(i => i.type === 'dir' && /^[0-9]/.test(i.name)).map(i => i.name);
  if (!dirs.length) throw new Error(`No versions found for ${id} on WinGet.`);
  return dirs.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).pop();
}

async function ghTree(sha, { fetchFn, token }) {
  const r = await fetchFn(`${GH_API}/repos/microsoft/winget-pkgs/git/trees/${sha}`, { headers: ghHeaders(token), signal: AbortSignal.timeout(15000) });
  if (r.status === 403 || r.status === 429) throw new Error('GitHub’s rate limit was reached. Add a GITHUB_TOKEN app setting and try again.');
  if (!r.ok) throw new Error(`GitHub returned HTTP ${r.status}.`);
  const j = await r.json();
  return { entries: j.tree || [], truncated: !!j.truncated };
}

// Lists every package a vendor (publisher) has in the WinGet repository, e.g. "Microsoft" or "Oracle".
// Names come straight from the repository's folder tree; nothing is verified until you add a package.
export async function listVendorPackages(vendor, { fetchFn = fetch, token = process.env.GITHUB_TOKEN } = {}) {
  const v = String(vendor || '').trim().replace(/\s+/g, '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{1,60}$/.test(v)) throw new Error('Enter a vendor name, for example Microsoft or Oracle.');
  const opts = { fetchFn, token };
  const root = await ghTree('master', opts);
  const manifests = root.entries.find(e => e.path === 'manifests' && e.type === 'tree');
  if (!manifests) throw new Error('Couldn’t read the WinGet repository layout.');
  const letter = (await ghTree(manifests.sha, opts)).entries.find(e => e.path === v[0].toLowerCase() && e.type === 'tree');
  if (!letter) return { vendor: '', packages: [], suggestions: [], truncated: false };
  const publishers = (await ghTree(letter.sha, opts)).entries.filter(e => e.type === 'tree');
  const exact = publishers.find(e => e.path.toLowerCase() === v.toLowerCase());
  if (!exact) return { vendor: '', packages: [], truncated: false, suggestions: publishers.filter(e => e.path.toLowerCase().startsWith(v.toLowerCase())).map(e => e.path).slice(0, 15) };
  const pk = await ghTree(exact.sha, opts);
  const packages = pk.entries.filter(e => e.type === 'tree' && WINGET_ID.test(`${exact.path}.${e.path}`)).map(e => ({ id: `${exact.path}.${e.path}`, name: e.path })).sort((a, b) => a.id.localeCompare(b.id));
  return { vendor: exact.path, packages, suggestions: [], truncated: pk.truncated };
}

export async function storeLatestVersion(productId, { fetchFn = fetch } = {}) {
  const id = String(productId || '').toUpperCase();
  if (!STORE_ID.test(id)) throw new Error('That isn’t a valid Microsoft Store product ID.');
  const r = await fetchFn(`${STORE_API}/packageManifests/${id}`, { headers: { ...UA, Accept: 'application/json' }, signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error(`The Microsoft Store lookup failed (HTTP ${r.status}).`);
  const v = (((await r.json())?.Data?.Versions) || [])[0]?.PackageVersion;
  if (!v) throw new Error('The Store listing has no version.');
  return String(v);
}
