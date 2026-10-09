/**
 * Import the party lists kept in OPUS (vendors, forwarders, customers… exported to Excel / CSV).
 * Columns are recognised by their headings; the user checks the mapping and the role per sheet before importing.
 * A party already in the system (same code, else same name) is completed — empty fields filled, roles added —
 * never overwritten.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const store = require('./db');
const config = require('./config');
const PT = require('./partyTypes');

const FIELDS = {
  name: 'Name', code: 'Code (OPUS)', address: 'Address (joined)', country: 'Country', phone: 'Phone', fax: 'Fax',
  emails: 'Email', contact: 'Contact person', tax_id: 'Tax ID / EIN / IRS no.', terms_days: 'Payment terms (days)', type: 'Type / role (text)',
};
const ROLE_FLAG = (r) => `flag:${r}`;

// Heading → field. First match wins; checked in this order.
const HEAD_RULES = [
  [/^(company|customer|vendor|party|account|business|forwarder|agent|carrier|trucker)?\s*(full\s*)?name$|^company$|^name\s*\(?eng|^english name|^거래처명|^상호/i, 'name'],
  [/e-?mail/i, 'emails'],
  [/fax/i, 'fax'],
  [/phone|tel\b|telephone|mobile|cell/i, 'phone'],
  [/contact|attn|person|담당/i, 'contact'],
  [/tax|ein\b|irs|fein|business\s*reg|사업자/i, 'tax_id'],
  [/terms?\b|credit\s*days|due\s*days/i, 'terms_days'],
  [/country|nation|국가/i, 'country'],
  [/addr|street|city|state|province|zip|postal|주소/i, 'address'],
  [/code|^id$|cust(omer)?\s*no|vendor\s*no|account\s*no|^no\.?$/i, 'code'],
  [/type|category|class|kind|role|구분/i, 'type'],
  [/name/i, 'name'],
];

// Words in a type cell (or a heading with Y/N values) → our roles.
const ROLE_WORDS = [
  [/forward|co-?load|nvocc|nvo\b|freight\s*agent/i, 'forwarder'],
  [/oversea|agent|partner/i, 'agent'],
  [/broker|customs/i, 'broker'],
  [/truck|drayage|cartage|haul/i, 'trucker'],
  [/warehouse|3pl|deliver|distribution|\bdc\b/i, 'delivery'],
  [/shipper|factory|supplier|manufactur|seller/i, 'shipper'],
  [/importer|ior\b/i, 'importer'],
  [/customer|consignee|cnee|bill\s*to|client|notify/i, 'customer'],
  [/vendor|carrier|steam|line|airline|terminal|cfs|chassis|payee|service/i, 'vendor'],
];

function rolesIn(text) {
  const s = String(text || '');
  const out = [];
  for (const [re, r] of ROLE_WORDS) if (re.test(s) && !out.includes(r)) out.push(r);
  return out;
}

const COUNTRY = { 'UNITED STATES': 'US', USA: 'US', 'U.S.A.': 'US', AMERICA: 'US', KOREA: 'KR', 'SOUTH KOREA': 'KR', 'REPUBLIC OF KOREA': 'KR', CHINA: 'CN', "PEOPLE'S REPUBLIC OF CHINA": 'CN', JAPAN: 'JP', VIETNAM: 'VN', 'VIET NAM': 'VN', TAIWAN: 'TW', 'HONG KONG': 'HK', THAILAND: 'TH', INDIA: 'IN', INDONESIA: 'ID', MALAYSIA: 'MY', PHILIPPINES: 'PH', SINGAPORE: 'SG', CANADA: 'CA', MEXICO: 'MX', GERMANY: 'DE', ITALY: 'IT', FRANCE: 'FR', 'UNITED KINGDOM': 'GB', UK: 'GB', TURKEY: 'TR', BANGLADESH: 'BD', CAMBODIA: 'KH' };
const country = (v) => { const s = String(v || '').trim(); const u = s.toUpperCase(); return COUNTRY[u] || (/^[A-Z]{2}$/.test(u) ? u : s); };

const cellText = (v) => {
  if (v == null) return '';
  if (typeof v === 'object') {
    if (v.richText) return v.richText.map((x) => x.text).join('');
    if (v.text != null) return String(v.text);
    if (v.result != null) return String(v.result);
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    if (v.hyperlink) return String(v.hyperlink).replace(/^mailto:/i, '');
  }
  return String(v);
};

function parseCsv(text) {
  const rows = []; let row = []; let cur = ''; let q = false;
  const sep = (text.split('\n')[0].match(/\t/g) || []).length > (text.split('\n')[0].match(/,/g) || []).length ? '\t' : ',';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; continue; }
    if (ch === '"') q = true;
    else if (ch === sep) { row.push(cur); cur = ''; } else if (ch === '\n') { row.push(cur.replace(/\r$/, '')); rows.push(row); row = []; cur = ''; } else cur += ch;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

/** Pick the heading row: the first of the top rows with a name-like heading and at least two filled cells. */
function splitHeader(grid) {
  const top = grid.slice(0, 15);
  let h = top.findIndex((r) => r.filter((c) => String(c).trim()).length >= 2 && r.some((c) => HEAD_RULES[0][0].test(String(c).trim())));
  if (h < 0) h = top.findIndex((r) => r.filter((c) => String(c).trim()).length >= 2);
  if (h < 0) return { headers: [], rows: [] };
  const width = Math.max(...grid.map((r) => r.length));
  const headers = Array.from({ length: width }, (_, i) => String(grid[h][i] ?? '').trim() || `Column ${i + 1}`);
  const rows = grid.slice(h + 1).map((r) => headers.map((_, i) => String(r[i] ?? '').trim())).filter((r) => r.some(Boolean));
  return { headers, rows };
}

/** Read an .xlsx / .csv file into sheets of { name, headers, rows }. */
async function parse(buffer, filename) {
  const ext = path.extname(filename || '').toLowerCase();
  if (ext === '.xls') throw Object.assign(new Error('This is an old .xls file. Open it in Excel and "Save As" Excel Workbook (.xlsx), then upload that.'), { status: 400, expose: true });
  if (ext === '.csv' || ext === '.txt') {
    const { headers, rows } = splitHeader(parseCsv(buffer.toString('utf8').replace(/^﻿/, '')));
    return [{ name: path.basename(filename, ext), headers, rows }];
  }
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const out = [];
  wb.eachSheet((ws) => {
    const grid = [];
    ws.eachRow({ includeEmpty: true }, (row, n) => { const vals = row.values.slice(1).map(cellText); grid[n - 1] = vals; });
    const { headers, rows } = splitHeader(grid.map((r) => r || []));
    if (rows.length) out.push({ name: ws.name, headers, rows });
  });
  return out;
}

/** Suggested mapping for each column: a field key, a role flag, or '' (ignore). */
function guessMapping(sheet) {
  const used = new Set();
  return sheet.headers.map((h, i) => {
    const vals = sheet.rows.slice(0, 50).map((r) => r[i]).filter(Boolean);
    const yesNo = vals.length && vals.every((v) => /^(y|n|yes|no|true|false|x|1|0|o|v|✓|✔)$/i.test(v));
    if (yesNo) { const r = rolesIn(h)[0]; return r ? ROLE_FLAG(r) : ''; }
    for (const [re, f] of HEAD_RULES) {
      if (!re.test(h)) continue;
      if (f !== 'address' && f !== 'emails' && f !== 'phone' && used.has(f)) continue;
      used.add(f);
      return f;
    }
    return '';
  });
}

/** Role suggested for a whole sheet from the sheet or file name ("Vendor List", "Forwarders"…). */
const sheetRole = (sheetName, filename = '') => rolesIn(sheetName)[0] || rolesIn(filename)[0] || '';

/** Rows → party records with the chosen mapping. */
function records(sheet, mapping, defaultRole) {
  const out = [];
  for (const r of sheet.rows) {
    const rec = { address: [], emails: [], phone: [], roles: [] };
    mapping.forEach((m, i) => {
      const v = String(r[i] || '').trim();
      if (!m || !v) return;
      if (m.startsWith('flag:')) { if (/^(y|yes|true|x|1|o|v|✓|✔)$/i.test(v)) rec.roles.push(m.slice(5)); return; }
      if (m === 'address' || m === 'emails' || m === 'phone') rec[m].push(v);
      else if (m === 'type') rec.roles.push(...rolesIn(v));
      else if (!rec[m]) rec[m] = v;
    });
    rec.name = String(rec.name || '').replace(/\s+/g, ' ').trim();
    if (!rec.name) continue;
    if (PT.LABELS[defaultRole]) rec.roles.unshift(defaultRole); // the sheet's role, plus any from Type / Y-N columns
    rec.roles = [...new Set(rec.roles)];
    rec.address = require('./address').tidy(rec.address.join(', ').replace(/,\s*,/g, ','), rec.name);
    rec.emails = [...new Set(rec.emails.join(',').split(/[,;\s]+/).filter((e) => /@/.test(e)).map((e) => e.toLowerCase()))].join(', ');
    rec.phone = rec.phone.join(' / ');
    rec.country = rec.country ? country(rec.country) : '';
    rec.terms_days = /^\d{1,3}$/.test(String(rec.terms_days || '').replace(/\D+$/, '').replace(/^net\s*/i, '')) ? Number(String(rec.terms_days).replace(/\D/g, '')) : null;
    out.push(rec);
  }
  return out;
}

/** Look-up of the parties already in the system, by code and by normalised name. */
function index(db) {
  const norm = require('./extract/party').norm;
  const code = new Map(); const name = new Map();
  for (const c of db.all('SELECT id, name, code FROM companies')) {
    if (c.code) code.set(String(c.code).toUpperCase(), c);
    const n = norm(c.name); if (n && !name.has(n)) name.set(n, c);
  }
  return (rec) => (rec.code && code.get(String(rec.code).toUpperCase())) || name.get(norm(rec.name)) || null;
}

/** What an import would do, without writing. */
function plan(recs, { db = store.db } = {}) {
  const norm = require('./extract/party').norm;
  const findExisting = index(db);
  const byCode = new Map(); const byName = new Map();
  const out = [];
  for (const rec of recs) {
    const code = String(rec.code || '').toUpperCase(); const name = norm(rec.name);
    const first = (code && byCode.get(code)) || byName.get(name);
    if (first) {
      // Same party twice in the file (e.g. on the vendor and the forwarder sheet): one party with both roles.
      first.roles = [...new Set([...first.roles, ...rec.roles])];
      for (const k of ['address', 'country', 'phone', 'fax', 'emails', 'contact', 'tax_id', 'terms_days', 'code']) if (!first[k] && rec[k]) first[k] = rec[k];
      if (first.action === 'no-role' && first.roles.length) first.action = first.existing ? 'update' : 'new';
      out.push({ ...rec, action: 'duplicate' });
      continue;
    }
    const ex = findExisting(rec);
    const row = { ...rec, roles: [...rec.roles], existing: ex ? { id: ex.id, name: ex.name } : null };
    row.action = !row.roles.length ? 'no-role' : ex ? 'update' : 'new';
    if (code) byCode.set(code, row);
    if (name) byName.set(name, row);
    out.push(row);
  }
  return out;
}

const FILL = ['code', 'address', 'country', 'phone', 'fax', 'emails', 'contact', 'tax_id', 'terms_days'];

/** Write the records: new parties added, existing ones completed. Returns counts. */
function apply(recs, { db = store.db } = {}) {
  const res = { added: 0, updated: 0, unchanged: 0, skipped: 0 };
  db.tx(() => {
    for (const rec of plan(recs, { db })) {
      if (rec.action === 'duplicate') continue;
      if (rec.action === 'no-role') { res.skipped++; continue; }
      const ex = rec.existing ? db.get('SELECT * FROM companies WHERE id = ?', rec.existing.id) : null;
      if (!ex) {
        const order = Object.keys(PT.LABELS);
        const roles = rec.roles.slice().sort((a, b) => order.indexOf(a) - order.indexOf(b));
        db.run(`INSERT INTO companies (name, type, types, ${FILL.join(', ')}) VALUES (?, ?, ?, ${FILL.map(() => '?').join(', ')})`,
          rec.name, roles[0], roles.join(','), ...FILL.map((k) => (rec[k] === '' || rec[k] == null ? null : rec[k])));
        res.added++;
        continue;
      }
      const sets = []; const vals = [];
      for (const k of FILL) if ((ex[k] == null || ex[k] === '') && rec[k] !== '' && rec[k] != null) { sets.push(`${k} = ?`); vals.push(rec[k]); }
      const have = PT.of(ex);
      const more = rec.roles.filter((r) => !have.includes(r));
      if (more.length) { sets.push('types = ?'); vals.push([...have, ...more].join(',')); }
      if (sets.length) { db.run(`UPDATE companies SET ${sets.join(', ')} WHERE id = ?`, ...vals, ex.id); res.updated++; } else res.unchanged++;
    }
  });
  return res;
}

// ---------- the uploaded file between the preview and the import ----------
const dir = () => path.join(config.uploadDir, 'imports');
function save(data) {
  fs.mkdirSync(dir(), { recursive: true });
  for (const f of fs.readdirSync(dir())) { const p = path.join(dir(), f); if (Date.now() - fs.statSync(p).mtimeMs > 86400000) fs.rmSync(p, { force: true }); }
  const token = crypto.randomBytes(12).toString('hex');
  fs.writeFileSync(path.join(dir(), `${token}.json`), JSON.stringify(data));
  return token;
}
function load(token) {
  if (!/^[a-f0-9]{24}$/.test(String(token))) return null;
  try { return JSON.parse(fs.readFileSync(path.join(dir(), `${token}.json`), 'utf8')); } catch { return null; }
}
function drop(token) { if (/^[a-f0-9]{24}$/.test(String(token))) fs.rmSync(path.join(dir(), `${token}.json`), { force: true }); }

module.exports = { FIELDS, parse, guessMapping, sheetRole, records, plan, apply, rolesIn, save, load, drop };
