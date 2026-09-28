/**
 * Rule-based field extraction from shipping document text (B/L, packing list, commercial invoice, ISF,
 * air waybill). Works offline; the AI extractor (ai.js) is used on top of it when an API key is configured.
 */

const MONTHS = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };

function detectDocType(text, filename = '') {
  const f = filename.toUpperCase();
  const byName = [
    [/(^|[^A-Z])(HBL|HOUSE)/, 'HBL'], [/(^|[^A-Z])(MBL|MASTER)/, 'MBL'], [/(^|[^A-Z])(PL|P-L|PACKING)/, 'PL'],
    [/(^|[^A-Z])(CI|C-I|INVOICE|INV)([^A-Z]|$)/, 'CI'], [/(^|[^A-Z])ISF/, 'ISF'], [/(^|[^A-Z])(AWB|MAWB|HAWB)/, 'AWB'],
  ];
  for (const [re, t] of byName) if (re.test(f)) return t;
  // Pick the document title that appears first on the page (a C/I may mention the B/L number further down).
  const t = text.toUpperCase();
  const TITLES = [
    [/IMPORTER\s+SECURITY\s+FILING|\bISF\s*(10|5|\+2)\b|\bISF\s+INFORMATION/, 'ISF'],
    [/PACKING\s+LIST|\bP\/L\b/, 'PL'],
    [/COMMERCIAL\s+INVOICE/, 'CI'],
    [/NOTICE\s+OF\s+ARRIVAL|ARRIVAL\s+NOTICE|YOUR\s+SHIPMENT\s+HAS\s+ARRIVED/, 'NOA'],
    [/DELIVERY\s+ORDER/, 'DO'],
    [/AIR\s*WAYBILL|\bMAWB\b|\bHAWB\b/, 'AWB'],
    [/HOUSE\s+BILL|\bHBL\b|\bH\.?\s?B\/L\b/, 'HBL'],
    [/SEA\s*WAYBILL|BILL\s+OF\s+LADING|\bB\/L\b/, 'MBL'],
  ];
  let best = null;
  for (const [re, type] of TITLES) {
    const m = re.exec(t);
    if (m && (!best || m.index < best.index)) best = { index: m.index, type };
  }
  if (best) {
    // "BILL OF LADING (HOUSE)" style titles
    if (best.type === 'MBL' && /HOUSE/.test(t.slice(best.index, best.index + 40))) return 'HBL';
    return best.type;
  }
  return 'OTHER';
}

/** ISO 6346 container number check digit. */
function containerCheckDigit(prefix10) {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  // Letter values skip multiples of 11 (A=10, B=12 ... K=21, L=23 ...).
  const vals = {};
  let v = 10;
  for (const ch of letters) { if (v % 11 === 0) v++; vals[ch] = v++; }
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    const ch = prefix10[i];
    const n = /\d/.test(ch) ? Number(ch) : vals[ch];
    sum += n * 2 ** i;
  }
  return (sum % 11) % 10;
}
function isValidContainer(no) {
  return /^[A-Z]{3}[UJZ]\d{7}$/.test(no) && containerCheckDigit(no.slice(0, 10)) === Number(no[10]);
}

const TO_DIGIT = { O: '0', Q: '0', D: '0', I: '1', L: '1', T: '7', S: '5', B: '8', Z: '2', G: '6' };
const TO_LETTER = { 0: 'O', 1: 'I', 5: 'S', 8: 'B', 2: 'Z', 6: 'G' };
const toDigits = (s) => s.replace(/[A-Z]/g, (c) => TO_DIGIT[c] || c);
const toLetters = (s) => s.replace(/\d/g, (c) => TO_LETTER[c] || c);
/** Try single-character OCR substitutions on the serial; return the unique valid variant, if any. */
function repairContainer(no) {
  const SWAP = { 0: '86', 1: '7', 2: '7', 3: '8', 5: '6', 6: '58', 7: '12', 8: '036', 9: '4' };
  const found = new Set();
  for (let i = 4; i < 11; i++) {
    for (const d of SWAP[no[i]] || '') {
      const cand = no.slice(0, i) + d + no.slice(i + 1);
      if (isValidContainer(cand)) found.add(cand);
    }
  }
  return found.size === 1 ? [...found][0] : null;
}

function toISODate(s) {
  if (!s) return null;
  s = s.trim().toUpperCase().replace(/(\d)(ST|ND|RD|TH)\b/, '$1');
  let m;
  if ((m = /^(\d{4})[-./](\d{1,2})[-./](\d{1,2})/.exec(s))) return fmt(+m[1], +m[2], +m[3]);
  if ((m = /^(\d{1,2})[-\s./]?([A-Z]{3})[A-Z]*[-\s.,/]*(\d{2,4})/.exec(s)) && MONTHS[m[2]]) return fmt(year(m[3]), MONTHS[m[2]], +m[1]);
  if ((m = /^([A-Z]{3})[A-Z]*[-\s.]*(\d{1,2}),?[-\s.,/]*(\d{2,4})/.exec(s)) && MONTHS[m[1]]) return fmt(year(m[3]), MONTHS[m[1]], +m[2]);
  // US style MM/DD/YYYY (freight documents into the US are mostly US formatted)
  if ((m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/.exec(s))) return fmt(year(m[3]), +m[1], +m[2]);
  return null;
}
const year = (y) => (y.length === 2 ? 2000 + Number(y) : Number(y));
function fmt(y, mo, d) {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
const DATE_RE = String.raw`(\d{4}[-./]\d{1,2}[-./]\d{1,2}|\d{1,2}[-\s./]?[A-Za-z]{3}[A-Za-z]*[-\s.,/]*\d{2,4}|[A-Za-z]{3}[A-Za-z]*[-\s.]*\d{1,2},?[-\s.,/]*\d{2,4}|\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4})`;

const num = (s) => (s == null ? null : Number(String(s).replace(/,/g, '')));

function firstMatch(text, patterns) {
  for (const re of patterns) {
    const m = re.exec(text);
    if (m) return m[1].trim();
  }
  return null;
}

/** Value that follows a label on the same line, or on the next non-empty line. */
function labelValue(lines, labelRe) {
  for (let i = 0; i < lines.length; i++) {
    const m = labelRe.exec(lines[i]);
    if (!m) continue;
    const rest = lines[i].slice(m.index + m[0].length).replace(/^[\s:.#-]+/, '').trim();
    if (rest && rest.length > 1) return rest;
    for (let j = i + 1; j < Math.min(lines.length, i + 3); j++) if (lines[j].trim()) return lines[j].trim();
  }
  return null;
}

const REF = String.raw`([A-Z0-9][A-Z0-9-]{5,24})`;
const SEP = String.raw`\s*(?:NO\.?|NUMBER|#)?\s*[:.]?\s*`;

function extractRules(text, { filename = '', rows = null } = {}) {
  const docType = detectDocType(text, filename);
  const T = text.replace(/ /g, ' ');
  const U = T.toUpperCase();
  const lines = T.split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const out = { doc_type: docType, containers: [], items: [], warnings: [] };

  out.mbl_no = firstMatch(U, [new RegExp(String.raw`(?:MASTER\s*B\/?L|M\.?\s?B\/?L|OCEAN\s*B\/?L)${SEP}${REF}`)]);
  out.hbl_no = firstMatch(U, [new RegExp(String.raw`(?:HOUSE\s*B\/?L|H\.?\s?B\/?L)${SEP}${REF}`)]);
  const genericBl = firstMatch(U, [new RegExp(String.raw`(?:B\/L|BILL\s+OF\s+LADING)${SEP}${REF}`)]);
  if (genericBl) {
    if (docType === 'HBL' && !out.hbl_no) out.hbl_no = genericBl;
    else if (!out.mbl_no && docType !== 'HBL') out.mbl_no = genericBl;
  }
  // National Shipping (국민해운) issues both house numbers: ESSASEL######## (house B/L on our documents) and
  // NSCLGB… / NSCXA… (their own house B/L, shown as SUB B/L and used as the agent filing no.).
  const essa = firstMatch(U, [/\b(ESSA[A-Z]{2,4}\d{8})\b/]);
  const nsc = firstMatch(U, [/\b(NSC[A-Z]{2,5}\d{6,9})\b/]);
  out.sub_bl_no = firstMatch(U, [/SUB\s*B\/?L\s*(?:NO\.?|#)?\s*[:.]?\s*([A-Z0-9][A-Z0-9-]{5,24})/]);
  if (essa) {
    out.hbl_no = essa;
    if (nsc && nsc !== essa) out.sub_bl_no = out.sub_bl_no || nsc;
  } else if (nsc && (!out.hbl_no || out.hbl_no === out.sub_bl_no)) {
    out.hbl_no = nsc;
  }
  out.agent_ref = [out.sub_bl_no, out.hbl_no].find((v) => v && /^NSC/.test(v)) || null;
  out.mawb_no = firstMatch(U, [/(?:MAWB|MASTER\s+AIR\s*WAYBILL)\s*(?:NO\.?|#)?\s*[:.]?\s*(\d{3}[-\s]?\d{4}\s?\d{4})/]);
  out.hawb_no = firstMatch(U, [/(?:HAWB|HOUSE\s+AIR\s*WAYBILL)\s*(?:NO\.?|#)?\s*[:.]?\s*([A-Z0-9-]{6,20})/]);
  if (!out.mawb_no && docType === 'AWB') out.mawb_no = firstMatch(U, [/\b(\d{3}-\d{4}\s?\d{4})\b/, /\b(\d{3}-\d{8})\b/]);

  // Containers: 4 letters + 7 digits, allowing "ABCU 123456-7" styles; validate check digit.
  // OCR often confuses O/0, I/1, S/5, B/8, Z/2 — a failing number is repaired when exactly one variant validates.
  const seen = new Set();
  const ctnRe = /\b([A-Z0-9]{3}[UJZ])\s?-?([0-9OISBZGTL]{6})\s?-?([0-9OISBZGTL])\b/g;
  let m;
  while ((m = ctnRe.exec(U))) {
    const raw = m[1] + m[2] + m[3];
    if (!/[A-Z]{2}/.test(m[1]) || !/\d{4}/.test(m[2] + m[3])) continue; // not container-like
    let no = toLetters(m[1]) + toDigits(m[2] + m[3]);
    if (!/^[A-Z]{3}[UJZ]\d{7}$/.test(no)) continue;
    let repaired = false;
    if (!isValidContainer(no)) { const fix = repairContainer(no); if (fix) { no = fix; repaired = true; } }
    if (seen.has(no)) continue;
    seen.add(no);
    const ctx = U.slice(m.index, m.index + 160);
    // "ABCU1234567/SEAL123" first, then an explicit SEAL label nearby.
    const seal = /^[A-Z0-9]{4}\s?-?[0-9A-Z]{6}\s?-?[0-9A-Z]\s*\/\s*(?:SEAL\s*(?:NO\.?|#)?\s*[:.]?\s*)?([A-Z0-9-]{5,20})/.exec(ctx)
      || /\bSEAL\s*(?:NO\.?|#|NUMBER)?\s*[:.]?\s*([A-Z0-9-]{5,20})/.exec(ctx);
    const size = /\b(20|40|45)\s*'?\s*(GP|DC|DV|HC|HQ|RF|RH|OT|FR|ST)\b/.exec(ctx);
    const c = { container_no: no, seal_no: seal ? seal[1] : null, size_type: size ? size[1] + normSize(size[2]) : null };
    if (repaired || no !== raw) out.warnings.push(`Container ${raw} read as ${no} (corrected by check digit) — please verify`);
    else if (!isValidContainer(no)) out.warnings.push(`Container ${no}: check digit does not match — please verify`);
    out.containers.push(c);
  }
  if (out.containers.length === 1 && !out.containers[0].seal_no) {
    out.containers[0].seal_no = firstMatch(U, [/SEAL\s*(?:NO\.?|#|NUMBER)?\s*[:.]?\s*([A-Z0-9-]{5,20})/]);
  }
  if (!out.containers.some((c) => c.size_type)) {
    const size = /\b(\d)\s*[X×]\s*(20|40|45)\s*'?\s*(GP|DC|DV|HC|HQ|RF|OT|FR)\b/.exec(U) || /\b()(20|40|45)\s*'?\s*(GP|DC|DV|HC|HQ|RF|OT|FR)\b/.exec(U);
    if (size) for (const c of out.containers) c.size_type = size[2] + normSize(size[3]);
  }

  out.vessel = labelValue(lines, /(?:OCEAN\s+)?VESSEL(?:\s*(?:NAME|\/\s*VOY(?:AGE)?\.?(?:\s*NO\.?)?))?/i);
  if (out.vessel) {
    const vv = /^(.+?)\s+(?:V\.?|VOY\.?|VOYAGE)?\s*([0-9]{2,4}[A-Z]{0,2}|[A-Z]{0,2}[0-9]{2,4}[A-Z]?)$/i.exec(out.vessel);
    if (vv) { out.vessel = vv[1].replace(/[\s/-]+$/, ''); out.voyage = vv[2]; }
  }
  out.voyage = out.voyage || firstMatch(U, [/VOY(?:AGE)?\.?\s*(?:NO\.?)?\s*[:.]?\s*([A-Z0-9]{2,8})\b/]);
  out.flight_no = firstMatch(U, [/FLIGHT\s*(?:NO\.?|#)?\s*[:.]?\s*([A-Z0-9]{2}\s?\d{2,4})/]);
  out.pol = labelValue(lines, /PORT\s+OF\s+LOADING|\bPOL\b|AIRPORT\s+OF\s+DEPARTURE/i);
  out.pod = labelValue(lines, /PORT\s+OF\s+DISCHARGE|\bPOD\b|AIRPORT\s+OF\s+DESTINATION/i);
  out.place_of_delivery = labelValue(lines, /PLACE\s+OF\s+DELIVERY|FINAL\s+DESTINATION/i);

  out.etd = toISODate(firstMatch(T, [new RegExp(String.raw`(?:ETD|ON\s*BOARD\s*DATE|SHIPPED\s+ON\s+BOARD|DEPARTURE\s+DATE|SAILING\s+DATE)\s*[:.]?\s*${DATE_RE}`, 'i')]));
  out.eta = toISODate(firstMatch(T, [new RegExp(String.raw`(?:ETA|ARRIVAL\s+DATE|EST\.?\s+ARRIVAL)\s*[:.]?\s*${DATE_RE}`, 'i')]));

  out.shipper_name = partyName(lines, /^(?:SHIPPER|EXPORTER|SELLER)(?:\s*\/\s*EXPORTER)?\b/i);
  out.consignee_name = partyName(lines, /^(?:CONSIGNEE|BUYER|IMPORTER)\b/i);
  out.notify_party = partyName(lines, /^NOTIFY\s+PARTY\b/i);
  // Addresses under the SHIPPER / CONSIGNEE / NOTIFY boxes (used to add a new customer from the documents).
  for (const p of require('./party').readParties(T, { db: null, withLetterhead: false })) {
    const k = { shipper: 'shipper_address', consignee: 'consignee_address', notify: 'notify_address' }[p.role];
    if (k && p.address) out[k] = p.address;
    if (p.role === 'consignee' && (p.email || p.phone)) out.consignee_contact = { email: p.email, phone: p.phone };
  }

  // Totals. Prefer labelled gross weight, else the largest KGS figure.
  const gw = firstMatch(U, [/(?:GROSS\s*WEIGHT|G\.?\s?W\.?|TOTAL\s+WEIGHT)[^0-9\n]{0,20}([\d,]+(?:\.\d+)?)\s*(?:KGS?|KILOS?)?/]);
  const kgs = [...U.matchAll(/([\d,]+(?:\.\d+)?)\s*(?:KGS?|KILOS?)\b/g)].map((x) => num(x[1]));
  out.weight_kg = gw ? num(gw) : kgs.length ? Math.max(...kgs) : null;
  const cbmLabel = firstMatch(U, [/(?:MEASUREMENT|VOLUME|TOTAL\s+CBM)[^0-9\n]{0,20}([\d,]+(?:\.\d+)?)\s*(?:CBM|M3|M³)?/]);
  const cbms = [...U.matchAll(/([\d,]+(?:\.\d+)?)\s*(?:CBM|M3|M³)\b/g)].map((x) => num(x[1]));
  out.cbm = cbmLabel ? num(cbmLabel) : cbms.length ? Math.max(...cbms) : null;
  const pk = [...U.matchAll(/([\d,]+)\s*(CTNS?|CARTONS?|PKGS?|PACKAGES?|PALLETS?|PLTS?|BOXES|CASES?|ROLLS?)\b/g)]
    .map((x) => ({ n: num(x[1]), unit: normUnit(x[2]) }));
  if (pk.length) { const best = pk.reduce((a, b) => (b.n > a.n ? b : a)); out.packages = best.n; out.package_unit = best.unit; }
  out.chargeable_weight = num(firstMatch(U, [/CHARGEABLE\s+WEIGHT[^0-9\n]{0,20}([\d,]+(?:\.\d+)?)/]));
  out.commodity = labelValue(lines, /DESCRIPTION\s+OF\s+(?:GOODS|PACKAGES\s+AND\s+GOODS)|COMMODITY/i);
  out.firms_code = firstMatch(U, [/FIRMS?\s*(?:CODE)?\s*(?:NO\.?|#)?\s*[:.]?\s*([A-Z][A-Z0-9]\d{2}|[A-Z]\d[A-Z0-9]\d|[A-Z]{2}[A-Z0-9]\d)\b/]);
  out.freight_location = labelValue(lines, /(?:FREIGHT|CARGO)\s+LOCATION|DISCHARGE\s+TERMINAL|\bTERMINAL\s*(?:NAME)?\s*:|CFS\s+LOCATION|AVAILABLE\s+AT/i);
  out.last_free_day = toISODate(firstMatch(T, [new RegExp(String.raw`(?:LAST\s+FREE\s+DAY|\bLFD)\s*[:.-]?\s*${DATE_RE}`, 'i')]));
  // "INVOICE NO: X", or the Korean-style box "9. No & Date of Invoice" with "#BSBUS26091601 / 2026.09.16" under it.
  out.ci_invoice_no = invoiceNoBelow(rows) || firstMatch(U, [/NO\.?\s*(?:&|AND)\s*DATE\s+OF\s+INVOICE[^\n]*\n(?:[^\n]*?#\s*|\s*)([A-Z0-9][A-Z0-9-]{3,24})/,
    /INVOICE\s*(?:NO\.?|#|NUMBER)\s*[:.]?\s*#?\s*([A-Z0-9][A-Z0-9-]{3,20})/]);
  out.isf_no = firstMatch(U, [/ISF\s*(?:NO\.?|#|TRANSACTION\s*(?:NO\.?)?)\s*[:.]?\s*([A-Z0-9-]{6,25})/]);
  out.telex_release = /TELEX\s+RELEASE|SURRENDERED|SEA\s*WAYBILL|EXPRESS\s+RELEASE|电放/.test(U) || null;

  if (rows) {
    const { items, totals } = itemsFromRows(rows);
    out.items = items;
    if (items.length) {
      // Table totals beat free-text matching: use the TOTAL row, else the sum of the lines.
      const sum = (k) => { const v = items.reduce((a, i) => a + (i[k] || 0), 0); return v ? Math.round(v * 1000) / 1000 : null; };
      for (const k of ['packages', 'weight_kg', 'cbm']) out[k] = totals?.[k] ?? sum(k) ?? out[k];
      if (totals) {
        for (const k of ['packages', 'weight_kg', 'cbm']) {
          const s = sum(k);
          if (totals[k] != null && s != null && Math.abs(s - totals[k]) > 0.01 * Math.max(1, totals[k])) {
            out.warnings.push(`${k}: lines add up to ${s} but TOTAL row says ${totals[k]}`);
          }
        }
      }
      out.cargo_value = totals?.amount ?? sum('amount');
    }
  }
  if (out.containers.length === 1) {
    Object.assign(out.containers[0], { packages: out.packages ?? null, weight_kg: out.weight_kg ?? null, cbm: out.cbm ?? null });
  }
  for (const k of Object.keys(out)) if (out[k] === undefined) out[k] = null;
  return out;
}

/** Spreadsheet C/I: the value under a "No & Date of Invoice" / "Invoice No." cell, same column. */
function invoiceNoBelow(rows) {
  if (!rows) return null;
  for (let r = 0; r < rows.length; r += 1) {
    const c = rows[r].findIndex((v) => /NO\.?\s*(?:&|AND)\s*DATE\s+OF\s+INVOICE|^\s*INVOICE\s*(?:NO\.?|#|NUMBER)\s*[:.]?\s*$/i.test(String(v)));
    if (c < 0) continue;
    for (let k = r + 1; k <= r + 3 && k < rows.length; k += 1) {
      const m = /^\s*#?\s*([A-Z0-9][A-Z0-9-]{3,24})\b/i.exec(String(rows[k][c] || ''));
      if (m && /\d/.test(m[1])) return m[1].toUpperCase();
    }
  }
  return null;
}

function normSize(s) { return { HQ: 'HC', DV: 'GP', DC: 'GP', ST: 'GP', RH: 'RF' }[s] || s; }
function normUnit(u) {
  if (/^CT|^CART/.test(u)) return 'CTNS';
  if (/^PL|^PALLET/.test(u)) return 'PLTS';
  if (/^PK|^PACK/.test(u)) return 'PKGS';
  return u;
}

function partyName(lines, labelRe) {
  for (let i = 0; i < lines.length; i++) {
    if (!labelRe.test(lines[i])) continue;
    const rest = lines[i].replace(labelRe, '').replace(/^[\s:()/A-Za-z]*?(?:NAME\s*(?:&|AND)\s*ADDRESS)?[\s:)]*/i, '').trim();
    if (rest.length > 2 && !/^(ADDRESS|NAME)/i.test(rest)) return rest;
    if (lines[i + 1]) return lines[i + 1];
  }
  return null;
}

/** Packing-list line items from a spreadsheet: find the header row, map columns by name. */
function itemsFromRows(rows) {
  const COLS = {
    po_no: /^(P\.?O\.?|PO\s*NO|ORDER)/i,
    description: /DESCRIPTION|ITEM|PRODUCT|GOODS|COMMODITY|품명|품목/i,
    hs_code: /HS\s*CODE|HTS/i,
    unit_price: /UNIT\s*PRICE|PRICE|단가/i,
    amount: /AMOUNT|TOTAL\s*VALUE|VALUE|금액/i,
    quantity: /^(Q'?TY|QUANTITY|PCS|수량)/i,
    unit: /^UNIT$/i,
    packages: /CTNS?|CARTONS?|PKGS?|PACKAGES?|박스/i,
    weight_kg: /^(?!.*\bN\.?\s?W\b)(?!.*NET).*(G\.?\s?W|GROSS|WEIGHT|중량)/i,
    cbm: /CBM|MEAS|VOLUME|M3/i,
  };
  let header = -1; let map = {};
  for (let r = 0; r < Math.min(rows.length, 40); r++) {
    const m = {};
    rows[r].forEach((cell, i) => {
      const s = String(cell).trim();
      for (const [k, re] of Object.entries(COLS)) if (!(k in m) && re.test(s)) { m[k] = i; break; }
    });
    if ('description' in m && Object.keys(m).length >= 2) { header = r; map = m; break; }
  }
  if (header < 0) return { items: [], totals: null };
  const items = [];
  let totals = null;
  for (const row of rows.slice(header + 1)) {
    const cells = row.map((c) => String(c ?? '').trim());
    const pick = (k) => (k in map ? cells[map[k]] || '' : '');
    const n = (k) => { const v = numIn(pick(k)); return v; };
    const desc = pick('description');
    const isTotal = cells.some((c) => /^(TOTAL|SUB\s*-?TOTAL|G(RAND)?\.?\s*TOTAL|합계)\b/i.test(c));
    if (isTotal) {
      totals = { packages: n('packages'), weight_kg: n('weight_kg'), cbm: n('cbm'), quantity: n('quantity'), amount: n('amount') };
      continue;
    }
    if (!desc) continue;
    // "12,000 PCS" in the quantity cell carries the unit
    const qtyUnit = /[\d.,]+\s*([A-Z]{2,6})\b/i.exec(pick('quantity'));
    items.push({
      po_no: pick('po_no') || null, description: desc, hs_code: pick('hs_code') || null,
      quantity: n('quantity'), unit: pick('unit') || (qtyUnit ? qtyUnit[1].toUpperCase() : null),
      packages: n('packages'), weight_kg: n('weight_kg'), cbm: n('cbm'), unit_price: n('unit_price'), amount: n('amount'),
    });
  }
  return { items, totals };
}

/** First number in a cell ("USD 25,200.00" -> 25200, "980 CTNS" -> 980). */
function numIn(s) {
  const m = /-?[\d,]*\.?\d+/.exec(String(s || '').replace(/\s/g, ''));
  if (!m) return null;
  const v = Number(m[0].replace(/,/g, ''));
  return Number.isFinite(v) ? v : null;
}

module.exports = { extractRules, detectDocType, isValidContainer, containerCheckDigit, toISODate, itemsFromRows };
