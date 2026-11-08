// Finds the newest version of a winget package from the public winget-pkgs repository on GitHub.
// Set GITHUB_TOKEN (a read-only token) in the app settings to avoid GitHub's low anonymous rate limit.
const cache = new Map();

export function compareVersions(a, b) {
  const x = String(a).split(/[^0-9]+/).filter(Boolean).map(Number);
  const y = String(b).split(/[^0-9]+/).filter(Boolean).map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d;
  }
  return String(a).localeCompare(String(b));
}

export async function latestWingetVersion(id) {
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < 60 * 60 * 1000) return hit.version;

  const parts = String(id).split('.');
  const path = ['manifests', parts[0][0].toLowerCase(), ...parts].map(encodeURIComponent).join('/');
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'nexpatch' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetch(`https://api.github.com/repos/microsoft/winget-pkgs/contents/${path}`, { headers });
  if (res.status === 404) throw new Error(`winget has no package with the ID ${id}.`);
  if (res.status === 403 || res.status === 429) throw new Error('GitHub\u2019s rate limit was reached while checking winget. Add a GITHUB_TOKEN app setting.');
  if (!res.ok) throw new Error(`Couldn\u2019t read winget (${res.status}).`);
  const items = await res.json();
  // Version folders start with a digit; other folders are related packages (ESR, locales, ...).
  const versions = items.filter(i => i.type === 'dir' && /^[0-9]/.test(i.name)).map(i => i.name);
  if (!versions.length) throw new Error(`No versions found for ${id} on winget.`);
  const version = versions.sort(compareVersions).pop();
  cache.set(id, { version, at: Date.now() });
  return version;
}
