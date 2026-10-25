/**
 * KASIR YAKULT - SERVER (Google Apps Script)  v5
 *
 * Skrip ini adalah "otak" bersama untuk semua HP: akun + PIN, daftar toko pelanggan,
 * nota penjualan, dan stok (gudang, bawaan sales). Data disimpan di spreadsheet ini
 * dan bisa Anda lihat langsung. Sheet yang dibuat otomatis:
 *   Akun, Pelanggan, Nota, Stok, Pengaturan          (data utama - jangan diubah manual)
 *   Rekap Harian, Rekap Sales, Rekap Pelanggan,
 *   Rekap Stok, Tutup Hari                           (rekap otomatis, tinggal dibaca)
 *
 * CARA PASANG (sekali saja):
 *  1. Buat spreadsheet Google baru (misalnya "Kasir Yakult").
 *  2. Menu Ekstensi > Apps Script. Hapus isi bawaan, tempel seluruh isi file ini, Simpan.
 *  3. Deploy > New deployment > jenis "Web app".
 *       Execute as: Me      Who has access: Anyone
 *     lalu Deploy dan izinkan akses (peringatan "belum diverifikasi" itu normal:
 *     Advanced > Go to ... > Allow).
 *  4. Salin alamat Web app yang berakhiran /exec, tempel di aplikasi.
 *
 * MEMPERBARUI SKRIP DI LAIN WAKTU: tempel kode baru, lalu Deploy > Manage deployments >
 * ikon pensil > Version: New version > Deploy. Alamat /exec tidak berubah.
 *
 * KEAMANAN SINGKAT: PIN disimpan sebagai hash bersalt, bukan teks asli. Setiap HP memakai
 * token bertanda tangan yang berlaku 30 hari. PIN salah 5 kali mengunci akun 5 menit.
 * Siapa pun yang memegang akses edit ke spreadsheet ini dapat melihat semua data.
 */

var VERSION = 5;
var TZ = 'Asia/Pontianak';           // zona waktu untuk kolom Tanggal/Jam di sheet
var SH = { AKUN: 'Akun', PEL: 'Pelanggan', NOTA: 'Nota', STOK: 'Stok', SET: 'Pengaturan' };
var CODES = ['YO05', 'YO02', 'OM05', 'OM02', 'OS05', 'OS02', 'YT05', 'YT02'];
var MAX_FAIL = 5;
var LOCK_MS = 5 * 60 * 1000;
var TOKEN_MS = 30 * 24 * 3600 * 1000;
var PAGE = 500;
var MAX_OPS = 60;
var MAX_USERS = 40;

var H_AKUN = ['ID', 'Nama', 'Kode', 'Peran', 'Aktif', 'Salt', 'Hash PIN', 'Hash Pemulihan', 'Gagal', 'Kunci Sampai', 'Dibuat', 'Diperbarui'];
var A = { id: 0, nama: 1, kode: 2, peran: 3, aktif: 4, salt: 5, hash: 6, rec: 7, gagal: 8, kunci: 9, dibuat: 10, upd: 11 };

var H_PEL = ['ID', 'Nama', 'Kontak', 'Telepon', 'Alamat', 'Area', 'Catatan', 'Dibuat Oleh', 'Dibuat', 'Diedit', 'Dihapus', 'Diperbarui'];
var P = { id: 0, nama: 1, kontak: 2, telp: 3, alamat: 4, area: 5, catatan: 6, oleh: 7, dibuat: 8, ed: 9, del: 10, upd: 11 };

var H_NOTA = ['ID', 'No Nota', 'Tanggal', 'Jam', 'Kasir', 'Pelanggan', 'Total Botol', 'Total (Rp)', 'Tunai (Rp)', 'Kembalian (Rp)', 'Toko']
  .concat(CODES, ['ID Pelanggan', 'ID Kasir', 'Rincian', 'Dihapus', 'Waktu', 'No', 'Diperbarui']);
var N = { id: 0, inv: 1, tgl: 2, jam: 3, kasir: 4, pel: 5, botol: 6, total: 7, tunai: 8, kembali: 9, toko: 10, code0: 11, pelId: 19, kasirId: 20, rin: 21, del: 22, ts: 23, no: 24, upd: 25 };

var H_STOK = ['ID', 'Waktu', 'Tanggal', 'Jam', 'Jenis', 'Untuk ID', 'Untuk', 'Kode', 'Jumlah', 'Catatan', 'Oleh ID', 'Oleh', 'Seharusnya', 'Fisik', 'Dibatalkan', 'Diperbarui'];
var T = { id: 0, ts: 1, tgl: 2, jam: 3, tipe: 4, untukId: 5, untuk: 6, kode: 7, qty: 8, note: 9, olehId: 10, oleh: 11, exp: 12, phys: 13, batal: 14, upd: 15 };

var H_SET = ['Kunci', 'Nilai', 'Diperbarui'];

var _seq = 0;
var _users = null;

/* ================= pintu masuk ================= */

function doGet(e) {
  return out({ ok: true, v: VERSION, pesan: 'Kasir Yakult server aktif' });
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
  } catch (err) {
    return out({ ok: false, err: 'sibuk' });
  }
  var res;
  try {
    _seq = 0;
    _users = null;
    var body = JSON.parse(e.postData.contents);
    res = route(body || {});
    saveSeq();
  } catch (err2) {
    res = { ok: false, err: 'server', msg: String((err2 && err2.message) || err2) };
  } finally {
    lock.releaseLock();
  }
  return out(res);
}

function route(b) {
  var a = b.a;
  if (a === 'status') return doStatus();
  if (a === 'diag') return doDiag();
  if (a === 'setup') return doSetup(b);
  if (a === 'login') return doLogin(b);
  if (a === 'forgot') return doForgot(b);
  var u = auth(b.t);
  if (!u) return { ok: false, err: 'auth' };
  if (a === 'sync') return doSync(u, b);
  if (a === 'my_pin') return doMyPin(u, b);
  if (u.role !== 'owner') return { ok: false, err: 'izin' };
  if (a === 'user_add') return doUserAdd(b);
  if (a === 'user_edit') return doUserEdit(u, b);
  if (a === 'user_pin') return doUserPin(b);
  if (a === 'new_code') return doNewCode(u, b);
  if (a === 'set_settings') return doSetSettings(b);
  return { ok: false, err: 'aksi' };
}

/* ================= alat kecil ================= */

function out(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
function props() { return PropertiesService.getScriptProperties(); }
function secret() {
  var p = props(), s = p.getProperty('SECRET');
  if (!s) { s = Utilities.getUuid() + Utilities.getUuid(); p.setProperty('SECRET', s); }
  return s;
}
function hex(bytes) {
  var o = '';
  for (var i = 0; i < bytes.length; i++) {
    var b = (bytes[i] + 256) % 256;
    o += (b < 16 ? '0' : '') + b.toString(16);
  }
  return o;
}
function sha(str) { return hex(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, str, Utilities.Charset.UTF_8)); }
function hmac(str) { return hex(Utilities.computeHmacSha256Signature(str, secret())); }
function rid(n) { return Utilities.getUuid().replace(/-/g, '').substr(0, n); }
function newId(prefix) { return prefix + Date.now().toString(36) + rid(4); }
function nextSeq() {
  if (!_seq) _seq = Number(props().getProperty('SEQ')) || 0;
  _seq = Math.max(Date.now(), _seq + 1);
  return _seq;
}
function saveSeq() { if (_seq) props().setProperty('SEQ', String(_seq)); }
function clip(v, n) { return String(v === null || v === undefined ? '' : v).replace(/[\u0000-\u001f]/g, ' ').replace(/^\s+|\s+$/g, '').substr(0, n); }
function vid(x) { x = String(x || ''); return /^[A-Za-z][A-Za-z0-9_-]{3,39}$/.test(x) ? x : ''; }
function norm(s) { return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }
function validPin(p) { return /^\d{4,6}$/.test(String(p || '')); }
function fmtD(ts, f) { return Utilities.formatDate(new Date(ts), TZ, f); }
function isi(code) { return parseInt(code.substr(2), 10) || 1; }
function pad(n, w) { var s = String(n); while (s.length < w) s = '0' + s; return s; }
function bad(err) { return { ok: false, err: err }; }

// Teks yang mirip angka/tanggal/rumus diberi apostrof di depan supaya Sheets tidak mengubahnya.
function tx(v) {
  var s = (v === null || v === undefined) ? '' : String(v);
  return /^[0-9=+\-@.]|^(true|false)$/i.test(s) ? "'" + s : s;
}
function prep(vals) {
  var o = [];
  for (var i = 0; i < vals.length; i++) {
    var v = vals[i];
    if (v === null || v === undefined || (typeof v === 'number' && !isFinite(v))) o.push('');
    else o.push(typeof v === 'string' ? tx(v) : v);
  }
  return o;
}

function genCode() {
  var cs = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', u = Utilities.getUuid().replace(/-/g, ''), s = '';
  for (var i = 0; i < 8; i++) s += cs.charAt(parseInt(u.substr(i * 2, 2), 16) % cs.length);
  return s.substr(0, 4) + '-' + s.substr(4);
}

/* ================= sheet ================= */

function sheetOf(name, header) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}
function readAll(sh, ncol) {
  var n = sh.getLastRow();
  return n < 2 ? [] : sh.getRange(2, 1, n - 1, ncol).getValues();
}
function readCol(sh, col) {
  var n = sh.getLastRow();
  return n < 2 ? [] : sh.getRange(2, col, n - 1, 1).getValues();
}

function Table(name, header) {
  this.sh = sheetOf(name, header);
  this.n = header.length;
  this.map = null;
  this.pend = [];
  this.pendMap = {};
}
Table.prototype.load = function () {
  if (this.map) return;
  this.map = {};
  var v = readCol(this.sh, 1);
  for (var i = 0; i < v.length; i++) {
    if (v[i][0] !== '') this.map[String(v[i][0])] = i + 2;
  }
};
Table.prototype.has = function (id) {
  this.load();
  return !!this.map[id] || Object.prototype.hasOwnProperty.call(this.pendMap, id);
};
Table.prototype.get = function (id) {
  this.load();
  if (Object.prototype.hasOwnProperty.call(this.pendMap, id)) return { vals: this.pend[this.pendMap[id]], pend: true };
  var r = this.map[id];
  if (!r) return null;
  return { vals: this.sh.getRange(r, 1, 1, this.n).getValues()[0], row: r };
};
Table.prototype.add = function (vals) {
  this.pendMap[String(vals[0])] = this.pend.length;
  this.pend.push(vals);
};
Table.prototype.save = function (rec) {
  if (rec.pend) return;
  this.sh.getRange(rec.row, 1, 1, this.n).setValues([prep(rec.vals)]);
};
Table.prototype.flush = function () {
  if (!this.pend.length) return;
  this.load();
  var start = this.sh.getLastRow() + 1, rows = [];
  for (var i = 0; i < this.pend.length; i++) rows.push(prep(this.pend[i]));
  this.sh.getRange(start, 1, rows.length, this.n).setValues(rows);
  for (var j = 0; j < this.pend.length; j++) this.map[String(this.pend[j][0])] = start + j;
  this.pend = [];
  this.pendMap = {};
};

function tables() {
  ensureRekap();
  return {
    nota: new Table(SH.NOTA, H_NOTA),
    pel: new Table(SH.PEL, H_PEL),
    stok: new Table(SH.STOK, H_STOK)
  };
}

/* ================= pengaturan ================= */

function getSettings() {
  var s = { shop: 'Penjualan Yakult', low: 10, prices: {} };
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SH.SET);
  if (!sh || sh.getLastRow() < 2) return s;
  var v = sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues();
  for (var i = 0; i < v.length; i++) {
    var k = String(v[i][0]), val = v[i][1];
    if (k === 'shop' && String(val) !== '') s.shop = String(val);
    else if (k === 'low') { var n = Number(val); if (isFinite(n) && n >= 0) s.low = Math.floor(n); }
    else if (k === 'prices') { try { var o = JSON.parse(String(val)); if (o && typeof o === 'object') s.prices = cleanPrices(o); } catch (e) {} }
  }
  return s;
}
function cleanPrices(o) {
  var r = {};
  for (var i = 0; i < CODES.length; i++) {
    var v = o[CODES[i]];
    if (v !== undefined && v !== null && v !== '' && isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= 1000000) r[CODES[i]] = Math.round(Number(v));
  }
  return r;
}
function putSettings(s) {
  var sh = sheetOf(SH.SET, H_SET), st = nextSeq();
  sh.getRange(2, 1, 3, 3).setValues(prep([['shop', s.shop, st], ['low', s.low, st], ['prices', JSON.stringify(s.prices), st]]));
}

/* ================= akun ================= */

function loadUsers() {
  if (_users) return _users;
  var sh = sheetOf(SH.AKUN, H_AKUN), v = readAll(sh, H_AKUN.length), list = [];
  for (var i = 0; i < v.length; i++) {
    var r = v[i];
    if (r[A.id] === '') continue;
    list.push({
      row: i + 2, id: String(r[A.id]), nama: String(r[A.nama]), kode: String(r[A.kode]), role: String(r[A.peran]),
      aktif: Number(r[A.aktif]) === 1, salt: String(r[A.salt]), hash: String(r[A.hash]), rec: String(r[A.rec]),
      gagal: Number(r[A.gagal]) || 0, kunci: Number(r[A.kunci]) || 0, dibuat: Number(r[A.dibuat]) || 0
    });
  }
  _users = list;
  return list;
}
function userById(id) {
  var l = loadUsers();
  for (var i = 0; i < l.length; i++) if (l[i].id === id) return l[i];
  return null;
}
function writeUser(u) {
  var sh = sheetOf(SH.AKUN, H_AKUN);
  var vals = [u.id, u.nama, u.kode, u.role, u.aktif ? 1 : 0, u.salt, u.hash, u.rec, u.gagal || 0, u.kunci || 0, u.dibuat || Date.now(), Date.now()];
  sh.getRange(u.row, 1, 1, H_AKUN.length).setValues([prep(vals)]);
}
function addUserRow(u) {
  var sh = sheetOf(SH.AKUN, H_AKUN);
  var row = sh.getLastRow() + 1;
  u.row = row;
  writeUser(u);
  if (_users) _users.push(u);
}
function pubUser(u) { return { id: u.id, name: u.nama, kode: u.kode, role: u.role, active: u.aktif }; }
function publicUsers(me) {
  var l = loadUsers(), r = [];
  for (var i = 0; i < l.length; i++) {
    if (me.role === 'owner' || l[i].aktif) r.push(pubUser(l[i]));
  }
  return r;
}
function kodeTaken(k, users, exceptId) {
  for (var i = 0; i < users.length; i++) if (users[i].kode === k && users[i].id !== exceptId) return true;
  return false;
}
function makeKode(name, users) {
  var base = norm(name);
  while (base.length < 2) base += 'X';
  var tries = [base.substr(0, 3), base.substr(0, 2), base.substr(0, 4)];
  for (var i = 0; i < tries.length; i++) if (!kodeTaken(tries[i], users)) return tries[i];
  for (var n = 2; n < 100; n++) { var c = base.substr(0, 2) + n; if (!kodeTaken(c, users)) return c; }
  return base.substr(0, 2) + (Date.now() % 1000);
}
function nameTaken(name, users, exceptId) {
  var low = name.toLowerCase();
  for (var i = 0; i < users.length; i++) if (users[i].nama.toLowerCase() === low && users[i].id !== exceptId) return true;
  return false;
}

function mkToken(id) {
  var p = id + '.' + (Date.now() + TOKEN_MS);
  return p + '.' + hmac(p).substr(0, 40);
}
function auth(tok) {
  if (typeof tok !== 'string') return null;
  var p = tok.split('.');
  if (p.length !== 3) return null;
  var payload = p[0] + '.' + p[1];
  if (hmac(payload).substr(0, 40) !== p[2]) return null;
  var exp = Number(p[1]);
  if (!(exp > Date.now())) return null;
  var u = userById(p[0]);
  if (!u || !u.aktif) return null;
  u.exp = exp;
  return u;
}
function loginReply(u, extra) {
  var r = {
    ok: true, token: mkToken(u.id),
    user: { id: u.id, name: u.nama, kode: u.kode, role: u.role },
    verifier: { salt: u.salt, hash: u.hash },
    settings: getSettings()
  };
  if (extra) for (var k in extra) r[k] = extra[k];
  return r;
}

function doStatus() {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SH.AKUN);
  if (!sh || sh.getLastRow() < 2) return { ok: true, v: VERSION, init: false };
  var users = loadUsers(), list = [];
  for (var i = 0; i < users.length; i++) if (users[i].aktif) list.push({ id: users[i].id, name: users[i].nama });
  return { ok: true, v: VERSION, init: true, shop: getSettings().shop, users: list };
}

function doDiag() {
  var r = { ok: true, v: VERSION, cek: {} };
  function t(name, fn) { try { r.cek[name] = fn() ? 'ok' : 'gagal'; } catch (e) { r.cek[name] = 'galat: ' + String(e && e.message || e); } }
  t('spreadsheet', function () { return !!SpreadsheetApp.getActiveSpreadsheet().getId(); });
  t('hash', function () { return sha('a').length === 64; });
  t('tandatangan', function () { return hmac('a').length === 64; });
  t('properti', function () { return secret().length > 20; });
  t('waktu', function () { return /^\d{4}-\d{2}-\d{2}$/.test(fmtD(Date.now(), 'yyyy-MM-dd')); });
  return r;
}

function doSetup(b) {
  var name = clip(b.name, 30), shop = clip(b.shop, 40) || 'Penjualan Yakult', pin = String(b.pin || '');
  if (!name) return bad('nama');
  if (!validPin(pin)) return bad('pin');
  var sh = sheetOf(SH.AKUN, H_AKUN);
  if (sh.getLastRow() >= 2) return bad('sudah');
  var salt = rid(24), code = genCode();
  var u = {
    id: newId('u'), nama: name, kode: makeKode(name, []), role: 'owner', aktif: true, salt: salt,
    hash: sha(salt + ':' + pin), rec: sha(salt + ':' + norm(code)), gagal: 0, kunci: 0, dibuat: Date.now()
  };
  addUserRow(u);
  tables();
  putSettings({ shop: shop, low: 10, prices: {} });
  return loginReply(u, { recovery: code });
}

function lockedReply(u) {
  return { ok: false, err: 'terkunci', wait: Math.ceil((u.kunci - Date.now()) / 1000) };
}
function failPin(u) {
  u.gagal = (u.gagal || 0) + 1;
  var sisa = MAX_FAIL - u.gagal;
  if (u.gagal >= MAX_FAIL) { u.kunci = Date.now() + LOCK_MS; u.gagal = 0; sisa = 0; }
  writeUser(u);
  return { ok: false, err: 'pin', sisa: sisa };
}
function doLogin(b) {
  var u = userById(String(b.uid || ''));
  if (!u || !u.aktif) return bad('pengguna');
  if (u.kunci > Date.now()) return lockedReply(u);
  var pin = String(b.pin || '');
  if (!validPin(pin)) return bad('pin');
  if (sha(u.salt + ':' + pin) !== u.hash) return failPin(u);
  if (u.gagal || u.kunci) { u.gagal = 0; u.kunci = 0; writeUser(u); }
  return loginReply(u);
}
function doForgot(b) {
  var users = loadUsers(), o = null;
  for (var i = 0; i < users.length; i++) if (users[i].role === 'owner' && users[i].aktif) { o = users[i]; break; }
  if (!o) return bad('pengguna');
  if (o.kunci > Date.now()) return lockedReply(o);
  if (!validPin(b.pin)) return bad('pin');
  if (!o.rec || sha(o.salt + ':' + norm(b.code)) !== o.rec) {
    var f = failPin(o);
    f.err = f.err === 'pin' ? 'kode' : f.err;
    return f;
  }
  o.hash = sha(o.salt + ':' + String(b.pin));
  o.gagal = 0; o.kunci = 0;
  writeUser(o);
  return { ok: true };
}
function doMyPin(u, b) {
  if (sha(u.salt + ':' + String(b.old || '')) !== u.hash) return bad('pin');
  if (!validPin(b.pin)) return bad('pinbaru');
  u.hash = sha(u.salt + ':' + String(b.pin));
  writeUser(u);
  return { ok: true, verifier: { salt: u.salt, hash: u.hash } };
}
function doUserAdd(b) {
  var users = loadUsers();
  var name = clip(b.name, 30);
  if (!name) return bad('nama');
  if (users.length >= MAX_USERS) return bad('penuh');
  if (!validPin(b.pin)) return bad('pinbaru');
  if (nameTaken(name, users, '')) return bad('namaada');
  var kode = norm(b.kode).substr(0, 4);
  if (kode) {
    if (kode.length < 2) return bad('kode');
    if (kodeTaken(kode, users, '')) return bad('kodeada');
  } else kode = makeKode(name, users);
  var salt = rid(24);
  var u = { id: newId('u'), nama: name, kode: kode, role: 'kasir', aktif: true, salt: salt, hash: sha(salt + ':' + String(b.pin)), rec: '', gagal: 0, kunci: 0, dibuat: Date.now() };
  addUserRow(u);
  return { ok: true, id: u.id, kode: kode, users: publicUsers({ role: 'owner' }) };
}
function doUserEdit(me, b) {
  var u = userById(String(b.id || ''));
  if (!u) return bad('pengguna');
  var users = loadUsers();
  if (b.name !== undefined) {
    var name = clip(b.name, 30);
    if (!name) return bad('nama');
    if (nameTaken(name, users, u.id)) return bad('namaada');
    u.nama = name;
  }
  if (b.kode !== undefined) {
    var kode = norm(b.kode).substr(0, 4);
    if (kode.length < 2) return bad('kode');
    if (kodeTaken(kode, users, u.id)) return bad('kodeada');
    u.kode = kode;
  }
  if (b.active !== undefined) {
    var on = !!b.active;
    if (!on) {
      if (u.id === me.id) return bad('diri');
      if (u.role === 'owner') return bad('pemilik');
    }
    u.aktif = on;
  }
  writeUser(u);
  return { ok: true, users: publicUsers({ role: 'owner' }) };
}
function doUserPin(b) {
  var u = userById(String(b.id || ''));
  if (!u) return bad('pengguna');
  if (!validPin(b.pin)) return bad('pinbaru');
  u.hash = sha(u.salt + ':' + String(b.pin));
  u.gagal = 0; u.kunci = 0;
  writeUser(u);
  return { ok: true };
}
function doNewCode(me, b) {
  if (sha(me.salt + ':' + String(b.pin || '')) !== me.hash) return bad('pin');
  var code = genCode();
  me.rec = sha(me.salt + ':' + norm(code));
  writeUser(me);
  return { ok: true, recovery: code };
}
function doSetSettings(b) {
  var cur = getSettings();
  var s = { shop: cur.shop, low: cur.low, prices: cur.prices };
  if (b.shop !== undefined) { s.shop = clip(b.shop, 40); if (!s.shop) return bad('data'); }
  if (b.low !== undefined) {
    var n = Number(b.low);
    if (!(isFinite(n) && n >= 0 && n <= 9999)) return bad('data');
    s.low = Math.floor(n);
  }
  if (b.prices !== undefined) {
    if (!b.prices || typeof b.prices !== 'object') return bad('data');
    s.prices = cleanPrices(b.prices);
  }
  putSettings(s);
  return { ok: true, settings: getSettings() };
}

/* ================= sinkron ================= */

function doSync(u, b) {
  var tb = tables();
  var ops = Array.isArray(b.ops) ? b.ops.slice(0, MAX_OPS) : [];
  var acks = [];
  for (var i = 0; i < ops.length; i++) {
    var o = ops[i] || {}, a;
    try { a = applyOp(tb, u, o.t, o.d || {}); } catch (e) { a = bad('server'); }
    acks.push(a);
  }
  tb.nota.flush(); tb.pel.flush(); tb.stok.flush();
  var pulled = pull(tb, Number(b.since) || 0);
  var res = {
    ok: true, acks: acks, cursor: pulled.cursor, more: pulled.more,
    nota: pulled.nota, pel: pulled.pel, stok: pulled.stok,
    users: publicUsers(u), settings: getSettings(),
    me: { id: u.id, name: u.nama, kode: u.kode, role: u.role }, now: Date.now()
  };
  if (u.exp - Date.now() < TOKEN_MS / 2) res.token = mkToken(u.id);
  return res;
}

function applyOp(tb, u, t, d) {
  switch (t) {
    case 'sale': return opSale(tb, u, d);
    case 'sale_del': return u.role === 'owner' ? opDelFlag(tb.nota, d, N.del, N.upd) : bad('izin');
    case 'cust': return opCust(tb, u, d);
    case 'cust_del': return u.role === 'owner' ? opDelFlag(tb.pel, d, P.del, P.upd) : bad('izin');
    case 'stok': return opStok(tb, u, d);
    case 'stok_void': return u.role === 'owner' ? opDelFlag(tb.stok, d, T.batal, T.upd) : bad('izin');
  }
  return bad('data');
}

function opDelFlag(tbl, d, colFlag, colUpd) {
  var id = vid(d.id);
  if (!id) return bad('data');
  var rec = tbl.get(id);
  if (!rec) return { ok: true };
  rec.vals[colFlag] = 1;
  rec.vals[colUpd] = nextSeq();
  tbl.save(rec);
  return { ok: true };
}

function cleanCust(c) {
  if (!c || typeof c !== 'object') return null;
  var id = vid(c.id), name = clip(c.name, 60);
  if (!id || !name) return null;
  return { id: id, name: name, address: clip(c.address, 200), phone: clip(c.phone, 25) };
}

function opSale(tb, u, d) {
  var id = vid(d.id);
  if (!id) return bad('data');
  var ts = Number(d.ts), now = Date.now();
  if (!(ts > now - 400 * 86400000 && ts < now + 2 * 86400000)) return bad('data');
  if (!Array.isArray(d.items) || !d.items.length || d.items.length > 30) return bad('data');
  var packs = {}, clean = [], botol = 0, total = 0;
  for (var i = 0; i < d.items.length; i++) {
    var it = d.items[i] || {}, code = String(it.i), q = Math.floor(Number(it.q)), p = Math.floor(Number(it.p));
    if (CODES.indexOf(code) < 0 || !(q >= 1 && q <= 9999) || !(p >= 0 && p <= 1000000)) return bad('data');
    packs[code] = (packs[code] || 0) + q;
    botol += q * isi(code);
    total += q * p;
    clean.push({ i: code, q: q, p: p });
  }
  if (tb.nota.has(id)) return { ok: true };
  var cash = Math.floor(Number(d.cash));
  if (!(cash >= total)) cash = total;
  var c = cleanCust(d.cust);
  var no = Math.floor(Number(d.no)) || 1;
  var inv = clip(d.inv, 30) || (u.kode + fmtD(ts, 'yyMMdd') + '-' + pad(no, 3));
  var row = new Array(H_NOTA.length), k;
  row[N.id] = id; row[N.inv] = inv; row[N.tgl] = fmtD(ts, 'yyyy-MM-dd'); row[N.jam] = fmtD(ts, 'HH:mm');
  row[N.kasir] = u.nama; row[N.pel] = c ? c.name : '';
  row[N.botol] = botol; row[N.total] = total; row[N.tunai] = cash; row[N.kembali] = cash - total;
  row[N.toko] = clip(d.shop, 40);
  for (k = 0; k < CODES.length; k++) row[N.code0 + k] = packs[CODES[k]] || 0;
  row[N.pelId] = c ? c.id : ''; row[N.kasirId] = u.id;
  row[N.rin] = JSON.stringify({ it: clean, c: c });
  row[N.del] = 0; row[N.ts] = ts; row[N.no] = no; row[N.upd] = nextSeq();
  tb.nota.add(row);
  return { ok: true };
}

function opCust(tb, u, d) {
  var id = vid(d.id), name = clip(d.name, 60);
  if (!id || !name) return bad('data');
  var f = {
    kontak: clip(d.contact, 40), telp: clip(d.phone, 25), alamat: clip(d.address, 200),
    area: clip(d.area, 40), catatan: clip(d.note, 120)
  };
  var ed = Number(d.ed) || Date.now();
  var rec = tb.pel.get(id);
  if (!rec) {
    var row = new Array(H_PEL.length);
    row[P.id] = id; row[P.nama] = name; row[P.kontak] = f.kontak; row[P.telp] = f.telp; row[P.alamat] = f.alamat;
    row[P.area] = f.area; row[P.catatan] = f.catatan; row[P.oleh] = u.nama; row[P.dibuat] = Date.now();
    row[P.ed] = ed; row[P.del] = 0; row[P.upd] = nextSeq();
    tb.pel.add(row);
    return { ok: true };
  }
  var v = rec.vals;
  if (Number(v[P.del]) === 1) return { ok: true };
  if (ed < (Number(v[P.ed]) || 0)) return { ok: true };
  v[P.nama] = name; v[P.kontak] = f.kontak; v[P.telp] = f.telp; v[P.alamat] = f.alamat;
  v[P.area] = f.area; v[P.catatan] = f.catatan; v[P.ed] = ed; v[P.upd] = nextSeq();
  tb.pel.save(rec);
  return { ok: true };
}

function opStok(tb, u, d) {
  var id = vid(d.id);
  if (!id) return bad('data');
  var ts = Number(d.ts), now = Date.now();
  if (!(ts > now - 400 * 86400000 && ts < now + 2 * 86400000)) return bad('data');
  var type = String(d.type), code = String(d.code), qty = Math.round(Number(d.qty));
  if (['masuk', 'bawa', 'kembali', 'hitung'].indexOf(type) < 0 || CODES.indexOf(code) < 0 || !isFinite(qty)) return bad('data');
  var forId = String(d.fid || ''), forName;
  if (forId === 'GUDANG') forName = 'Gudang';
  else {
    var tu = userById(forId);
    if (!tu || !tu.aktif) return bad('data');
    forName = tu.nama;
  }
  var owner = u.role === 'owner';
  if (type === 'masuk') {
    if (!owner || forId !== 'GUDANG' || qty < 1 || qty > 999999) return bad(owner ? 'data' : 'izin');
  } else if (type === 'bawa' || type === 'kembali') {
    if (forId === 'GUDANG' || qty < 1 || qty > 999999) return bad('data');
    if (!owner && forId !== u.id) return bad('izin');
  } else {
    if (Math.abs(qty) > 999999) return bad('data');
    if (!owner && forId !== u.id) return bad('izin');
  }
  if (tb.stok.has(id)) return { ok: true };
  var row = new Array(H_STOK.length);
  row[T.id] = id; row[T.ts] = ts; row[T.tgl] = fmtD(ts, 'yyyy-MM-dd'); row[T.jam] = fmtD(ts, 'HH:mm');
  row[T.tipe] = type; row[T.untukId] = forId; row[T.untuk] = forName; row[T.kode] = code; row[T.qty] = qty;
  row[T.note] = clip(d.note, 80); row[T.olehId] = u.id; row[T.oleh] = u.nama;
  row[T.exp] = type === 'hitung' && isFinite(Number(d.exp)) ? Math.round(Number(d.exp)) : '';
  row[T.phys] = type === 'hitung' && isFinite(Number(d.phys)) ? Math.round(Number(d.phys)) : '';
  row[T.batal] = 0; row[T.upd] = nextSeq();
  tb.stok.add(row);
  return { ok: true };
}

/* ================= tarik data ================= */

function gather(tbl, updIdx, kind, since, list) {
  var last = tbl.sh.getLastRow();
  if (last < 2) return;
  var v = tbl.sh.getRange(2, updIdx + 1, last - 1, 1).getValues();
  for (var i = 0; i < v.length; i++) {
    var u = Number(v[i][0]);
    if (u > since) list.push({ u: u, k: kind, r: i + 2 });
  }
}
function readRows(tbl, rows) {
  var res = [], i = 0;
  rows.sort(function (a, b) { return a - b; });
  while (i < rows.length) {
    var j = i;
    while (j + 1 < rows.length && rows[j + 1] === rows[j] + 1) j++;
    var vals = tbl.sh.getRange(rows[i], 1, j - i + 1, tbl.n).getValues();
    for (var k = 0; k < vals.length; k++) res.push(vals[k]);
    i = j + 1;
  }
  return res;
}
function pull(tb, since) {
  var list = [];
  gather(tb.nota, N.upd, 'nota', since, list);
  gather(tb.pel, P.upd, 'pel', since, list);
  gather(tb.stok, T.upd, 'stok', since, list);
  list.sort(function (a, b) { return a.u - b.u; });
  var more = list.length > PAGE;
  if (more) list = list.slice(0, PAGE);
  var by = { nota: [], pel: [], stok: [] }, cursor = since;
  for (var i = 0; i < list.length; i++) {
    by[list[i].k].push(list[i].r);
    if (list[i].u > cursor) cursor = list[i].u;
  }
  var res = { cursor: cursor, more: more, nota: [], pel: [], stok: [] }, rows, k;
  rows = readRows(tb.nota, by.nota);
  for (k = 0; k < rows.length; k++) { var n = wireNota(rows[k]); if (n) res.nota.push(n); }
  rows = readRows(tb.pel, by.pel);
  for (k = 0; k < rows.length; k++) res.pel.push(wirePel(rows[k]));
  rows = readRows(tb.stok, by.stok);
  for (k = 0; k < rows.length; k++) res.stok.push(wireStok(rows[k]));
  return res;
}
function wireNota(r) {
  var rin;
  try { rin = JSON.parse(String(r[N.rin])); } catch (e) { return null; }
  if (!rin || !Array.isArray(rin.it)) return null;
  return {
    id: String(r[N.id]), inv: String(r[N.inv]), ts: Number(r[N.ts]), no: Number(r[N.no]),
    uid: String(r[N.kasirId]), by: String(r[N.kasir]), cust: rin.c || null, items: rin.it,
    qty: Number(r[N.botol]), total: Number(r[N.total]), cash: Number(r[N.tunai]), change: Number(r[N.kembali]),
    shop: String(r[N.toko]), del: Number(r[N.del]) === 1 ? 1 : 0
  };
}
function wirePel(r) {
  return {
    id: String(r[P.id]), name: String(r[P.nama]), contact: String(r[P.kontak]), phone: String(r[P.telp]),
    address: String(r[P.alamat]), area: String(r[P.area]), note: String(r[P.catatan]), by: String(r[P.oleh]),
    ed: Number(r[P.ed]) || 0, del: Number(r[P.del]) === 1 ? 1 : 0
  };
}
function wireStok(r) {
  return {
    id: String(r[T.id]), ts: Number(r[T.ts]), type: String(r[T.tipe]), fid: String(r[T.untukId]), fname: String(r[T.untuk]),
    code: String(r[T.kode]), qty: Number(r[T.qty]), note: String(r[T.note]), by: String(r[T.olehId]), byName: String(r[T.oleh]),
    exp: r[T.exp] === '' ? null : Number(r[T.exp]), phys: r[T.phys] === '' ? null : Number(r[T.phys]),
    void: Number(r[T.batal]) === 1 ? 1 : 0
  };
}

/* ================= rekap otomatis di sheet ================= */

function setFormulaIfChanged(sh, formula) {
  if (sh.getRange('A1').getFormula() !== formula) sh.getRange('A1').setFormula(formula);
}
function ensureRekap() {
  var ss = SpreadsheetApp.getActiveSpreadsheet(), sh, q, i;
  var letters = ['L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S'];

  sh = ss.getSheetByName('Rekap Harian') || ss.insertSheet('Rekap Harian');
  var sel = 'select C, count(A), sum(G)', lab = "label C 'Tanggal', count(A) 'Jumlah Nota', sum(G) 'Total Botol'";
  for (i = 0; i < letters.length; i++) { sel += ', sum(' + letters[i] + ')'; lab += ", sum(" + letters[i] + ") '" + CODES[i] + " (pak)'"; }
  sel += ', sum(H)'; lab += ", sum(H) 'Omzet (Rp)'";
  q = sel + ' where A is not null and W = 0 group by C order by C desc ' + lab;
  setFormulaIfChanged(sh, '=IFERROR(QUERY(Nota!A2:Z,"' + q + '",0),"Belum ada penjualan")');

  sh = ss.getSheetByName('Rekap Sales') || ss.insertSheet('Rekap Sales');
  q = "select C, E, count(A), sum(G), sum(H) where A is not null and W = 0 group by C, E order by C desc, E " +
    "label C 'Tanggal', E 'Sales', count(A) 'Jumlah Nota', sum(G) 'Total Botol', sum(H) 'Omzet (Rp)'";
  setFormulaIfChanged(sh, '=IFERROR(QUERY(Nota!A2:Z,"' + q + '",0),"Belum ada penjualan")');

  sh = ss.getSheetByName('Rekap Pelanggan') || ss.insertSheet('Rekap Pelanggan');
  q = "select F, count(A), sum(G), sum(H) where A is not null and W = 0 and F <> '' group by F order by sum(H) desc " +
    "label F 'Pelanggan', count(A) 'Jumlah Nota', sum(G) 'Total Botol', sum(H) 'Total Belanja (Rp)'";
  setFormulaIfChanged(sh, '=IFERROR(QUERY(Nota!A2:Z,"' + q + '",0),"Belum ada penjualan ke pelanggan")');

  sh = ss.getSheetByName('Rekap Stok') || ss.insertSheet('Rekap Stok');
  q = "select G, H, sum(I) where A is not null and O = 0 group by G, H pivot E";
  setFormulaIfChanged(sh, '=IFERROR(QUERY(Stok!A2:P,"' + q + '",0),"Belum ada catatan stok")');

  sh = ss.getSheetByName('Tutup Hari') || ss.insertSheet('Tutup Hari');
  q = "select C, G, H, M, N, I where A is not null and O = 0 and E = 'hitung' order by C desc, G, H " +
    "label C 'Tanggal', G 'Sales', H 'Kode', M 'Seharusnya', N 'Fisik', I 'Selisih'";
  setFormulaIfChanged(sh, '=IFERROR(QUERY(Stok!A2:P,"' + q + '",0),"Belum ada hitung stok")');
}
