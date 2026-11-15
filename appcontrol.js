// App Control live events: shared storage for both sources, the Defender poll, and the supplemental policy.
import { createHash, randomUUID } from 'node:crypto';
import { getRow, putRow, listRows } from './store.js';
import { graph } from './graph.js';

const clip = (v, n = 400) => (v == null ? '' : String(v)).slice(0, n);
const hex = v => (/^[0-9a-fA-F]{20,128}$/.test(String(v || '').trim()) ? String(v).trim().toUpperCase() : '');
const leaf = p => String(p || '').split(/[\\/]/).pop();

// Normalize one event from either source; returns null when it can't be used.
export function normalize(e, device) {
  const path = clip(e.path, 1000);
  if (!path) return null;
  return {
    time: Number.isNaN(Date.parse(e.time)) ? new Date().toISOString() : new Date(e.time).toISOString(),
    device: clip(device || e.device, 100), action: e.action === 'blocked' ? 'blocked' : 'audited',
    path, file: clip(leaf(path), 260), process: clip(e.process, 1000), policy: clip(e.policy, 200), user: clip(e.user, 200),
    sha1: hex(e.sha1), sha256: hex(e.sha256), sha256Flat: hex(e.sha256Flat),
    publisher: clip(e.publisher, 400), issuer: clip(e.issuer, 400), issuerTbs: hex(e.issuerTbs)
  };
}

export const eventKey = e => createHash('sha1').update([e.action, e.file.toLowerCase(), e.sha256 || e.sha256Flat || e.path.toLowerCase()].join('|')).digest('hex');

// Merge a batch of normalized events into the per-app rows.
export async function storeEvents(tid, events) {
  const groups = new Map();
  for (const e of events) { const k = eventKey(e); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(e); }
  for (const [k, list] of groups) {
    const row = await getRow('AcEvents', tid, k);
    const devices = new Set(row ? JSON.parse(row.devices || '[]') : []);
    let added = 0;
    for (const e of list) if (e.device && !devices.has(e.device) && devices.size < 50) { devices.add(e.device); added++; }
    const first = list[0], withSigner = list.find(e => e.issuerTbs) || {}, withHash = list.find(e => e.sha256) || {};
    const times = list.map(e => e.time).sort();
    await putRow('AcEvents', tid, k, {
      action: first.action, file: first.file, path: row?.path || first.path, process: row?.process || first.process, policy: first.policy || row?.policy || '',
      sha1: row?.sha1 || withHash.sha1 || '', sha256: row?.sha256 || withHash.sha256 || '', sha256Flat: row?.sha256Flat || first.sha256Flat || '',
      publisher: row?.publisher || withSigner.publisher || '', issuer: row?.issuer || withSigner.issuer || '', issuerTbs: row?.issuerTbs || withSigner.issuerTbs || '',
      devices: JSON.stringify([...devices]), deviceCount: (row?.deviceCount || 0) + added, count: (row?.count || 0) + list.length,
      firstSeen: row?.firstSeen && row.firstSeen < times[0] ? row.firstSeen : times[0], lastSeen: row?.lastSeen && row.lastSeen > times.at(-1) ? row.lastSeen : times.at(-1),
      lastUser: list.at(-1).user || row?.lastUser || ''
    });
  }
  return groups.size;
}

// ---- Option A: Microsoft Defender advanced hunting ----
const huntingQuery = (from, to) => `let fromT = datetime(${from}); let toT = datetime(${to});
let ci = DeviceEvents
| where Timestamp > fromT and Timestamp <= toT and ActionType in ("AppControlCodeIntegrityPolicyBlocked", "AppControlCodeIntegrityPolicyAudited")
| project Timestamp, DeviceId, DeviceName, ActionType, FileName, FolderPath, SHA1, SHA256, Account = InitiatingProcessAccountName, Process = InitiatingProcessFolderPath, ReportId;
let sig = DeviceEvents
| where Timestamp > fromT and Timestamp <= toT and ActionType == "AppControlCodeIntegritySigningInformation"
| extend af = parse_json(AdditionalFields)
| summarize arg_max(Timestamp, af) by DeviceId, ReportId
| project DeviceId, ReportId, PublisherName = tostring(af.PublisherName), IssuerName = tostring(af.IssuerName), IssuerTBSHash = tostring(af.IssuerTBSHash);
ci | join kind=leftouter sig on DeviceId, ReportId
| take 20000`;

// Defender's FolderPath sometimes already ends with the file name
function joinPath(folder, file) {
  const f = String(folder || ''), n = String(file || '');
  if (!f) return n;
  if (n && f.toLowerCase().endsWith(n.toLowerCase())) return f;
  return f.endsWith('\\') ? f + n : `${f}\\${n}`;
}

export async function pollDefender(tid, tenantRow) {
  const to = new Date(Date.now() - 15 * 60 * 1000); // Defender needs a few minutes to ingest events
  const last = tenantRow?.acCursor ? new Date(tenantRow.acCursor) : null;
  const from = last && to - last < 24 * 3600 * 1000 ? last : new Date(to.getTime() - 24 * 3600 * 1000);
  if (to <= from) return { stored: 0, rows: 0 };
  const res = await graph(tid, '/v1.0/security/runHuntingQuery', { method: 'POST', body: JSON.stringify({ Query: huntingQuery(from.toISOString(), to.toISOString()) }) });
  const rows = res.results || [];
  const events = rows.map(r => normalize({
    time: r.Timestamp, action: String(r.ActionType).endsWith('Blocked') ? 'blocked' : 'audited',
    path: joinPath(r.FolderPath, r.FileName),
    process: r.Process, user: r.Account, sha1: '', sha256: '', sha256Flat: r.SHA256,
    publisher: r.PublisherName, issuer: r.IssuerName, issuerTbs: r.IssuerTBSHash
  }, r.DeviceName)).filter(Boolean);
  const stored = events.length ? await storeEvents(tid, events) : 0;
  await putRow('Tenants', 'tenant', tid, { acCursor: to.toISOString(), acLastPollAt: new Date().toISOString(), acLastError: '' });
  return { stored, rows: rows.length };
}

// ---- Supplemental policy built from allow decisions ----
const xml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
const cn = dn => (/CN=([^,]+)/.exec(dn || '') || [])[1] || dn || 'Signer';

export async function buildSupplemental(tid, tenantRow) {
  const decisions = (await listRows('AcDecisions', tid)).filter(d => d.decision === 'allowPublisher' || d.decision === 'allowFile');
  let policyId = tenantRow.acSuppPolicyId;
  if (!policyId) { policyId = `{${randomUUID().toUpperCase()}}`; await putRow('Tenants', 'tenant', tid, { acSuppPolicyId: policyId }); }
  const v = Number(tenantRow.acPolicyVersion || 1);
  const signers = new Map(), files = [];
  for (const d of decisions) {
    if (d.decision === 'allowPublisher' && d.issuerTbs && d.publisher) signers.set(`${d.issuerTbs}|${d.publisher}`, d);
    if (d.decision === 'allowFile' && d.sha256) files.push(d);
  }
  const signerXml = [...signers.values()].map((d, i) => `    <Signer ID="ID_SIGNER_NX_${i + 1}" Name="${xml(cn(d.issuer))}">\n      <CertRoot Type="TBS" Value="${d.issuerTbs}" />\n      <CertPublisher Value="${xml(d.publisher)}" />\n    </Signer>`).join('\n');
  const fileXml = files.map((d, i) => `    <Allow ID="ID_ALLOW_NX_${i + 1}" FriendlyName="${xml(d.file)}" Hash="${d.sha256}" />`).join('\n');
  const allowed = [...signers.values()].map((_, i) => `            <AllowedSigner SignerId="ID_SIGNER_NX_${i + 1}" />`).join('\n');
  const refs = files.map((_, i) => `          <FileRuleRef RuleID="ID_ALLOW_NX_${i + 1}" />`).join('\n');
  const body = `<?xml version="1.0" encoding="utf-8"?>
<SiPolicy xmlns="urn:schemas-microsoft-com:sipolicy" PolicyType="Supplemental Policy">
  <VersionEx>10.0.${Math.floor(v / 65535)}.${v % 65535}</VersionEx>
  <PlatformID>{2E07F7E4-194C-4D20-B7C9-6F44A6C5A234}</PlatformID>
  <PolicyID>${policyId}</PolicyID>
  <BasePolicyID>${tenantRow.acBasePolicyId}</BasePolicyID>
  <Rules>
    <Rule><Option>Enabled:Unsigned System Integrity Policy</Option></Rule>
  </Rules>
  <EKUs />
  <FileRules>
${fileXml}
  </FileRules>
  <Signers>
${signerXml}
  </Signers>
  <SigningScenarios>
    <SigningScenario Value="131" ID="ID_SIGNINGSCENARIO_NX_DRIVERS" FriendlyName="Drivers">
      <ProductSigners />
    </SigningScenario>
    <SigningScenario Value="12" ID="ID_SIGNINGSCENARIO_NX_WINDOWS" FriendlyName="Apps allowed in NexpatchOnline">
      <ProductSigners>
${signers.size ? `        <AllowedSigners>\n${allowed}\n        </AllowedSigners>\n` : ''}${files.length ? `        <FileRulesRef>\n${refs}\n        </FileRulesRef>\n` : ''}      </ProductSigners>
    </SigningScenario>
  </SigningScenarios>
  <UpdatePolicySigners />
  <CiSigners />
  <HvciOptions>0</HvciOptions>
  <Settings>
    <Setting Provider="PolicyInfo" Key="Information" ValueName="Name"><Value><String>NexpatchOnline allowed apps</String></Value></Setting>
    <Setting Provider="PolicyInfo" Key="Information" ValueName="Id"><Value><String>NexpatchOnlineSupplemental</String></Value></Setting>
  </Settings>
</SiPolicy>
`;
  return { xml: body.replace(/\n\s*\n/g, '\n'), policyId, version: v, publishers: signers.size, files: files.length };
}
