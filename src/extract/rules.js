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
  const t = text.toUpperCase();
  if (/IMPORTER\s+SECURITY\s+FILING|\bISF\s*(10|5|\+2)/.test(t)) return 'ISF';
  if (/PACKING\s+LIST/.test(t)) return 'PL';
  if (/COMMERCIAL\s+INVOICE/.test(t)) return 'CI';
  if (/AIR\s*WAYBILL|\bAWB\b/.test(t)) return 'AWB';
  if (/HOUSE\s+BILL|\bHBL\b|\bH\.?\s?B\/L\b/.test(t)) return 'HBL';
  if (/BILL\s+OF\s+LADING|\bB\/L\b/.test(t)) return 'MBL';
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
  out.mawb_no = firstMatch(U, [/(?:MAWB|MASTER\s+AIR\s*WAYBILL)\s*(?:NO\.?|#)?\s*[:.]?\s*(\d{3}[-\s]?\d{4}\s?\d{4})/]);
  out.hawb_no = firstMatch(U, [/(?:HAWB|HOUSE\s+AIR\s*WAYBILL)\s*(?:NO\.?|#)?\s*[:.]?\s*([A-Z0-9-]{6,20})/]);
  if (!out.mawb_no && docType === 'AWB') out.mawb_no = firstMatch(U, [/\b(\d{3}-\d{4}\s?\d{4})\b/, /\b(\d{3}-\d{8})\b/]);

  // Containers: 4 letters + 7 digits, allowing "ABCU 123456-7" styles; validate check digit.
  const seen = new Set();
  const ctnRe = /\b([A-Z]{3}[UJZ])\s?-?(\d{6})\s?-?(\d)\b/g;
  let m;
  while ((m = ctnRe.exec(U))) {
    const no = m[1] + m[2] + m[3];
    if (seen.has(no)) continue;
    seen.add(no);
    const ctx = U.slice(m.index, m.index + 160);
    // "ABCU1234567/SEAL123" first, then an explicit SEAL label nearby.
    const seal = /^[A-Z]{4}\s?-?\d{6}\s?-?\d\s*\/\s*(?:SEAL\s*(?:NO\.?|#)?\s*[:.]?\s*)?([A-Z0-9-]{5,20})/.exec(ctx)
      || /\bSEAL\s*(?:NO\.?|#|NUMBER)?\s*[:.]?\s*([A-Z0-9-]{5,20})/.exec(ctx);
    const size = /\b(20|40|45)\s*'?\s*(GP|DC|DV|HC|HQ|RF|RH|OT|FR|ST)\b/.exec(ctx);
    const c = { container_no: no, seal_no: seal ? seal[1] : null, size_type: size ? size[1] + normSize(size[2]) : null };
    if (!isValidContainer(no)) out.warnings.push(`Container ${no}: check digit does not match — please verify`);
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

  if (rows) {
    out.items = itemsFromRows(rows);
    // Spreadsheet totals come from the lines, not from free-text matching across cells.
    if (out.items.length) {
      const sum = (k) => { const v = out.items.reduce((a, i) => a + (i[k] || 0), 0); return v ? Math.round(v * 1000) / 1000 : null; };
      out.packages = sum('packages') ?? out.packages;
      out.weight_kg = sum('weight_kg') ?? out.weight_kg;
      out.cbm = sum('cbm') ?? out.cbm;
    }
  }
  if (out.containers.length === 1) {
    Object.assign(out.containers[0], { packages: out.packages ?? null, weight_kg: out.weight_kg ?? null, cbm: out.cbm ?? null });
  }
  for (const k of Object.keys(out)) if (out[k] === undefined) out[k] = null;
  return out;
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
    description: /DESCRIPTION|ITEM|PRODUCT|GOODS|품명|품목/i,
    hs_code: /HS\s*CODE|HTS/i,
    quantity: /^(Q'?TY|QUANTITY|PCS|수량)/i,
    unit: /^UNIT$/i,
    packages: /CTNS?|CARTONS?|PKGS?|PACKAGES?|박스/i,
    weight_kg: /G\.?\s?W|GROSS|WEIGHT|중량/i,
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
  if (header < 0) return [];
  const items = [];
  for (const row of rows.slice(header + 1)) {
    const desc = String(row[map.description] ?? '').trim();
    if (!desc || /^(TOTAL|SUB\s*TOTAL|합계)/i.test(desc)) continue;
    const pick = (k) => (k in map ? String(row[map[k]] ?? '').trim() : '');
    const n = (k) => { const v = num(pick(k)); return Number.isFinite(v) && pick(k) !== '' ? v : null; };
    items.push({
      po_no: pick('po_no') || null, description: desc, hs_code: pick('hs_code') || null,
      quantity: n('quantity'), unit: pick('unit') || null, packages: n('packages'), weight_kg: n('weight_kg'), cbm: n('cbm'),
    });
  }
  return items;
}

module.exports = { extractRules, detectDocType, isValidContainer, containerCheckDigit, toISODate, itemsFromRows };
