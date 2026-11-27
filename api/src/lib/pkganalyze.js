// Installer analysis for the Admin Center auto-packager.
// Reads Windows executables (PE), their Authenticode signature, version resource and installer framework, and MSI
// databases (compound files), then suggests silent install/uninstall commands and a detection rule.
// No network or storage here: callers pass a Buffer, so every rule can be tested.
import { createHash, X509Certificate, verify as cryptoVerify } from 'node:crypto';
import { rootCertificates } from 'node:tls';

// ---------------------------------------------------------------- DER (just enough to read a PKCS#7 signature)
export function der(buf, pos = 0) {
  if (pos + 2 > buf.length) throw new Error('DER: truncated');
  const tag = buf[pos];
  let len = buf[pos + 1], hl = 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n < 1 || n > 4) throw new Error('DER: bad length');
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[pos + 2 + i];
    hl = 2 + n;
  }
  const start = pos + hl, end = start + len;
  if (end > buf.length) throw new Error('DER: overrun');
  return { tag, start, end, raw: buf.subarray(pos, end), body: buf.subarray(start, end) };
}
export const kids = n => { const out = []; for (let p = 0; p < n.body.length;) { const k = der(n.body, p); out.push(k); p = k.end; } return out; };
export function oid(n) {
  const b = n.body, parts = [Math.min(2, Math.floor(b[0] / 40)), b[0] - 40 * Math.min(2, Math.floor(b[0] / 40))];
  let v = 0;
  for (let i = 1; i < b.length; i++) { v = v * 128 + (b[i] & 0x7f); if (!(b[i] & 0x80)) { parts.push(v); v = 0; } }
  return parts.join('.');
}
const HASH = { '1.3.14.3.2.26': 'sha1', '2.16.840.1.101.3.4.2.1': 'sha256', '2.16.840.1.101.3.4.2.2': 'sha384', '2.16.840.1.101.3.4.2.3': 'sha512' };
const OID = { signedData: '1.2.840.113549.1.7.2', spcIndirect: '1.3.6.1.4.1.311.2.1.4', messageDigest: '1.2.840.113549.1.9.4', counterSig: '1.2.840.113549.1.9.6', rfc3161: '1.3.6.1.4.1.311.3.3.1', nested: '1.3.6.1.4.1.311.2.4.1' };

// ---------------------------------------------------------------- PE
const MACHINE = { 0x14c: 'x86', 0x8664: 'x64', 0xaa64: 'arm64', 0x1c4: 'arm' };
export function parsePE(buf) {
  if (buf.length < 0x40 || buf.readUInt16LE(0) !== 0x5a4d) return null;
  const pe = buf.readUInt32LE(0x3c);
  if (pe + 24 > buf.length || buf.readUInt32LE(pe) !== 0x4550) return null;
  const machine = buf.readUInt16LE(pe + 4), nsec = buf.readUInt16LE(pe + 6), optSize = buf.readUInt16LE(pe + 20), ch = buf.readUInt16LE(pe + 22);
  const opt = pe + 24, magic = buf.readUInt16LE(opt), is64 = magic === 0x20b;
  if (magic !== 0x10b && magic !== 0x20b) return null;
  const numDD = buf.readUInt32LE(opt + (is64 ? 108 : 92)), ddOff = opt + (is64 ? 112 : 96);
  const dd = i => i < numDD ? { rva: buf.readUInt32LE(ddOff + 8 * i), size: buf.readUInt32LE(ddOff + 8 * i + 4) } : { rva: 0, size: 0 };
  const sections = [];
  let overlayStart = 0;
  for (let i = 0, s = opt + optSize; i < nsec && s + 40 <= buf.length; i++, s += 40) {
    const sec = { name: buf.toString('latin1', s, s + 8).replace(/\0+$/, ''), vsize: buf.readUInt32LE(s + 8), va: buf.readUInt32LE(s + 12), rawSize: buf.readUInt32LE(s + 16), rawPtr: buf.readUInt32LE(s + 20) };
    sections.push(sec);
    overlayStart = Math.max(overlayStart, sec.rawPtr + sec.rawSize);
  }
  const rvaToOff = rva => { for (const s of sections) if (rva >= s.va && rva < s.va + Math.max(s.vsize, s.rawSize)) return s.rawPtr + (rva - s.va); return -1; };
  const cert = dd(4); // the certificate table is a file offset, not an RVA
  const out = { machine: MACHINE[machine] || `0x${machine.toString(16)}`, is64, isDll: !!(ch & 0x2000), subsystem: buf.readUInt16LE(opt + 68) === 2 ? 'gui' : 'console',
    timestamp: buf.readUInt32LE(pe + 8), sections: sections.map(s => s.name), checksumOff: opt + 64, certDirOff: ddOff + 32,
    cert: cert.rva && cert.size && cert.rva + cert.size <= buf.length ? { offset: cert.rva, size: cert.size } : null, overlayStart: Math.min(overlayStart, buf.length) };
  try { out.version = readVersionResource(buf, dd(2), rvaToOff); } catch { out.version = null; }
  return out;
}

// RT_VERSION (16): VS_VERSIONINFO with a fixed part and a table of strings (ProductName, CompanyName, ...).
function readVersionResource(buf, rsrc, rvaToOff) {
  if (!rsrc.rva) return null;
  const base = rvaToOff(rsrc.rva);
  if (base < 0) return null;
  const entries = off => { const named = buf.readUInt16LE(off + 12), ids = buf.readUInt16LE(off + 14), out = [];
    for (let i = 0; i < named + ids && i < 512; i++) { const e = off + 16 + 8 * i; out.push({ id: buf.readUInt32LE(e), data: buf.readUInt32LE(e + 4) }); } return out; };
  const type = entries(base).find(e => e.id === 16 && (e.data & 0x80000000));
  if (!type) return null;
  const name = entries(base + (type.data & 0x7fffffff))[0];
  if (!name || !(name.data & 0x80000000)) return null;
  const lang = entries(base + (name.data & 0x7fffffff))[0];
  if (!lang || (lang.data & 0x80000000)) return null;
  const de = base + lang.data, start = rvaToOff(buf.readUInt32LE(de)), size = buf.readUInt32LE(de + 4);
  if (start < 0 || start + size > buf.length) return null;
  return parseVersionInfo(buf.subarray(start, start + size));
}

export function parseVersionInfo(b) {
  const a4 = n => (n + 3) & ~3;
  const block = off => {
    const len = b.readUInt16LE(off), valLen = b.readUInt16LE(off + 2), type = b.readUInt16LE(off + 4);
    let p = off + 6, key = '';
    while (p + 1 < b.length) { const c = b.readUInt16LE(p); p += 2; if (!c) break; key += String.fromCharCode(c); }
    p = a4(p);
    const vbytes = type === 1 ? valLen * 2 : valLen, value = b.subarray(p, Math.min(b.length, p + vbytes)), children = [];
    for (let c = a4(p + vbytes); c + 6 <= off + len && c + 6 <= b.length;) { const k = block(c); children.push(k); if (!k.len) break; c = a4(c + k.len); }
    return { len, key, type, value, children };
  };
  const root = block(0);
  if (root.key !== 'VS_VERSION_INFO') return null;
  const out = {};
  if (root.value.length >= 52 && root.value.readUInt32LE(0) === 0xfeef04bd) {
    const v = (ms, ls) => `${ms >>> 16}.${ms & 0xffff}.${ls >>> 16}.${ls & 0xffff}`;
    out.fileVersionFixed = v(root.value.readUInt32LE(8), root.value.readUInt32LE(12));
    out.productVersionFixed = v(root.value.readUInt32LE(16), root.value.readUInt32LE(20));
  }
  const sfi = root.children.find(c => c.key === 'StringFileInfo');
  for (const table of sfi?.children || []) for (const s of table.children) {
    const v = s.value.length >= 2 ? s.value.toString('utf16le').replace(/\0[\s\S]*$/, '').trim() : '';
    if (v && !(s.key in out)) out[s.key] = v.slice(0, 200);
  }
  return out;
}

// ---------------------------------------------------------------- Authenticode
// The PE hash: the whole file except the checksum, the certificate-table entry and the certificate table itself.
export function authenticodeDigest(buf, pe, alg = 'sha256') {
  const h = createHash(alg), c = pe.checksumOff, d = pe.certDirOff, end = pe.cert ? pe.cert.offset : buf.length;
  h.update(buf.subarray(0, c)); h.update(buf.subarray(c + 4, d)); h.update(buf.subarray(d + 8, end));
  if (pe.cert && pe.cert.offset + pe.cert.size < buf.length) h.update(buf.subarray(pe.cert.offset + pe.cert.size));
  return h.digest();
}

const nameOf = (dn, key) => { const m = new RegExp(`(?:^|\\n)${key}=([^\\n]+)`).exec(dn || ''); return m ? m[1].trim() : ''; };
let ROOTS = null;
const publicRoots = () => ROOTS ||= rootCertificates.map(p => { try { return new X509Certificate(p); } catch { return null; } }).filter(Boolean);

// Reads and checks the first signature. Every check is reported separately; nothing is assumed.
export function checkSignature(buf, pe, now = Date.now()) {
  if (!pe?.cert) return { signed: false };
  const r = { signed: true, checks: {} };
  try {
    const wc = buf.subarray(pe.cert.offset, pe.cert.offset + pe.cert.size);
    if (wc.readUInt16LE(6) !== 2) return { ...r, error: 'Unknown certificate type in the file.' };
    const ci = der(wc, 8), [ctype, wrapped] = kids(ci);
    if (oid(ctype) !== OID.signedData) return { ...r, error: 'The signature is not PKCS#7 signed data.' };
    const sd = kids(der(wrapped.body, 0));
    let i = 2;
    const encap = kids(sd[i++]);
    let certs = [];
    if (sd[i]?.tag === 0xa0) { certs = kids(sd[i]).filter(k => k.tag === 0x30).map(k => { try { return new X509Certificate(Buffer.from(k.raw)); } catch { return null; } }).filter(Boolean); i++; }
    if (sd[i]?.tag === 0xa1) i++;
    const signer = kids(sd[i])[0];
    if (oid(encap[0]) !== OID.spcIndirect) return { ...r, error: 'Not an Authenticode signature.' };
    // SpcIndirectDataContent: the PE digest the publisher signed
    const content = der(encap[1].body, 0), md = kids(kids(content)[1]);
    const alg = HASH[oid(kids(md[0])[0])];
    if (!alg) return { ...r, error: 'Unsupported digest algorithm.' };
    r.digestAlgorithm = alg;
    r.checks.fileUnchanged = authenticodeDigest(buf, pe, alg).equals(md[1].body);
    // SignerInfo
    const si = kids(signer);
    const serial = Buffer.from(kids(si[1])[1].body).toString('hex').replace(/^0+/, '').toUpperCase();
    const sAlg = HASH[oid(kids(si[2])[0])] || alg;
    let j = 3, signedAttrs = null, unsigned = null;
    if (si[j]?.tag === 0xa0) signedAttrs = si[j++];
    j++; // signature algorithm
    const signature = si[j++].body;
    if (si[j]?.tag === 0xa1) unsigned = si[j];
    const cert = certs.find(c => c.serialNumber.replace(/^0+/, '').toUpperCase() === serial);
    if (!cert) return { ...r, error: 'The signing certificate is not in the file.' };
    r.signer = { name: nameOf(cert.subject, 'CN'), organization: nameOf(cert.subject, 'O'), issuer: nameOf(cert.issuer, 'CN'), validFrom: new Date(cert.validFrom).toISOString(), validTo: new Date(cert.validTo).toISOString(), serial: cert.serialNumber };
    if (signedAttrs) {
      const attrs = kids(signedAttrs).map(a => { const k = kids(a); return { oid: oid(k[0]), values: kids(k[1]) }; });
      const mdAttr = attrs.find(a => a.oid === OID.messageDigest)?.values[0]?.body;
      // Authenticode hashes the content without its outer SEQUENCE header; accept the plain DER too.
      r.checks.contentBound = !!mdAttr && (createHash(sAlg).update(content.body).digest().equals(mdAttr) || createHash(sAlg).update(content.raw).digest().equals(mdAttr));
      const toVerify = Buffer.from(signedAttrs.raw); toVerify[0] = 0x31; // signed as a SET
      r.checks.signatureValid = cryptoVerify(sAlg, toVerify, cert.publicKey, signature);
    } else {
      r.checks.contentBound = true;
      r.checks.signatureValid = cryptoVerify(sAlg, Buffer.from(content.body), cert.publicKey, signature);
    }
    const unsignedOids = unsigned ? kids(unsigned).map(a => oid(kids(a)[0])) : [];
    r.timestamped = unsignedOids.includes(OID.counterSig) || unsignedOids.includes(OID.rfc3161);
    r.hasNestedSignature = unsignedOids.includes(OID.nested);
    r.checks.certificateTimeValid = r.timestamped || (now >= Date.parse(cert.validFrom) && now <= Date.parse(cert.validTo));
    // Chain inside the file, then whether it ends at a publicly trusted root
    const chain = [cert];
    for (let k = 0; k < 6; k++) {
      const last = chain.at(-1);
      if (last.subject === last.issuer) break;
      const up = certs.find(c => !chain.includes(c) && last.checkIssued(c) && safeVerify(last, c));
      if (!up) break;
      chain.push(up);
    }
    r.chain = chain.map(c => nameOf(c.subject, 'CN') || nameOf(c.subject, 'O'));
    const top = chain.at(-1);
    r.publicRoot = publicRoots().find(root => top.checkIssued(root) && safeVerify(top, root) || (root.fingerprint256 === top.fingerprint256)) ? true : false;
    r.valid = r.checks.fileUnchanged && r.checks.contentBound && r.checks.signatureValid;
  } catch (e) { r.error = `The signature could not be read (${String(e.message).slice(0, 80)}).`; }
  return r;
}
const safeVerify = (child, issuer) => { try { return child.verify(issuer.publicKey); } catch { return false; } };

// ---------------------------------------------------------------- MSI (compound file)
export function readCompoundFile(buf) {
  if (buf.length < 512 || buf.readUInt32LE(0) !== 0xe011cfd0 || buf.readUInt32LE(4) !== 0xe11ab1a1) return null;
  const ss = 1 << buf.readUInt16LE(0x1e), mss = 1 << buf.readUInt16LE(0x20), cutoff = buf.readUInt32LE(0x38);
  const sector = n => (n + 1) * ss;
  const u32 = (o) => o + 4 <= buf.length ? buf.readUInt32LE(o) : 0xfffffffe;
  // FAT sector list from the DIFAT
  const fatSectors = [];
  for (let i = 0; i < 109; i++) { const s = buf.readUInt32LE(0x4c + 4 * i); if (s < 0xfffffffa) fatSectors.push(s); }
  for (let d = buf.readUInt32LE(0x44), guard = 0; d < 0xfffffffa && guard < 10000; guard++) {
    for (let i = 0; i < ss / 4 - 1; i++) { const s = u32(sector(d) + 4 * i); if (s < 0xfffffffa) fatSectors.push(s); }
    d = u32(sector(d) + ss - 4);
  }
  const fat = n => { const per = ss / 4, fs = fatSectors[Math.floor(n / per)]; return fs === undefined ? 0xfffffffe : u32(sector(fs) + 4 * (n % per)); };
  const chain = (start, max = 1e6) => { const out = []; for (let s = start; s < 0xfffffffa && out.length < max; s = fat(s)) out.push(s); return out; };
  const readChain = (start, size) => { const parts = chain(start).map(s => buf.subarray(sector(s), Math.min(buf.length, sector(s) + ss))); return Buffer.concat(parts).subarray(0, size); };
  const dirBuf = readChain(buf.readUInt32LE(0x30), Infinity);
  const entries = [];
  for (let o = 0; o + 128 <= dirBuf.length; o += 128) {
    const nl = dirBuf.readUInt16LE(o + 64), type = dirBuf[o + 66];
    if (!type || nl < 2) continue;
    entries.push({ name: dirBuf.toString('utf16le', o, o + nl - 2), type, start: dirBuf.readUInt32LE(o + 116), size: dirBuf.readUInt32LE(o + 120) });
  }
  const root = entries.find(e => e.type === 5);
  const mini = root ? readChain(root.start, root.size) : Buffer.alloc(0);
  const miniFat = readChain(buf.readUInt32LE(0x3c), buf.readUInt32LE(0x40) * ss);
  const mfat = n => (n * 4 + 4 <= miniFat.length ? miniFat.readUInt32LE(n * 4) : 0xfffffffe);
  const stream = e => {
    if (e.size < cutoff) { const parts = []; for (let s = e.start, g = 0; s < 0xfffffffa && g < 1e6; s = mfat(s), g++) parts.push(mini.subarray(s * mss, s * mss + mss)); return Buffer.concat(parts).subarray(0, e.size); }
    return readChain(e.start, e.size);
  };
  return { entries: entries.filter(e => e.type === 2), stream };
}

const MIME = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz._';
// MSI packs stream names two characters per UTF-16 unit; tables start with U+4840 (shown as "!").
export function msiStreamName(s) {
  let out = '';
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    if (c >= 0x3800 && c < 0x4800) { const v = c - 0x3800; out += MIME[v & 0x3f] + MIME[(v >> 6) & 0x3f]; }
    else if (c >= 0x4800 && c < 0x4840) out += MIME[c - 0x4800];
    else if (c === 0x4840) out += '!';
    else out += ch;
  }
  return out;
}

function decoderFor(cp) {
  try { return new TextDecoder(cp === 65001 ? 'utf-8' : cp && cp !== 0 ? `windows-${cp}` : 'windows-1252'); } catch { return new TextDecoder('latin1'); }
}

// Summary information: an OLE property set. Title, subject (product), author (manufacturer), template (platform), package code.
export function readSummaryInfo(b) {
  if (!b || b.length < 48 || b.readUInt16LE(0) !== 0xfffe) return null;
  const sec = b.readUInt32LE(44), n = b.readUInt32LE(sec + 4), props = {};
  let cp = 1252;
  const raw = [];
  for (let i = 0; i < n && i < 64; i++) { const id = b.readUInt32LE(sec + 8 + 8 * i), off = sec + b.readUInt32LE(sec + 12 + 8 * i); raw.push([id, off]); }
  for (const [id, off] of raw) if (id === 1 && b.readUInt32LE(off) === 2) cp = b.readUInt16LE(off + 4);
  const dec = decoderFor(cp);
  for (const [id, off] of raw) {
    const t = b.readUInt32LE(off);
    if (t === 30) { const len = b.readUInt32LE(off + 4); props[id] = dec.decode(b.subarray(off + 8, off + 8 + len)).replace(/\0+$/, ''); }
    else if (t === 3) props[id] = b.readInt32LE(off + 4);
    else if (t === 2) props[id] = b.readInt16LE(off + 4);
  }
  return { title: props[2] || '', subject: props[3] || '', author: props[4] || '', comments: props[6] || '', template: props[7] || '', packageCode: props[9] || '', wordCount: props[15] ?? null };
}

// The string pool and the Property table.
export function readMsiProperties(cf) {
  const byName = new Map(cf.entries.map(e => [msiStreamName(e.name), e]));
  const pool = byName.get('!_StringPool'), data = byName.get('!_StringData'), prop = byName.get('!Property');
  if (!pool || !data || !prop) return null;
  const p = cf.stream(pool), d = cf.stream(data), t = cf.stream(prop);
  const cp = p.readUInt16LE(0) | ((p.readUInt16LE(2) & 0x7fff) << 16), refSize = (p.readUInt16LE(2) & 0x8000) ? 3 : 2;
  const dec = decoderFor(cp), strings = [''];
  let off = 0;
  for (let i = 1; i * 4 + 4 <= p.length; i++) {
    let len = p.readUInt16LE(i * 4);
    const refs = p.readUInt16LE(i * 4 + 2);
    if (len === 0 && refs !== 0 && (i + 1) * 4 + 4 <= p.length) { len = p.readUInt16LE((i + 1) * 4) + (refs << 16); strings.push(dec.decode(d.subarray(off, off + len))); strings.push(''); off += len; i++; continue; }
    strings.push(dec.decode(d.subarray(off, off + len)));
    off += len;
  }
  const rows = Math.floor(t.length / (2 * refSize)), ref = o => refSize === 2 ? t.readUInt16LE(o) : t.readUIntLE(o, 3), out = {};
  for (let r = 0; r < rows; r++) { const k = strings[ref(r * refSize)], v = strings[ref((rows + r) * refSize)]; if (k) out[k] = v ?? ''; }
  return out;
}

export function analyzeMsi(buf) {
  const cf = readCompoundFile(buf);
  if (!cf) return null;
  const si = cf.entries.find(e => e.name === '\u0005SummaryInformation');
  const summary = si ? readSummaryInfo(cf.stream(si)) : null;
  let props = null;
  try { props = readMsiProperties(cf); } catch { props = null; }
  const platform = String(summary?.template || '').split(';')[0].toLowerCase();
  return {
    summary,
    productCode: /^\{[0-9A-F-]{36}\}$/i.test(props?.ProductCode || '') ? props.ProductCode.toUpperCase() : '',
    upgradeCode: props?.UpgradeCode || '', productName: props?.ProductName || summary?.subject || '', productVersion: props?.ProductVersion || '',
    manufacturer: props?.Manufacturer || summary?.author || '', allUsers: props?.ALLUSERS ?? null, perUser: props?.MSIINSTALLPERUSER === '1' || props?.ALLUSERS === '2',
    arch: platform.includes('x64') || platform.includes('amd64') ? 'x64' : platform.includes('arm64') ? 'arm64' : platform.includes('intel') ? 'x86' : '',
    propertiesRead: !!props
  };
}

// ---------------------------------------------------------------- installer frameworks
const has = (buf, s) => buf.includes(Buffer.from(s, 'latin1')) || buf.includes(Buffer.from(s, 'utf16le'));
export function detectFramework(buf, pe) {
  if (!pe) return null;
  if (pe.sections.includes('.wixburn')) return 'burn';
  if (has(buf, 'Inno Setup Setup Data') || has(buf, 'InnoSetupLdrWindow')) return 'inno';
  if (has(buf, 'Nullsoft Install System') || has(buf, 'NullsoftInst')) return has(buf, 'electron-builder') ? 'nsis-electron' : 'nsis';
  if (has(buf, 'SquirrelSetup') || has(buf, 'Squirrel.Windows')) return 'squirrel';
  if (has(buf, 'Advanced Installer') || has(buf, 'Caphyon')) return 'advanced';
  if (has(buf, 'InstallShield')) return has(buf, 'InstallScript') ? 'installshield-script' : 'installshield';
  if (has(buf, 'Setup Factory')) return 'setupfactory';
  if (has(buf, 'WinRAR SFX')) return 'winrar-sfx';
  if (has(buf, '7zS.sfx') || has(buf, '7-Zip SFX')) return '7zip-sfx';
  if (pe.overlayStart < buf.length && buf.subarray(pe.overlayStart).includes(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) return 'msi-wrapper';
  return 'unknown';
}

export const FRAMEWORKS = {
  msi: 'Windows Installer (MSI)', burn: 'WiX Burn bundle', inno: 'Inno Setup', nsis: 'NSIS', 'nsis-electron': 'NSIS (electron-builder)', squirrel: 'Squirrel (installs per user)',
  advanced: 'Advanced Installer', installshield: 'InstallShield', 'installshield-script': 'InstallShield (InstallScript)', setupfactory: 'Setup Factory', 'winrar-sfx': 'WinRAR self-extractor',
  '7zip-sfx': '7-Zip self-extractor', 'msi-wrapper': 'EXE with an embedded MSI', unknown: 'Unknown EXE installer', msix: 'MSIX / APPX package', script: 'Script', zip: 'ZIP archive'
};

export function fileKind(name, buf) {
  const ext = String(name).toLowerCase().split('.').pop();
  if (buf.length >= 8 && buf.readUInt32LE(0) === 0xe011cfd0 && buf.readUInt32LE(4) === 0xe11ab1a1) return ext === 'msp' ? 'msp' : ext === 'mst' ? 'mst' : 'msi';
  if (buf.length >= 2 && buf.readUInt16LE(0) === 0x5a4d) return 'exe';
  if (buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50) return ['msix', 'appx', 'msixbundle', 'appxbundle'].includes(ext) ? 'msix' : 'zip';
  if (['ps1', 'cmd', 'bat'].includes(ext)) return 'script';
  return 'other';
}

// ---------------------------------------------------------------- recommendations
const q = f => `"${f}"`;
export function recommend({ kind, framework, file, msi, version }) {
  const name = (version?.ProductName || msi?.productName || '').trim();
  if (kind === 'msi') return [{ id: 'msi', confidence: 'high', label: 'Silent MSI install for all users',
    install: `msiexec /i ${q(file)} /qn /norestart ALLUSERS=1`, uninstall: msi?.productCode ? `msiexec /x ${msi.productCode} /qn /norestart` : '',
    detection: msi?.productCode ? { type: 'msi', productCode: msi.productCode, version: msi.productVersion } : { type: 'registry', displayName: name },
    notes: msi?.perUser ? 'This MSI asks for a per-user install; ALLUSERS=1 forces a machine-wide install. Test it.' : '' }];
  if (kind === 'script') return [{ id: 'script', confidence: 'medium', label: 'Run the script as SYSTEM',
    install: file.toLowerCase().endsWith('.ps1') ? `powershell.exe -ExecutionPolicy Bypass -NoProfile -File ${q(file)}` : `cmd.exe /c ${q(file)}`, uninstall: '', detection: { type: 'file' },
    notes: 'Add an uninstall command and a detection rule yourself. If you enforce App Control script rules, sign the script.' }];
  if (kind === 'msix') return [{ id: 'msix', confidence: 'high', label: 'Use Intune’s own MSIX app type', install: '', uninstall: '', detection: null, unsupported: true,
    notes: 'MSIX packages install best as an Intune line-of-business app, not as a Win32 app. Add it in Intune directly.' }];
  if (kind !== 'exe') return [{ id: 'none', confidence: 'low', label: 'Not an installer NexpatchOnline can package', install: '', uninstall: '', detection: null, unsupported: true, notes: 'Upload an MSI or EXE installer.' }];
  const reg = { type: 'registry', displayName: name };
  const uninstallBy = sw => `powershell.exe -ExecutionPolicy Bypass -NoProfile -File .\\Uninstall-App.ps1 -Switches "${sw}"`;
  const O = {
    inno: [{ id: 'inno', confidence: 'high', label: 'Inno Setup, very silent, all users', install: `${q(file)} /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP- /ALLUSERS`, uninstall: uninstallBy('/VERYSILENT /SUPPRESSMSGBOXES /NORESTART'), detection: reg }],
    nsis: [{ id: 'nsis', confidence: 'high', label: 'NSIS silent (/S is case-sensitive)', install: `${q(file)} /S`, uninstall: uninstallBy('/S'), detection: reg }],
    'nsis-electron': [{ id: 'nsis-all', confidence: 'high', label: 'Electron (NSIS) silent, for all users', install: `${q(file)} /S /allusers`, uninstall: uninstallBy('/S /allusers'), detection: reg },
      { id: 'nsis', confidence: 'medium', label: 'NSIS silent (default scope)', install: `${q(file)} /S`, uninstall: uninstallBy('/S'), detection: reg }],
    burn: [{ id: 'burn', confidence: 'high', label: 'WiX bundle, quiet', install: `${q(file)} /quiet /norestart`, uninstall: `${q(file)} /uninstall /quiet /norestart`, detection: reg }],
    advanced: [{ id: 'adv', confidence: 'high', label: 'Advanced Installer, no UI', install: `${q(file)} /exenoui /qn /norestart`, uninstall: uninstallBy('/qn'), detection: reg }],
    installshield: [{ id: 'is-msi', confidence: 'medium', label: 'InstallShield (Basic MSI), silent', install: `${q(file)} /s /v"/qn REBOOT=ReallySuppress"`, uninstall: uninstallBy('/s /v"/qn"'), detection: reg }],
    'installshield-script': [{ id: 'is-script', confidence: 'low', label: 'InstallShield InstallScript with a response file', install: `${q(file)} /s /f1"%~dp0setup.iss"`, uninstall: '', detection: reg,
      notes: 'InstallScript installers need a recorded response file (setup.iss). Record one with setup.exe /r and upload it with the installer.' }],
    'msi-wrapper': [{ id: 'wrap', confidence: 'medium', label: 'EXE with an MSI inside, passing quiet to the MSI', install: `${q(file)} /s /v"/qn /norestart"`, uninstall: uninstallBy('/qn'), detection: reg,
      notes: 'Wrappers differ. If this fails, extract the MSI and package it directly.' }],
    squirrel: [{ id: 'squirrel', confidence: 'low', label: 'Squirrel silent (installs for the signed-in user only)', install: `${q(file)} --silent`, uninstall: '', detection: reg,
      notes: 'Squirrel installers put the app in the user’s profile. Run as SYSTEM they install for no one. Ask the vendor for a machine-wide MSI.' }],
    setupfactory: [{ id: 'sf', confidence: 'medium', label: 'Setup Factory silent', install: `${q(file)} /S`, uninstall: uninstallBy('/S'), detection: reg }],
    'winrar-sfx': [{ id: 'sfx', confidence: 'low', label: 'Self-extractor silent', install: `${q(file)} /S`, uninstall: '', detection: { type: 'file' }, notes: 'A self-extractor only unpacks files. Check what it runs afterwards.' }],
    '7zip-sfx': [{ id: 'sfx7', confidence: 'low', label: 'Self-extractor silent', install: `${q(file)} -y`, uninstall: '', detection: { type: 'file' }, notes: 'A self-extractor only unpacks files. Check what it runs afterwards.' }]
  };
  const unknown = [
    { id: 'u-s', confidence: 'low', label: 'Common silent switch /S', install: `${q(file)} /S`, uninstall: uninstallBy('/S'), detection: reg },
    { id: 'u-quiet', confidence: 'low', label: 'Common silent switch /quiet', install: `${q(file)} /quiet /norestart`, uninstall: uninstallBy('/quiet'), detection: reg },
    { id: 'u-silent', confidence: 'low', label: 'Common silent switch /silent', install: `${q(file)} /silent`, uninstall: uninstallBy('/silent'), detection: reg }
  ];
  return O[framework] || unknown;
}

// ---------------------------------------------------------------- verdict
// block: never package. review: an admin must look. ok: no problems found by these checks.
export function verdict({ kind, signature, defender, virustotal, framework, sizeOk = true }) {
  const block = [], review = [], good = [];
  if (defender?.result === 'malicious') block.push('Microsoft Defender found malware in this file.');
  else if (defender?.result === 'clean') good.push('Microsoft Defender found no threats.');
  else review.push(defender?.result === 'pending' ? 'Microsoft Defender hasn’t finished scanning yet.' : 'Not scanned by an antivirus. Turn on Defender for Storage malware scanning to scan uploads automatically.');
  if (virustotal?.malicious >= 3) block.push(`${virustotal.malicious} antivirus engines on VirusTotal flag this file.`);
  else if (virustotal?.malicious > 0 || virustotal?.suspicious > 0) review.push(`VirusTotal: ${virustotal.malicious} malicious and ${virustotal.suspicious} suspicious verdicts.`);
  else if (virustotal?.known) good.push(`VirusTotal: no engine flags this file (${virustotal.harmless + virustotal.undetected} checked).`);
  if (kind === 'exe' || kind === 'msi') {
    if (signature?.signed && signature.checks?.fileUnchanged === false) block.push('The file was changed after it was signed.');
    else if (signature?.signed && signature.valid === false) block.push('The signature is broken.');
    else if (signature?.signed && signature.error) review.push(signature.error);
    else if (!signature?.signed) review.push(kind === 'msi' ? 'Signatures on MSI files aren’t checked here yet. Check the publisher in the file’s properties.' : 'The installer is not signed. Make sure it came from the vendor’s own site.');
    else {
      good.push(`Signed by ${signature.signer?.name || 'unknown'}${signature.signer?.issuer ? `, certificate from ${signature.signer.issuer}` : ''}, and unchanged since signing.`);
      if (!signature.checks.certificateTimeValid) review.push('The signing certificate has expired and the signature has no timestamp.');
      if (!signature.publicRoot) review.push('The certificate chain doesn’t end at a public root certificate.');
    }
  }
  if (framework === 'squirrel') review.push('This installer installs for one user only.');
  if (framework === 'unknown') review.push('The installer type wasn’t recognised, so the silent switches are guesses. Test them.');
  if (!sizeOk) review.push('The file is very small for an installer.');
  return { level: block.length ? 'block' : review.length ? 'review' : 'ok', block, review, good };
}

// One call for the whole analysis of the main installer.
export function analyzeInstaller(fileName, buf) {
  const kind = fileKind(fileName, buf), sha256 = createHash('sha256').update(buf).digest('hex');
  const out = { fileName, size: buf.length, sha256, kind };
  if (kind === 'exe') {
    const pe = parsePE(buf);
    out.pe = pe ? { machine: pe.machine, subsystem: pe.subsystem, isDll: pe.isDll, timestamp: pe.timestamp ? new Date(pe.timestamp * 1000).toISOString() : '', sections: pe.sections } : null;
    out.version = pe?.version || null;
    out.signature = pe ? checkSignature(buf, pe) : { signed: false };
    out.framework = detectFramework(buf, pe);
  } else if (kind === 'msi') {
    out.msi = analyzeMsi(buf);
    out.framework = 'msi';
    out.signature = { signed: false, note: 'MSI signatures are not checked yet.' };
  } else out.framework = kind;
  out.frameworkName = FRAMEWORKS[out.framework] || out.framework;
  out.suggested = {
    name: (out.version?.ProductName || out.msi?.productName || fileName.replace(/\.[^.]+$/, '')).slice(0, 120),
    vendor: (out.version?.CompanyName || out.msi?.manufacturer || out.signature?.signer?.organization || '').slice(0, 120),
    version: (out.msi?.productVersion || out.version?.ProductVersion || out.version?.productVersionFixed || '').replace(/,\s*/g, '.').slice(0, 40),
    arch: out.msi?.arch || (out.pe?.machine === 'x86' ? 'x86' : out.pe?.machine || 'x64')
  };
  out.options = recommend({ kind, framework: out.framework, file: fileName, msi: out.msi, version: out.version });
  return out;
}
