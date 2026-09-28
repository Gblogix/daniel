/**
 * Parties read from documents, so a customer / vendor that is not on Parties yet can be added in one click:
 * B/L & C/I blocks (SHIPPER / CONSIGNEE / NOTIFY / BILL TO / SOLD TO) and an invoice letterhead (the vendor).
 * findParty() matches a name against Parties ignoring punctuation and legal suffixes ("UNLOCKT BRANDS INC." = "UNLOCKT BRANDS, INC").
 */
const store = require('../db');

const LEGAL = /\b(CO|COMPANY|CORP|CORPORATION|INC|INCORPORATED|LLC|L\.L\.C|LTD|LIMITED|LLP|LP|PLC|GMBH|SA|PTE|PVT|CO\.,?\s*LTD)\b\.?/g;
const norm = (v) => String(v || '').toUpperCase().replace(/\(.*?\)/g, ' ').replace(/[^A-Z0-9가-힣]+/g, ' ').replace(LEGAL, ' ').replace(/\s+/g, ' ').trim();

// Next section on a B/L / invoice — ends a party block.
const STOP = /^(SHIPPER|EXPORTER|SELLER|CONSIGNEE|BUYER|IMPORTER|NOTIFY|ALSO\s+NOTIFY|BILL\s*TO|SOLD\s*TO|SHIP\s*TO|DELIVERY\s+AGENT|FORWARDING|B\/?L\s*NO|BOOKING|MASTER|HOUSE|OCEAN\s+VESSEL|VESSEL|PORT\s+OF|PLACE\s+OF|PRE-?CARRIAGE|ETD|ETA|CONTAINER|MARKS|INVOICE|DATE|PO\s*NO|DESCRIPTION|TERMS|PAYMENT|REMIT|CUSTOMER|ACCOUNT|REF|MAWB|HAWB|AWB|AIRLINE|FLIGHT|ORIGIN|DESTINATION|#END)/i;
const ADDRESSY = /\d|\b(ST|STREET|AVE|AVENUE|BLVD|RD|ROAD|RO|GIL|DONG|GU|SI|DRIVE|DR|WAY|SUITE|STE|UNIT|FLOOR|FL|BLDG|BUILDING|PO\s*BOX|CA|NY|NJ|TX|GA|WA|IL|KOREA|CHINA|USA|U\.S\.A|VIETNAM|SEOUL|BUSAN|SHANGHAI|SHENZHEN|NINGBO|ZHEJIANG)\b/i;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const PHONE = /(?:TEL|PHONE|PH|T)\s*[.:#]?\s*(\+?[\d(][\d\s().-]{7,}\d)/i;

const ROLES = [
  ['shipper', /^(?:\d{1,2}\.\s*)?(?:SHIPPER|EXPORTER|SELLER)(?:\s*\/\s*EXPORTER)?\b/i],
  ['consignee', /^(?:\d{1,2}\.\s*)?(?:CONSIGNEE|BUYER|IMPORTER)\b/i],
  ['notify', /^(?:\d{1,2}\.\s*)?NOTIFY(?:\s+PARTY)?\b/i],
  ['bill_to', /^(?:BILL(?:ED)?\s*TO|SOLD\s*TO|INVOICE\s*TO|CUSTOMER)\b/i],
];
// The form's own small print under a box title ("(As principal, where 'care of'…)", "(see clause 22)", "(KSCT) …").
const SMALL_PRINT = /^\(|^AS\s+PRINCIPAL|\b(NEGOTIABLE|CLAUSE|CARE\s+OF|OF\s+BEARER|THIS\s+CONTRACT)\b/i;
const SUGGEST = { shipper: 'shipper', consignee: 'customer', notify: 'customer', bill_to: 'customer', letterhead: 'vendor' };

function country(address) {
  const U = String(address || '').toUpperCase();
  if (/KOREA|SEOUL|BUSAN|INCHEON/.test(U)) return 'KR';
  if (/CHINA|SHANGHAI|SHENZHEN|NINGBO|ZHEJIANG|GUANGZHOU|QINGDAO|XIAMEN/.test(U)) return 'CN';
  if (/VIETNAM|HO CHI MINH|HAIPHONG|HANOI/.test(U)) return 'VN';
  if (/\b[A-Z]{2}\s+\d{5}(-\d{4})?\b|USA|U\.S\.A|UNITED STATES/.test(U)) return 'US';
  return null;
}

/** One labelled block: the name on the label line or the next line, then up to 4 address lines. */
function block(lines, i, labelRe) {
  const left = (l) => String(l || '').split(/\s{2,}/)[0].trim();
  const rest = left(lines[i]).replace(labelRe, '').replace(/^[\s:/]*(?:\(?\s*(?:NAME\s*(?:&|AND)\s*ADDRESS|IMPORTER\s+OF\s+RECORD)\s*\)?)?[\s:)]*/i, '')
    .replace(/^(?:NAME\s*(?:&|AND)\s*ADDRESS|\(\s*IMPORTER\s+OF\s+RECORD\s*\))[\s:)]*/i, '').trim();
  let j = i + 1;
  let name = rest.length > 2 && !/^(ADDRESS|NAME)/i.test(rest) && !SMALL_PRINT.test(rest) ? rest : null;
  while (!name && j < lines.length && j <= i + 4) {
    const v = left(lines[j]); j++;
    if (v && !SMALL_PRINT.test(v)) name = v;
  }
  if (!name || STOP.test(name) || /^SAME\s+AS|^TO\s+(THE\s+)?ORDER/i.test(name)) return null;
  const addr = [];
  const onLabelLine = Boolean(rest.length > 2);
  // When the name sits on the label line ("BUYER: X"), the next lines belong to other fields — no address.
  while (!onLabelLine && j < lines.length && addr.length < 5 && lines[j] && !STOP.test(left(lines[j])) && !/^\d{1,2}\.\s*[A-Z]/i.test(left(lines[j]))) {
    const v = left(lines[j]); j++;
    if (v && !SMALL_PRINT.test(v)) addr.push(v);
  }
  const text = addr.join('\n');
  return {
    name: name.replace(/\s{2,}.*$/, '').trim(),
    address: addr.filter((l) => !EMAIL.test(l) && !/^(TEL|PHONE|FAX|ATTN)/i.test(l)).join('\n') || null,
    email: (EMAIL.exec(text) || [])[0]?.toLowerCase() || null,
    phone: (PHONE.exec(text) || [])[1]?.trim() || null,
  };
}

/** The issuer of an invoice: the first company-looking line at the top that is not us and not a title. */
function letterhead(lines, ownName, ownDomains = []) {
  const own = norm(ownName);
  const top = lines.slice(0, 14);
  for (let i = 0; i < top.length; i++) {
    const l = top[i];
    if (!/[A-Za-z]{3}/.test(l) || l.length > 70) continue;
    if (/\b(INVOICE|STATEMENT|RECEIPT|PAGE|DATE|NO\.|NUMBER|ORIGINAL|COPY|TAX|BILL\s*TO|SOLD\s*TO|SHIP\s*TO|REMIT|TOTAL|AMOUNT|DUE|TERMS|LADING|WAYBILL|NOTICE|PACKING|DELIVERY\s+ORDER)\b/i.test(l)) continue;
    if (STOP.test(l) || ROLES.some(([, re]) => re.test(l)) || /:/.test(l)) continue;
    if (EMAIL.test(l) || PHONE.test(l) || /^www\./i.test(l) || ADDRESSY.test(l) && /\d/.test(l)) continue;
    if (own && (norm(l).includes(own) || own.includes(norm(l)))) continue;
    const addr = [];
    for (let j = i + 1; j < Math.min(lines.length, i + 5); j++) {
      if (!ADDRESSY.test(lines[j]) || STOP.test(lines[j]) || /INVOICE|STATEMENT/i.test(lines[j])) break;
      if (!EMAIL.test(lines[j]) && !/^(TEL|PHONE|FAX)/i.test(lines[j])) addr.push(lines[j]);
    }
    const head = top.join('\n');
    const email = [...head.matchAll(new RegExp(EMAIL.source, 'gi'))].map((m) => m[0].toLowerCase())
      .find((e) => !ownDomains.includes(e.split('@')[1])) || null;
    return { name: l.trim(), address: addr.join('\n') || null, email, phone: (PHONE.exec(head) || [])[1]?.trim() || null };
  }
  return null;
}

/** Every party the document names, with the Parties row it already matches (if any). */
function readParties(text, { ownName = '', ownDomains = [], db = store.db, withLetterhead = true } = {}) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  // Side-by-side boxes ("SHIPPER  CONSIGNEE  NOTIFY PARTY" over "A CO  B LLC  C LLC"): unfold into one block per column.
  for (let i = 0; i < lines.length - 1; i++) {
    const heads = lines[i].split(/\s{2,}/);
    if (heads.length < 2 || !heads.every((h) => ROLES.some(([, re]) => re.test(h)))) continue;
    const cols = lines[i + 1].split(/\s{2,}/);
    if (cols.length !== heads.length) continue;
    lines.splice(i, 2, ...heads.flatMap((h, k) => [h, cols[k], '#END']));
    break;
  }
  const out = [];
  const add = (role, p) => {
    if (!p?.name || norm(p.name).length < 3) return;
    if (ownName && norm(p.name) === norm(ownName)) return;
    if (out.some((x) => norm(x.name) === norm(p.name))) return;
    out.push({ role, ...p, country: country(p.address), suggest: SUGGEST[role], match: db ? findParty(p.name, { db }) : null });
  };
  // The issuer's letterhead sits above the first SHIPPER / BILL TO box.
  const firstBox = lines.findIndex((l) => ROLES.some(([, re]) => re.test(l)));
  if (withLetterhead && !/BILL\s+OF\s+LADING|WAYBILL/i.test(text)) add('letterhead', letterhead(firstBox >= 0 ? lines.slice(0, firstBox) : lines, ownName, ownDomains));
  for (const [role, re] of ROLES) {
    const i = lines.findIndex((l) => re.test(l));
    if (i >= 0) add(role, block(lines, i, re));
  }
  return out;
}

/** Our own name and email domains (never offered as a new party). */
function own() {
  const co = require('../company').get();
  const domains = [co.email, co.accounting_email].map((e) => String(e || '').split('@')[1]).filter(Boolean).map((d) => d.toLowerCase());
  return { ownName: co.name || '', ownDomains: [...new Set(domains)] };
}

/** Existing party with the same name (punctuation / legal suffix ignored), or whose short name is the whole name. */
function findParty(name, { db = store.db, types = null } = {}) {
  const n = norm(name);
  if (n.length < 3) return null;
  const rows = db.all(`SELECT id, name, short_name, type FROM companies${types ? ` WHERE type IN (${types.map(() => '?').join(',')})` : ''}`, ...(types || []));
  return rows.find((c) => norm(c.name) === n) || rows.find((c) => c.short_name && norm(c.short_name) === n)
    || rows.find((c) => norm(c.name).length >= 6 && (n.startsWith(`${norm(c.name)} `) || norm(c.name).startsWith(`${n} `))) || null;
}

/** Add a party read from a document (or return the one that already exists). */
function createParty({ name, type = 'customer', address = null, email = null, phone = null, country: ctry = null }, { db = store.db } = {}) {
  const clean = String(name || '').trim().replace(/\s+/g, ' ');
  if (!clean) return null;
  const hit = findParty(clean, { db });
  if (hit) return hit.id;
  const billing = ['customer', 'agent'].includes(type) ? email : null;
  return Number(db.run('INSERT INTO companies (name, type, address, emails, billing_emails, phone, country) VALUES (?, ?, ?, ?, ?, ?, ?)',
    clean, type, address || null, email || null, billing || null, phone || null, ctry || country(address) || null).lastInsertRowid);
}

/**
 * A form picked "＋ New … from documents" (field = 'new'): add the party from the new_party_* inputs and put its id
 * in the field. Returns the added party's name, or null.
 */
function fromForm(body, field, { db = store.db, type = null } = {}) {
  if (body[field] !== 'new') return null;
  const name = String(body.new_party_name || '').trim();
  if (!name) { body[field] = ''; return null; }
  const existed = findParty(name, { db });
  body[field] = String(createParty({ name, type: type || body.new_party_type || 'customer', address: body.new_party_address, email: body.new_party_email, phone: body.new_party_phone }, { db }));
  return existed ? null : name;
}

module.exports = { fromForm, own, readParties, findParty, createParty, letterhead, norm, country };
