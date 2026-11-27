import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, sign, createPrivateKey, X509Certificate } from 'node:crypto';
import { analyzeInstaller, parsePE, parseVersionInfo, checkSignature, authenticodeDigest, readCompoundFile, msiStreamName, analyzeMsi, detectFramework, recommend, verdict, fileKind, der, kids } from '../src/lib/pkganalyze.js';

const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIDfjCCAmagAwIBAgIUTifatt0JF7q4xSaZUuapq3fExNgwDQYJKoZIhvcNAQEL
BQAwRDEjMCEGA1UEAwwaTmV4cGF0Y2hPbmxpbmUgVGVzdCBTaWduZXIxHTAbBgNV
BAoMFE5leHBhdGNoT25saW5lIFRlc3RzMB4XDTI2MTEyNzAyNTgyOVoXDTQ2MTEy
MjAyNTgyOVowRDEjMCEGA1UEAwwaTmV4cGF0Y2hPbmxpbmUgVGVzdCBTaWduZXIx
HTAbBgNVBAoMFE5leHBhdGNoT25saW5lIFRlc3RzMIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEAnnPzfaHbPBbNplLqsBYKyOcg8w7AN3mrchrq8isP08h0
Dy+JybDcabS/K5+bI/Xo2gdBbLGotdUZizApPJlzLyVYKNtgl7bhORWdRm9nYJui
flTsC3zIg9xAOS8kmSZfot1W3xdGEBEYKADwo3HVGgNrrwCClRZ1K5IDGvPN9Vm6
/MulvYjbutWnw+Are83ScI+NpaTxs9Xk9I2eOzkqZ0HB2EF68fDxEyEJ62sSbDl9
DVa6vuQQ97Iz0aC59iqUsPCE6KZcaczqyfrllP7xRlj92r554UMgmPmquhIY98j0
jt/xFSnsWkaZdJ1U91iGA5PI0bkK9l8H7UtfM6qaOQIDAQABo2gwZjAdBgNVHQ4E
FgQU+6hSl0R3Mytzp75qeUHeOQ4eMU4wHwYDVR0jBBgwFoAU+6hSl0R3Mytzp75q
eUHeOQ4eMU4wDwYDVR0TAQH/BAUwAwEB/zATBgNVHSUEDDAKBggrBgEFBQcDAzAN
BgkqhkiG9w0BAQsFAAOCAQEAUGzi3BdWUNsCM+uxzmayTyvItrZsx06bxgle/D6f
CmWDO13dPpGCn55JEOl9YCslgrmTEsNjCIxQKH3gfSPMEVNZWVQqBZLwgoC9iORE
Xcvu8BQk9pcss9LVp8oezwztEJaKNFlgBLhh0zHOVB+Xkj1fwrzPQPX8tNW9sRfJ
aOoecrX+2iuoLczdAo/7tTtoZLK5eEsPeXxnxoHDviWAKKcgiVBo1Wrjfs+AeHA0
vxaLdKyIE1rSZcdMmE0byRTaCAMAjnI74GU3i2cDk+i7OYFOrOotv59N9VQ1fDDR
ZZxXRFLuME19C/GMzKOiT8InMbJdl8/6r3jYrumZ7Ta8HA==
-----END CERTIFICATE-----`;
// A throwaway key made only for these tests (CN=NexpatchOnline Test Signer). It signs nothing real.
const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIIEuwIBADANBgkqhkiG9w0BAQEFAASCBKUwggShAgEAAoIBAQCec/N9ods8Fs2m
UuqwFgrI5yDzDsA3eatyGuryKw/TyHQPL4nJsNxptL8rn5sj9ejaB0Fssai11RmL
MCk8mXMvJVgo22CXtuE5FZ1Gb2dgm6J+VOwLfMiD3EA5LySZJl+i3VbfF0YQERgo
APCjcdUaA2uvAIKVFnUrkgMa8831Wbr8y6W9iNu61afD4Ct7zdJwj42lpPGz1eT0
jZ47OSpnQcHYQXrx8PETIQnraxJsOX0NVrq+5BD3sjPRoLn2KpSw8IToplxpzOrJ
+uWU/vFGWP3avnnhQyCY+aq6Ehj3yPSO3/EVKexaRpl0nVT3WIYDk8jRuQr2Xwft
S18zqpo5AgMBAAECgf90fuhxj7oFjeFNZJdnZJ69nDB9a4xg39wHIo7aAuBdKO78
uzPPwUEGJRSLI+du6Ou67E8No5xAh92xUejQ84DEt2GLHL8wQDvnxQUfknEgR3sz
SVl8O4qwlhJ+4TLnLCmG/9GtUKxAzH8tXoONeMlrmZ4JbB9PvV7K1XqbtkFE7v0I
SXPaIqXuOsbVctVFr0MLeVvfduzn4Amd8VnwvQbXQ8tcSe0MkwR6pH94CQmpCp8H
AWTWSyqL6U0Fc5e2SxUNe6YgonIErVfWeyTKTeSUaNhDr5to6GhNKxXCgH1YZqQn
sGmZ0ry256zXbx7A2BLSH1/X3AZommil7KFoJlECgYEAzDC1BN9cFpNwDEyOD4Ry
53wAbZ1DRiEnkOSxLM+n+E4oFagKprOaF2ZEk2zP0+H1REX60sjCUJYE5E3l86F3
TTXVDf+q0p5WH7uzcjJcfVkbIaJaorO96OQuKHlb6dxmV+qNotNacmJOiqHVczWa
elBkTUUAtzwpnolWF7LmbJECgYEAxqhZqq3NIJCGmjh+iPjEuwHmwNh5zw0aIn1J
UBXtJIMyT6regmw+XrIJpDtzX7iau7jjy5zZdWuaQoPNuTu9P/5FpfZ991s9i/V+
q3JY0WieVPltHnhqfshWMlWNTae4oMz8Swy1CO7bgYcw2apr4nSFuaMfWfZn7GUY
1fm3RykCgYEApKGA0fTk4q7tYH047Pn1Sv6HudlaLGj+5av9zgt/eoxJdWyPaejV
DJjAIb1Rs5wzjGB/4wNK6H6MYycLiGtfLTmCFk9VA4v2FI/aFvDT8Zyua2fje9s/
+04+iROQL/Yr7iaHHAkcm6z3dn8VAlbtvkCjHknMUfCH/fLtHx52+oECgYBlqtrY
4sHMHKsGWktHxijInByALUmJkWcCp6PRfKc0vIAPDZ96l/MDe5I7nsFZB50I3YKX
Pdp8oWj9CX9LgStFiNgUK6Yj5WoGKsl87LRP137QdiZGJdI6uESE1gvO5jsy8DVe
I06zF6r3Cz0Q6Ir2BjQ54SW2YMimzsZ7G6WUoQKBgGslnjuaR3DdEx/lhjGsQRI+
h0l+3RwfBUPLVZ47UG6ebtb3uxy7twxjmanDxk9ZxqrAh3WTHhjPqI5nHNIlAsoy
tjaTgDw/db4Q9pI0QAMEoLRDnYL3+HYSvUuhutOJJUONwMg/cTS5JX2wmAihRgd7
ccbiWgYS9YgeVP4CbMO4
-----END PRIVATE KEY-----`;

// ---- tiny DER writer, PE builder and compound-file builder for the tests ----
const tlv = (tag, ...parts) => { const body = Buffer.concat(parts); const n = body.length; let lb; if (n < 128) lb = Buffer.from([n]); else { const b = []; for (let x = n; x; x >>= 8) b.unshift(x & 0xff); lb = Buffer.from([0x80 | b.length, ...b]); } return Buffer.concat([Buffer.from([tag]), lb, body]); };
const seq = (...p) => tlv(0x30, ...p), set = (...p) => tlv(0x31, ...p), oct = b => tlv(0x04, b), int = b => tlv(0x02, Buffer.from(b)), NUL = Buffer.from([5, 0]);
const oidEnc = s => { const p = s.split('.').map(Number), out = [40 * p[0] + p[1]]; for (const v of p.slice(2)) { const st = [v & 0x7f]; for (let n = Math.floor(v / 128); n; n = Math.floor(n / 128)) st.unshift((n & 0x7f) | 0x80); out.push(...st); } return tlv(0x06, Buffer.from(out)); };
const u16 = s => Buffer.from(s + '\0', 'utf16le');
const pad4 = b => Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4)]);

function verBlock(key, value, type, children = []) {
  let body = pad4(Buffer.concat([Buffer.alloc(6), u16(key)]));
  body = Buffer.concat([body, value]);
  for (const c of children) body = Buffer.concat([pad4(body), c]);
  body.writeUInt16LE(body.length, 0); body.writeUInt16LE(type === 1 ? value.length / 2 : value.length, 2); body.writeUInt16LE(type, 4);
  return body;
}
function versionResource(strings) {
  const fixed = Buffer.alloc(52); fixed.writeUInt32LE(0xfeef04bd, 0); fixed.writeUInt32LE(0x10000, 4);
  fixed.writeUInt32LE((2 << 16) | 5, 8); fixed.writeUInt32LE((1 << 16) | 7, 12); fixed.writeUInt32LE((2 << 16) | 5, 16); fixed.writeUInt32LE((1 << 16) | 7, 20);
  const table = verBlock('040904b0', Buffer.alloc(0), 1, Object.entries(strings).map(([k, v]) => verBlock(k, u16(v), 1)));
  return verBlock('VS_VERSION_INFO', fixed, 0, [verBlock('StringFileInfo', Buffer.alloc(0), 1, [table])]);
}
function buildPE({ strings = { ProductName: 'Contoso Widget', CompanyName: 'Contoso Ltd', ProductVersion: '2.5.1.7' }, extra = Buffer.alloc(0) } = {}) {
  const b = Buffer.alloc(0x400);
  b.write('MZ', 0, 'latin1'); b.writeUInt32LE(0x40, 0x3c); b.write('PE\0\0', 0x40, 'latin1');
  b.writeUInt16LE(0x8664, 0x44); b.writeUInt16LE(1, 0x46); b.writeUInt32LE(1700000000, 0x48); b.writeUInt16LE(240, 0x54); b.writeUInt16LE(0x22, 0x56);
  const opt = 0x58; b.writeUInt16LE(0x20b, opt); b.writeUInt16LE(2, opt + 68); b.writeUInt32LE(16, opt + 108);
  const ver = versionResource(strings);
  const rs = Buffer.alloc(0x200);
  const dir = (off, id, data) => { rs.writeUInt16LE(1, off + 14); rs.writeUInt32LE(id, off + 16); rs.writeUInt32LE(data, off + 20); };
  dir(0x00, 16, (0x80000000 | 0x18) >>> 0); dir(0x18, 1, (0x80000000 | 0x30) >>> 0); dir(0x30, 0x409, 0x48);
  rs.writeUInt32LE(0x1000 + 0x58, 0x48); rs.writeUInt32LE(ver.length, 0x4c); ver.copy(rs, 0x58);
  b.writeUInt32LE(0x1000, opt + 112 + 16); b.writeUInt32LE(0x200, opt + 112 + 20);
  const sh = opt + 240; b.write('.rsrc', sh, 'latin1'); b.writeUInt32LE(0x200, sh + 8); b.writeUInt32LE(0x1000, sh + 12); b.writeUInt32LE(0x200, sh + 16); b.writeUInt32LE(0x200, sh + 20);
  rs.copy(b, 0x200);
  return Buffer.concat([b, extra]);
}
function signPE(unsigned, { timestamp = false } = {}) {
  const cert = new X509Certificate(TEST_CERT), key = createPrivateKey(TEST_KEY);
  const pe = parsePE(unsigned);
  const digest = authenticodeDigest(unsigned, { ...pe, cert: null }, 'sha256');
  const spc = seq(seq(oidEnc('1.3.6.1.4.1.311.2.1.15'), seq(tlv(0x03, Buffer.from([0])))), seq(seq(oidEnc('2.16.840.1.101.3.4.2.1'), NUL), oct(digest)));
  const spcContents = der(spc).body;
  const attrs = set(seq(oidEnc('1.2.840.113549.1.9.3'), set(oidEnc('1.3.6.1.4.1.311.2.1.4'))), seq(oidEnc('1.2.840.113549.1.9.4'), set(oct(createHash('sha256').update(spcContents).digest()))));
  const signature = sign('sha256', attrs, key);
  const implicitAttrs = Buffer.from(attrs); implicitAttrs[0] = 0xa0;
  const tbs = kids(der(cert.raw))[0], tk = kids(tbs), issuer = tk[3].raw, serial = tk[1].raw;
  const unsignedAttrs = timestamp ? [tlv(0xa1, seq(oidEnc('1.2.840.113549.1.9.6'), set(seq())))] : [];
  const signerInfo = seq(int([1]), seq(issuer, serial), seq(oidEnc('2.16.840.1.101.3.4.2.1'), NUL), implicitAttrs, seq(oidEnc('1.2.840.113549.1.1.1'), NUL), oct(signature), ...unsignedAttrs);
  const sd = seq(int([1]), set(seq(oidEnc('2.16.840.1.101.3.4.2.1'), NUL)), seq(oidEnc('1.3.6.1.4.1.311.2.1.4'), tlv(0xa0, spc)), tlv(0xa0, cert.raw), set(signerInfo));
  const p7 = seq(oidEnc('1.2.840.113549.1.7.2'), tlv(0xa0, sd));
  const wc = Buffer.alloc(8 + p7.length + ((8 - (p7.length % 8)) % 8)); wc.writeUInt32LE(wc.length, 0); wc.writeUInt16LE(0x200, 4); wc.writeUInt16LE(2, 6); p7.copy(wc, 8);
  const out = Buffer.concat([unsigned, wc]);
  out.writeUInt32LE(unsigned.length, pe.certDirOff); out.writeUInt32LE(wc.length, pe.certDirOff + 4);
  return out;
}
// Compound file (version 3) with small streams in the mini stream, like an MSI.
const MIME = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz._';
function msiEncode(name) { let s = name.startsWith('!') ? '䡀' : ''; const n = name.replace(/^!/, ''); for (let i = 0; i < n.length; i += 2) { const a = MIME.indexOf(n[i]), b = i + 1 < n.length ? MIME.indexOf(n[i + 1]) : -1; s += b < 0 ? String.fromCharCode(0x4800 + a) : String.fromCharCode(0x3800 + a + (b << 6)); } return s; }
function buildCFB(streams) {
  const ss = 512, names = Object.keys(streams);
  let mini = Buffer.alloc(0); const starts = [];
  for (const n of names) { starts.push(mini.length / 64); mini = Buffer.concat([mini, streams[n], Buffer.alloc((64 - (streams[n].length % 64)) % 64)]); }
  const miniSectors = Math.ceil(mini.length / ss), dirSectors = Math.ceil((names.length + 1) / 4);
  const fat = Buffer.alloc(ss, 0xff), mfat = Buffer.alloc(ss, 0xff);
  fat.writeUInt32LE(0xfffffffd, 0);
  for (let i = 0; i < dirSectors; i++) fat.writeUInt32LE(i + 1 < dirSectors ? 2 + i : 0xfffffffe, 4 * (1 + i));
  const mfs = 1 + dirSectors; fat.writeUInt32LE(0xfffffffe, 4 * mfs);
  for (let i = 0; i < miniSectors; i++) fat.writeUInt32LE(i + 1 < miniSectors ? mfs + 2 + i : 0xfffffffe, 4 * (mfs + 1 + i));
  names.forEach((n, k) => { const cnt = Math.ceil(streams[n].length / 64); for (let i = 0; i < cnt; i++) mfat.writeUInt32LE(i + 1 < cnt ? starts[k] + i + 1 : 0xfffffffe, 4 * (starts[k] + i)); });
  const dir = Buffer.alloc(dirSectors * ss);
  const entry = (i, name, type, start, size, child, right) => { const o = i * 128, nb = Buffer.from(name + '\0', 'utf16le'); nb.copy(dir, o); dir.writeUInt16LE(nb.length, o + 64); dir[o + 66] = type; dir[o + 67] = 1;
    dir.writeUInt32LE(0xffffffff, o + 68); dir.writeUInt32LE(right, o + 72); dir.writeUInt32LE(child, o + 76); dir.writeUInt32LE(start, o + 116); dir.writeUInt32LE(size, o + 120); };
  entry(0, 'Root Entry', 5, mfs + 1, mini.length, 1, 0xffffffff);
  names.forEach((n, k) => entry(k + 1, n, 2, starts[k], streams[n].length, 0xffffffff, k + 2 <= names.length ? k + 2 : 0xffffffff));
  const h = Buffer.alloc(512, 0);
  h.writeUInt32LE(0xe011cfd0, 0); h.writeUInt32LE(0xe11ab1a1, 4); h.writeUInt16LE(0x3e, 0x18); h.writeUInt16LE(3, 0x1a); h.writeUInt16LE(0xfffe, 0x1c); h.writeUInt16LE(9, 0x1e); h.writeUInt16LE(6, 0x20);
  h.writeUInt32LE(1, 0x2c); h.writeUInt32LE(1, 0x30); h.writeUInt32LE(4096, 0x38); h.writeUInt32LE(mfs, 0x3c); h.writeUInt32LE(1, 0x40); h.writeUInt32LE(0xfffffffe, 0x44);
  for (let i = 0; i < 109; i++) h.writeUInt32LE(i ? 0xffffffff : 0, 0x4c + 4 * i);
  return Buffer.concat([h, fat, dir, mfat, mini, Buffer.alloc(miniSectors * ss - mini.length)]);
}
function summaryInfo(props) {
  const parts = [], ids = [];
  for (const [id, v] of props) { ids.push(id); if (typeof v === 'number') { const b = Buffer.alloc(8); b.writeUInt32LE(2, 0); b.writeUInt16LE(v, 4); parts.push(b); } else { const s = Buffer.from(v + '\0', 'latin1'), b = Buffer.alloc(8 + s.length + ((4 - (s.length % 4)) % 4)); b.writeUInt32LE(30, 0); b.writeUInt32LE(s.length, 4); s.copy(b, 8); parts.push(b); } }
  const head = Buffer.alloc(8 + 8 * ids.length); let off = head.length;
  ids.forEach((id, i) => { head.writeUInt32LE(id, 8 + 8 * i); head.writeUInt32LE(off, 12 + 8 * i); off += parts[i].length; });
  head.writeUInt32LE(off, 0); head.writeUInt32LE(ids.length, 4);
  const top = Buffer.alloc(48); top.writeUInt16LE(0xfffe, 0); top.writeUInt32LE(1, 24); Buffer.from('E0859FF2F94F6810AB9108002B27B3D9', 'hex').copy(top, 28); top.writeUInt32LE(48, 44);
  return Buffer.concat([top, head, ...parts]);
}
function buildMsi(props) {
  const strs = Object.entries(props).flat(), pool = Buffer.alloc(4 + 4 * strs.length);
  pool.writeUInt16LE(1252, 0);
  strs.forEach((s, i) => { pool.writeUInt16LE(Buffer.byteLength(s, 'latin1'), 4 + 4 * i); pool.writeUInt16LE(1, 6 + 4 * i); });
  const n = strs.length / 2, table = Buffer.alloc(4 * n);
  for (let r = 0; r < n; r++) { table.writeUInt16LE(1 + 2 * r, 2 * r); table.writeUInt16LE(2 + 2 * r, 2 * (n + r)); }
  return buildCFB({ '\u0005SummaryInformation': summaryInfo([[1, 1252], [2, 'Installation Database'], [3, 'Contoso Widget'], [4, 'Contoso Ltd'], [7, 'x64;1033'], [9, '{AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE}']]),
    [msiEncode('!_StringPool')]: pool, [msiEncode('!_StringData')]: Buffer.from(strs.join(''), 'latin1'), [msiEncode('!Property')]: table });
}

// ---- tests ----
test('PE: architecture, version resource and file kind are read', () => {
  const pe = parsePE(buildPE());
  assert.equal(pe.machine, 'x64'); assert.equal(pe.subsystem, 'gui'); assert.deepEqual(pe.sections, ['.rsrc']); assert.equal(pe.cert, null);
  assert.equal(pe.version.ProductName, 'Contoso Widget'); assert.equal(pe.version.CompanyName, 'Contoso Ltd');
  assert.equal(pe.version.productVersionFixed, '2.5.1.7');
  assert.equal(parsePE(Buffer.from('not a pe file at all, just text that is long enough to be read as a header....')), null);
  assert.equal(fileKind('a.exe', buildPE()), 'exe');
  assert.equal(fileKind('a.msix', Buffer.from([0x50, 0x4b, 3, 4, 0])), 'msix');
});

test('signature: a correctly signed file passes every check and names the signer', () => {
  const s = checkSignature(signPE(buildPE()), parsePE(signPE(buildPE())), Date.parse('2030-01-01'));
  assert.equal(s.signed, true); assert.equal(s.error, undefined);
  assert.deepEqual(s.checks, { fileUnchanged: true, contentBound: true, signatureValid: true, certificateTimeValid: true });
  assert.equal(s.valid, true); assert.equal(s.signer.name, 'NexpatchOnline Test Signer'); assert.equal(s.signer.organization, 'NexpatchOnline Tests');
  assert.equal(s.publicRoot, false); assert.equal(s.timestamped, false);
});

test('signature: changing one byte after signing is caught, and the verdict blocks it', () => {
  const signed = signPE(buildPE());
  const tampered = Buffer.from(signed); tampered[0x260] ^= 0xff;   // inside the version resource
  const s = checkSignature(tampered, parsePE(tampered));
  assert.equal(s.checks.fileUnchanged, false); assert.equal(s.valid, false);
  const a = analyzeInstaller('setup.exe', tampered);
  const v = verdict({ kind: a.kind, signature: a.signature, defender: { result: 'clean' }, framework: a.framework });
  assert.equal(v.level, 'block'); assert.match(v.block[0], /changed after it was signed/);
});

test('signature: a forged signature over the right content fails', () => {
  const signed = signPE(buildPE());
  const p = parsePE(signed), off = p.cert.offset;
  const forged = Buffer.from(signed);
  const sigAt = forged.lastIndexOf(Buffer.from([0x04, 0x82, 0x01, 0x00]), forged.length) + 4;   // the 256-byte RSA signature
  forged[sigAt + 10] ^= 0x01;
  assert.ok(sigAt > off);
  const s = checkSignature(forged, parsePE(forged));
  assert.equal(s.checks.fileUnchanged, true); assert.equal(s.checks.signatureValid, false); assert.equal(s.valid, false);
});

test('signature: expiry only matters without a timestamp', () => {
  const late = Date.parse('2050-01-01');
  assert.equal(checkSignature(signPE(buildPE()), parsePE(signPE(buildPE())), late).checks.certificateTimeValid, false);
  const ts = signPE(buildPE(), { timestamp: true });
  const s = checkSignature(ts, parsePE(ts), late);
  assert.equal(s.timestamped, true); assert.equal(s.checks.certificateTimeValid, true);
});

test('frameworks are recognised from their markers, with matching silent switches', () => {
  const withMarker = m => { const b = buildPE({ extra: Buffer.from('....' + m + '....', 'latin1') }); return detectFramework(b, parsePE(b)); };
  assert.equal(withMarker('Inno Setup Setup Data (6.2.0)'), 'inno');
  assert.equal(withMarker('Nullsoft Install System v3.09'), 'nsis');
  assert.equal(withMarker('Nullsoft Install System electron-builder'), 'nsis-electron');
  assert.equal(withMarker('SquirrelSetup'), 'squirrel');
  assert.equal(withMarker('nothing special'), 'unknown');
  const msiInside = buildPE({ extra: Buffer.concat([Buffer.alloc(16), Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])]) });
  assert.equal(detectFramework(msiInside, parsePE(msiInside)), 'msi-wrapper');
  assert.match(recommend({ kind: 'exe', framework: 'inno', file: 'setup.exe' })[0].install, /\/VERYSILENT .*\/ALLUSERS/);
  assert.equal(recommend({ kind: 'exe', framework: 'nsis', file: 'setup.exe' })[0].install, '"setup.exe" /S');
  assert.equal(recommend({ kind: 'exe', framework: 'unknown', file: 'x.exe' }).every(o => o.confidence === 'low'), true);
  assert.equal(recommend({ kind: 'msix', file: 'a.msix' })[0].unsupported, true);
});

test('compound file and MSI: stream names, summary information and the Property table are read', () => {
  assert.equal(msiStreamName(msiEncode('!_StringPool')), '!_StringPool');
  assert.equal(msiStreamName(msiEncode('!Property')), '!Property');
  const buf = buildMsi({ ProductCode: '{12345678-90AB-CDEF-1234-567890ABCDEF}', ProductVersion: '2.5.1', ProductName: 'Contoso Widget', Manufacturer: 'Contoso Ltd', ALLUSERS: '1' });
  assert.equal(readCompoundFile(buf).entries.length, 4);
  const m = analyzeMsi(buf);
  assert.equal(m.propertiesRead, true);
  assert.equal(m.productCode, '{12345678-90AB-CDEF-1234-567890ABCDEF}'); assert.equal(m.productVersion, '2.5.1'); assert.equal(m.productName, 'Contoso Widget');
  assert.equal(m.manufacturer, 'Contoso Ltd'); assert.equal(m.arch, 'x64'); assert.equal(m.summary.packageCode, '{AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE}');
  const a = analyzeInstaller('widget.msi', buf);
  assert.equal(a.kind, 'msi'); assert.equal(a.suggested.version, '2.5.1');
  assert.equal(a.options[0].install, 'msiexec /i "widget.msi" /qn /norestart ALLUSERS=1');
  assert.equal(a.options[0].uninstall, 'msiexec /x {12345678-90AB-CDEF-1234-567890ABCDEF} /qn /norestart');
  assert.deepEqual(a.options[0].detection, { type: 'msi', productCode: '{12345678-90AB-CDEF-1234-567890ABCDEF}', version: '2.5.1' });
});

test('broken input never throws: it is reported as unreadable', () => {
  assert.equal(readCompoundFile(Buffer.alloc(100)), null);
  const junk = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(600, 0xff)]);
  assert.doesNotThrow(() => analyzeInstaller('bad.msi', junk));
  const pe = buildPE(); pe.writeUInt32LE(0x380, 0x58 + 112 + 32); pe.writeUInt32LE(0x40, 0x58 + 112 + 36);   // certificate table pointing at junk
  const a = analyzeInstaller('bad.exe', pe);
  assert.equal(a.signature.signed, true); assert.ok(a.signature.error);
});

test('verdict: Defender and VirusTotal decide blocks; unsigned or unscanned files need review; clean signed files pass', () => {
  const good = { signed: true, valid: true, checks: { fileUnchanged: true, contentBound: true, signatureValid: true, certificateTimeValid: true }, publicRoot: true, signer: { name: 'Google LLC', issuer: 'DigiCert' } };
  assert.equal(verdict({ kind: 'exe', signature: good, defender: { result: 'clean' }, framework: 'inno' }).level, 'ok');
  assert.equal(verdict({ kind: 'exe', signature: good, defender: { result: 'malicious' }, framework: 'inno' }).level, 'block');
  assert.equal(verdict({ kind: 'exe', signature: good, defender: { result: 'clean' }, virustotal: { known: true, malicious: 5, suspicious: 0 }, framework: 'inno' }).level, 'block');
  assert.equal(verdict({ kind: 'exe', signature: good, defender: { result: 'clean' }, virustotal: { known: true, malicious: 1, suspicious: 0 }, framework: 'inno' }).level, 'review');
  assert.equal(verdict({ kind: 'exe', signature: good, defender: null, framework: 'inno' }).level, 'review');
  assert.equal(verdict({ kind: 'exe', signature: { signed: false }, defender: { result: 'clean' }, framework: 'inno' }).level, 'review');
  assert.equal(verdict({ kind: 'exe', signature: { ...good, publicRoot: false }, defender: { result: 'clean' }, framework: 'inno' }).level, 'review');
});
