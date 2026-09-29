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
    [/HOUSE\s+BILL|HOUSE\s+B\s*\/\s*L|\bHBL\b|\bH\.?\s?B\/L\b/, 'HBL'],
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

/**
 * Value under a label on a B/L-style form, where a row of labels ("Vessel  Voyage No.  Place of Receipt") sits over a
 * row of values ("MAERSK CAP JACKSON  638E"). Cells are split on 2+ spaces. Tries the same cell after the label, then
 * the cell at the same index (or counted from the right when the value row has extra cells on the left) on the next
 * two lines. `ok(v)` validates and returns the value. The label must start a cell (so prose like "…after vessel
 * departure…" is not a label).
 */
function cellBelow(raw, labelRe, ok) {
  const anchored = new RegExp(`^(?:\\d{1,2}\\.\\s*)?(?:${labelRe.source})`, 'i');
  for (let i = 0; i < raw.length; i++) {
    const heads = raw[i].trim().split(/\s{2,}/);
    const k = heads.findIndex((h) => anchored.test(h));
    if (k < 0) continue;
    const rest = heads[k].replace(anchored, '').replace(/^[\s:.#)(-]+/, '').trim();
    if (rest && !/^[(]/.test(rest) && ok(rest)) return ok(rest);
    if (k + 1 < heads.length && heads.length === 2 && !isLabelCell(heads[k + 1]) && ok(heads[k + 1])) return ok(heads[k + 1]);
    for (let j = i + 1; j <= i + 2 && j < raw.length; j++) {
      if (!raw[j].trim() || isLabelRow(raw[j])) continue;
      const cells = raw[j].trim().split(/\s{2,}/);
      // Same number of cells: same index. Fewer: values are left-aligned (empty trailing boxes). More: extra cells
      // belong to a box on the left, so count from the right.
      const cands = cells.length === heads.length ? [cells[k]]
        : cells.length < heads.length ? [cells[k]] : [cells[cells.length - heads.length + k], cells[k]];
      for (const c of cands) if (c && ok(c.trim())) return ok(c.trim());
    }
  }
  return null;
}
const LABEL_WORDS = /^(?:\d{1,2}\.\s*)?(SHIPPER|CONSIGNEE|NOTIFY|VESSEL|VOYAGE|PORT\s+OF|PLACE\s+OF|PRE-?\s?CARRIAGE|ETD|ETA|BOOKING|B\/L|HOUSE|MASTER|AMS|COUNTRY|HTS|CARRIER|SCAC|CONTAINER|SEAL|MARKS|NUMBER\s+OF|KIND\s+OF|DESCRIPTION|GROSS|WEIGHT|MEASUREMENT|PARTICULARS|FREIGHT|EXPORT\s+REF|SVC|ONWARD|MANUFACTURER|SELLER|BUYER|SHIP\s+TO|IMPORTER|CONSOLIDATOR)\b/i;
const isLabelCell = (c) => LABEL_WORDS.test(String(c).trim());
const isLabelRow = (l) => { const cells = l.trim().split(/\s{2,}/); return cells.length > 0 && cells.every(isLabelCell); };
// A place / vessel value: letters, not a label or contract prose.
const PROSE = /\b(APPLICABLE|CLAUSE|WEIGHT|MEASUREMENT|PACKAGES|PARTICULARS|DESCRIPTION|CARRIER|DOCUMENT|MULTIMODAL|DEPARTURE|INVOICE|ISSUANCE|NEGOTIABLE|PRINCIPAL|RECEIPT|DELIVERY|DISCHARGE|LOADING|VOYAGE|PORT|PLACE|ETD|ETA)\b/i;
const placeOk = (v) => { const t = String(v).trim().replace(/[.,;]+$/, ''); return t.length >= 3 && t.length <= 45 && /[A-Z]{3}/i.test(t) && !PROSE.test(t) && !/[:;]/.test(t) ? t.toUpperCase() : null; };
const refOk = (v) => { const t = String(v).trim().toUpperCase().replace(/^[#:]\s*/, ''); return /^[A-Z0-9][A-Z0-9-]{5,24}$/.test(t) && /\d{4}/.test(t) ? t : null; };
const dateOk = (v) => toISODate(String(v).trim());
/** "MAERSK CAP JACKSON 638E" / "MAERSK CAP JACKSON / 638E" / "HMM BLESSING V.0071E" → [vessel, voyage]. */
function splitVessel(v) {
  if (!v) return [null, null];
  const t = String(v).trim();
  const slash = /^(.+?)\s*\/\s*([A-Z0-9]{2,8})$/i.exec(t);
  if (slash) return [slash[1].trim(), slash[2]];
  const vv = /^(.+?)\s+(?:V\.?|VOY\.?|VOYAGE)?\s*([0-9]{2,4}[A-Z]{0,2}|[A-Z]{0,2}[0-9]{2,4}[A-Z]?)$/i.exec(t);
  return vv ? [vv[1].replace(/[\s/-]+$/, ''), vv[2]] : [t, null];
}
/** First match of a reference pattern whose value is a real number (has digits), not a label word. */
function firstRef(U, re) {
  for (const m of U.matchAll(new RegExp(re.source, 'g'))) { const v = refOk(m[1]); if (v) return v; }
  return null;
}

/**
 * National Shipping (NSC) house B/L: the form's labels are printed graphics, so page 1 is values only, in a fixed
 * order: shipper (name + address, HBL no. at the right), consignee (name, address, TEL, E-MAIL), notify, place of
 * receipt, "VESSEL VOY  PORT OF LOADING", "PORT OF DISCHARGE  PLACE OF DELIVERY", then marks / packages.
 */
function nscHouseLayout(raw) {
  const L = raw.map((l) => l.trim()).filter(Boolean);
  const vi = L.findIndex((l) => /^[A-Z][A-Z .-]+?\s+(?:V\.?\s*)?[0-9]{2,4}[A-Z]?\s{2,}[A-Z]/.test(l));
  if (vi < 3) return null;
  const out = {};
  const [vesselVoy, pol] = L[vi].split(/\s{2,}/);
  [out.vessel, out.voyage] = splitVessel(vesselVoy);
  out.pol = placeOk(pol);
  const podLine = (L[vi + 1] || '').split(/\s{2,}/);
  out.pod = placeOk(podLine[0]); out.place_of_delivery = placeOk(podLine[1]);
  const top = L.slice(0, vi);
  const cells = top.map((l) => l.split(/\s{2,}/)[0]);
  const companyLike = (l) => /\b(INC|LLC|LTD|CO|CORP|CORPORATION|COMPANY|TRADE|TRADING|LOGISTICS|GROUP)\b\.?/i.test(l) && !/\d{3,}/.test(l);
  out.shipper_name = cells[0];
  let c = cells.findIndex((l, i) => i > 0 && companyLike(l));
  if (c > 0) {
    out.shipper_address = cells.slice(1, c).join('\n') || null;
    let e = c + 1;
    while (e < cells.length && !/^SAME\s+AS|^TO\s+ORDER/i.test(cells[e]) && !companyLike(cells[e]) && e < vi - 1) e++;
    out.consignee_name = cells[c];
    const block = cells.slice(c + 1, e);
    out.consignee_address = block.filter((l) => !/^(TEL|PHONE|FAX|E-?MAIL|ATTN)/i.test(l)).join('\n') || null;
    const email = block.join(' ').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    const tel = block.join(' ').match(/TEL\)?\s*[.:]?\s*(\+?[\d(][\d\s().-]{7,}\d)/i);
    if (email || tel) out.consignee_contact = { email: email ? email[0].toLowerCase() : null, phone: tel ? tel[1].trim() : null };
    if (cells[e]) out.notify_party = cells[e];
  }
  return out;
}

const REF = String.raw`([A-Z0-9][A-Z0-9-]{5,24})`;
const SEP = String.raw`\s*(?:NO\.?|NUMBER|#)?\s*[:.]?\s*`;

function extractRules(text, { filename = '', rows = null } = {}) {
  const docType = detectDocType(text, filename);
  const T = text.replace(/ /g, ' ');
  const U = T.toUpperCase();
  const lines = T.split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const out = { doc_type: docType, containers: [], items: [], warnings: [] };

  const raw = T.split(/\r?\n/).map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim());
  out.mbl_no = firstRef(U, new RegExp(String.raw`(?:MASTER\s*B\/?L|\bM\.?\s?B\/?L\b|OCEAN\s*B\/?L)${SEP}(?:OR\s+BOOKING#?\s*)?${REF}`))
    || cellBelow(raw, /MASTER\s*B\/?L(?:\s*(?:NUMBER|NO\.?))?(?:\s*OR\s*BOOKING#?)?/, refOk);
  out.hbl_no = firstRef(U, new RegExp(String.raw`(?:HOUSE\s*B\/?L|\bH\.?\s?B\/?L\b)${SEP}${REF}`))
    || cellBelow(raw, /HOUSE\s*B\/?L(?:\s*(?:NUMBER|NO\.?))?/, refOk);
  const genericBl = firstRef(U, new RegExp(String.raw`(?:B\/L|BILL\s+OF\s+LADING)${SEP}${REF}`));
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
  // Carrier SCAC ("SCAC  MAEU", "Carrier's SCAC CODE  MAEU"); a bare numeric master B/L gets it as prefix (MAEU277099556).
  out.scac = firstMatch(U, [/\bSCAC(?:\s+CODE)?\s*[:.]?\s*([A-Z]{4})\b/]);
  if (out.scac && out.mbl_no && /^\d{6,}$/.test(out.mbl_no)) out.mbl_no = out.scac + out.mbl_no;
  // AMS house B/L: "(KSCT) LGB26090028A" → KSCTLGB26090028A
  const ams = /\(([A-Z]{4})\)\s*([A-Z0-9]{8,20})\b/.exec(U);
  out.ams_bl_no = ams && /\d/.test(ams[2]) ? ams[1] + ams[2] : firstMatch(U, [/AMS\s*(?:HOUSE\s*)?B\/?L\s*(?:NUMBER|NO\.?)?\s*[:.]?\s*([A-Z]{4}[A-Z0-9]{8,16})\b/]);
  out.mawb_no = firstMatch(U, [/(?:MAWB|MASTER\s+AIR\s*WAYBILL)\s*(?:NO\.?|#)?\s*[:.]?\s*(\d{3}[-\s]?\d{4}\s?\d{4})/]);
  out.hawb_no = firstMatch(U, [/(?:HAWB|HOUSE\s+AIR\s*WAYBILL)\s*(?:NO\.?|#)?\s*[:.]?\s*([A-Z0-9-]{6,20})/]);
  if (!out.mawb_no && docType === 'AWB') out.mawb_no = firstMatch(U, [/\b(\d{3}-\d{4}\s?\d{4})\b/, /\b(\d{3}-\d{8})\b/]);

  // Containers: 4 letters + 7 digits, allowing "ABCU 123456-7" styles; validate check digit.
  // OCR often confuses O/0, I/1, S/5, B/8, Z/2 — a failing number is repaired when exactly one variant validates.
  const seen = new Set();
  const ctnRe = /\b([A-Z0-9]{3}[UJZ])\s?-?([0-9OISBZGTL]{6})\s?-?([0-9OISBZGTL])\b/g;
  let m;
  const allCtn = [...U.matchAll(new RegExp(ctnRe.source, 'g'))].map((x) => x.index);
  while ((m = ctnRe.exec(U))) {
    const raw = m[1] + m[2] + m[3];
    if (!/[A-Z]{2}/.test(m[1]) || !/\d{4}/.test(m[2] + m[3])) continue; // not container-like
    let no = toLetters(m[1]) + toDigits(m[2] + m[3]);
    if (!/^[A-Z]{3}[UJZ]\d{7}$/.test(no)) continue;
    let repaired = false;
    if (!isValidContainer(no)) { const fix = repairContainer(no); if (fix) { no = fix; repaired = true; } }
    if (seen.has(no)) continue;
    seen.add(no);
    // This container's own text: up to the next container number (so a row's packages / KGS / CBM stay with it).
    const nextAt = allCtn.find((x) => x > m.index + 5);
    const ctx = U.slice(m.index, Math.min(m.index + 200, nextAt ?? Infinity));
    // "ABCU1234567/SEAL123", "ABCU1234567 ML-KR1178575 40 REEF", then an explicit SEAL label nearby.
    const seal = /^[A-Z0-9]{4}\s?-?[0-9A-Z]{6}\s?-?[0-9A-Z]\s*\/\s*(?:SEAL\s*(?:NO\.?|#)?\s*[:.]?\s*)?([A-Z0-9-]{5,20})/.exec(ctx)
      || /^[A-Z0-9]{4}\s?-?[0-9A-Z]{6}\s?-?[0-9A-Z][ \t]+(?!(?:20|40|45)\b)([A-Z]{1,3}-?[A-Z0-9]*\d{4,}[A-Z0-9]*)\b/.exec(ctx)
      || /\bSEAL\s*(?:NO\.?|#|NUMBER)?\s*[:.]?\s*([A-Z0-9-]{5,20})/.exec(ctx);
    const size = /\b(20|40|45)\s*'?\s*(GP|DC|DV|HC|HQ|RF|RH|OT|FR|ST)\b/.exec(ctx);
    const reef = /\b(20|40|45)\s*'?\s*(?:REEF(?:ER)?|RF)\b\s*(9'?\s?6|HC|HIGH\s*CUBE)?/.exec(ctx);
    const dry = /\b(20|40|45)\s*'?\s*(?:DRY|DV|GP|STD|STANDARD)?\s*(9'?\s?6|HIGH\s*CUBE)\b/.exec(ctx);
    const sizeType = reef ? `${reef[1]}${reef[2] ? 'RH' : 'RF'}` : size ? size[1] + normSize(size[2]) : dry ? `${dry[1]}HC` : null;
    const pk = /(\d[\d,]*)\s*\(?\s*(PACKAGES?|PKGS?|CTNS?|CARTONS?|PALLETS?|PLTS?)\b/.exec(ctx);
    const kg = /([\d,]+(?:\.\d+)?)\s*KGS?\b/.exec(ctx);
    const cb = /([\d,]+(?:\.\d+)?)\s*(?:CBM|M3)\b/.exec(ctx);
    const c = { container_no: no, seal_no: seal ? seal[1] : null, size_type: sizeType,
      packages: pk ? num(pk[1]) : null, weight_kg: kg ? num(kg[1]) : null, cbm: cb ? num(cb[1]) : null };
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

  const vesselOk = (v) => { const t = String(v).trim(); return /^[A-Z][A-Z0-9 .'/-]{2,40}$/i.test(t) && !PROSE.test(t.replace(/\/\s*[A-Z0-9]+$/i, '')) ? t.toUpperCase() : null; };
  const VESSEL_LABEL = /(?:OCEAN\s+)?VESSEL(?:\s*(?:NAME|\/\s*VOY(?:AGE)?\.?(?:\s*NO\.?)?))?(?:\s*\/\s*VOY(?:AGE)?\.?(?:\s*NO\.?)?)?/;
  [out.vessel, out.voyage] = splitVessel(cellBelow(raw, VESSEL_LABEL, vesselOk));
  const voyOk = (v) => { const t = String(v).trim().toUpperCase(); return /^[A-Z0-9]{2,8}$/.test(t) && /\d/.test(t) ? t : null; };
  out.voyage = out.voyage || cellBelow(raw, /VOY(?:AGE)?\.?(?:\s*NO\.?)?/, voyOk)
    || firstMatch(U, [/VOY(?:AGE)?\.?\s*(?:NO\.?)?\s*[:.]?\s*([A-Z0-9]*\d[A-Z0-9]*)\b/]);
  out.flight_no = firstMatch(U, [/FLIGHT\s*(?:NO\.?|#)?\s*[:.]?\s*([A-Z0-9]{2}\s?\d{2,4})/]);
  out.pol = cellBelow(raw, /PORT\s+OF\s+LOADING|POL\b|AIRPORT\s+OF\s+DEPARTURE/, placeOk);
  out.pod = cellBelow(raw, /PORT\s+OF\s+DISCHARGE|POD\b|AIRPORT\s+OF\s+DESTINATION/, placeOk);
  out.place_of_delivery = cellBelow(raw, /PLACE\s+OF\s+DELIVERY|FINAL\s+DESTINATION/, placeOk);

  out.etd = toISODate(firstMatch(T, [new RegExp(String.raw`(?:ETD|ON\s*BOARD\s*DATE|SHIPPED\s+ON\s+BOARD(?:\s+DATE)?|LADEN\s+ON\s+BOARD(?:\s+DATE)?|DEPARTURE\s+DATE|SAILING\s+DATE)\s*[:.]?\s*${DATE_RE}`, 'i')]))
    || cellBelow(raw, /ETD\b/, dateOk);
  out.eta = toISODate(firstMatch(T, [new RegExp(String.raw`(?:ETA|ARRIVAL\s+DATE|EST\.?\s+ARRIVAL)\s*[:.]?\s*${DATE_RE}`, 'i')]))
    || cellBelow(raw, /ETA\b/, dateOk);
  out.service_term = firstMatch(U, [/\b((?:CY|CFS)\s*\/\s*(?:CY|CFS|DOOR))\b/]);
  if (out.service_term) out.service_term = out.service_term.replace(/\s+/g, '');

  out.shipper_name = partyName(raw, /^(?:\d{1,2}\.\s*)?(?:SHIPPER|EXPORTER|SELLER)(?:\s*\/\s*EXPORTER)?\b/i);
  out.consignee_name = partyName(raw, /^(?:\d{1,2}\.\s*)?(?:CONSIGNEE|BUYER|IMPORTER)\b/i);
  out.notify_party = partyName(raw, /^(?:\d{1,2}\.\s*)?NOTIFY(?:\s+PARTY)?\b/i);
  // Label-less NSC house B/L page: read by position.
  if (!out.shipper_name && !out.consignee_name && /\bNSC[A-Z]{2,5}\d{6,9}\b/.test(U)) {
    const nsc = nscHouseLayout(raw);
    if (nsc) for (const [k, v] of Object.entries(nsc)) if (v != null && (out[k] == null || out[k] === '')) out[k] = v;
  }
  // Addresses under the SHIPPER / CONSIGNEE / NOTIFY boxes (used to add a new customer from the documents).
  for (const p of require('./party').readParties(T, { db: null, withLetterhead: false })) {
    const k = { shipper: 'shipper_address', consignee: 'consignee_address', notify: 'notify_address' }[p.role];
    if (k && p.address && !out[k]) out[k] = p.address;
    if (p.role === 'consignee' && (p.email || p.phone) && !out.consignee_contact) out.consignee_contact = { email: p.email, phone: p.phone };
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
  if (out.commodity && (/[;]|MARKS|CONTAINER\s+NO|WEIGHT|MEASUREMENT/i.test(out.commodity) || !/[A-Z]{3}/i.test(out.commodity))) out.commodity = null;
  out.commodity = out.commodity || firstMatch(U, [/SAID\s+TO\s+CONTAIN[^\n]*\n(?:\s*N\/?M\s+)?\s*([A-Z][A-Z ,&()-]{3,60})/, /\bN\/M\s{1,}([A-Z][A-Z ,&()-]{3,60})/]);
  out.firms_code = firstMatch(U, [/FIRMS?\s*(?:CODE)?\s*(?:NO\.?|#)?\s*[:.]?\s*([A-Z][A-Z0-9]\d{2}|[A-Z]\d[A-Z0-9]\d|[A-Z]{2}[A-Z0-9]\d)\b/]);
  out.freight_location = labelValue(lines, /(?:FREIGHT|CARGO)\s+LOCATION|DISCHARGE\s+TERMINAL|\bTERMINAL\s*(?:NAME)?\s*:|CFS\s+LOCATION|AVAILABLE\s+AT/i);
  out.last_free_day = toISODate(firstMatch(T, [new RegExp(String.raw`(?:LAST\s+FREE\s+DAY|\bLFD)\s*[:.-]?\s*${DATE_RE}`, 'i')]));
  // "INVOICE NO: X", or the Korean-style box "9. No & Date of Invoice" with "#BSBUS26091601 / 2026.09.16" under it.
  out.ci_invoice_no = invoiceNoBelow(rows) || [
    /NO\.?\s*(?:&|AND)\s*DATE\s+OF\s+INVOICE\s*[:.]?\s*#?\s*([A-Z0-9][A-Z0-9_-]{3,24})/g,
    /NO\.?\s*(?:&|AND)\s*DATE\s+OF\s+INVOICE[^\n]*\n(?:[^\n]*?#\s*|\s*)([A-Z0-9][A-Z0-9_-]{3,24})/g,
    /INVOICE\s*(?:NO\.?|#|NUMBER)\s*[:.]?\s*#?\s*([A-Z0-9][A-Z0-9_-]{3,24})/g,
  ].map((re) => [...U.matchAll(re)].map((x) => x[1]).find((v) => /\d/.test(v))).find(Boolean) || null;
  out.isf_no = firstMatch(U, [/ISF\s*(?:NO\.?|#|TRANSACTION\s*(?:NO\.?)?)\s*[:.]?\s*([A-Z0-9-]{6,25})/]);
  out.telex_release = /TELEX\s+RELEASE|SURRENDERED|SEA\s*WAYBILL|EXPRESS\s+RELEASE|电放/.test(U) || null;

  if (rows) {
    const { items, totals, packageUnit } = itemsFromRows(rows);
    out.items = items;
    if (items.length && packageUnit && out.packages == null) out.package_unit = packageUnit;
    if (items.length) {
      // Table totals beat free-text matching: use the TOTAL row, else the sum of the lines.
      const sum = (k) => { const v = items.reduce((a, i) => a + (i[k] || 0), 0); return v ? Math.round(v * 1000) / 1000 : null; };
      // A TOTAL row shifted by a column (the piece total landing under BOX) is caught by comparing with the lines.
      const shifted = (k) => totals?.[k] != null && sum(k) != null && totals[k] === sum('quantity') && Math.abs(totals[k] - sum(k)) > 1;
      for (const k of ['packages', 'weight_kg', 'cbm']) out[k] = (shifted(k) ? sum(k) : totals?.[k]) ?? sum(k) ?? out[k];
      if (totals) for (const k of ['packages', 'weight_kg', 'cbm']) if (shifted(k)) totals[k] = sum(k);
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
    const c0 = out.containers[0];
    Object.assign(c0, { packages: c0.packages ?? out.packages ?? null, weight_kg: c0.weight_kg ?? out.weight_kg ?? null, cbm: c0.cbm ?? out.cbm ?? null });
  }
  // Several containers each with their own figures: the totals are their sum (a rider page may list only one of the
  // "12,490 KGS" totals, and the largest single figure would otherwise win).
  if (out.containers.length > 1 && out.containers.every((c) => c.weight_kg != null)) {
    const sum = (k) => Math.round(out.containers.reduce((a, c) => a + (c[k] || 0), 0) * 1000) / 1000;
    if (!out.weight_kg || out.weight_kg < sum('weight_kg')) out.weight_kg = sum('weight_kg');
    if (out.containers.every((c) => c.cbm != null) && (!out.cbm || out.cbm < sum('cbm'))) out.cbm = sum('cbm');
    if (out.containers.every((c) => c.packages != null) && (!out.packages || out.packages < sum('packages'))) out.packages = sum('packages');
  }
  // Every commercial invoice a B/L / ISF names ("*INVOICE NO. : UB005", "NO. & DATE OF INVOICE: X & SEP.16.2026").
  if (['MBL', 'HBL', 'ISF', 'NOA', 'OTHER'].includes(docType)) {
    const refs = new Set();
    for (const re of [/INVOICE\s*NO\.?\s*[:.]?\s*#?\s*([A-Z0-9][A-Z0-9_-]{3,24})/g, /NO\.?\s*(?:&|AND)\s*DATE\s+OF\s+INVOICE\s*[:.]?\s*#?\s*([A-Z0-9][A-Z0-9_-]{3,24})/g]) {
      for (const m of U.matchAll(re)) if (/\d/.test(m[1])) refs.add(m[1]);
    }
    out.invoice_refs = [...refs];
  }
  // Each cargo line remembers its invoice and final buyer (a consolidated box can hold Target and Nordstrom goods).
  out.buyer = ['PL', 'CI', 'OTHER'].includes(docType) || out.items.length ? finalBuyer(U, raw, { invoiceNo: out.ci_invoice_no, consignee: out.consignee_name }) : null;
  for (const it of out.items) { it.invoice_no = it.invoice_no || out.ci_invoice_no || null; it.buyer = it.buyer || out.buyer || null; }
  for (const k of Object.keys(out)) if (out[k] === undefined) out[k] = null;
  return out;
}

/** Spreadsheet C/I: the value under a "No & Date of Invoice" / "Invoice No." cell, same column. */
function invoiceNoBelow(rows) {
  if (!rows) return null;
  for (let r = 0; r < rows.length; r += 1) {
    const c = rows[r].findIndex((v) => /NO\.?\s*(?:&|AND)\s*DATE\s+OF\s+INVOICE|^\s*INVOICE\s*(?:NO\.?|#|NUMBER)\s*[:.]?\s*$/i.test(String(v)));
    if (c < 0) continue;
    const cand = [rows[r][c + 1], ...rows.slice(r + 1, r + 4).map((row) => row[c])];
    for (const v of cand) {
      const m = /^\s*#?\s*([A-Z0-9][A-Z0-9_-]{3,24})/i.exec(String(v || ''));
      if (m && /\d/.test(m[1])) return m[1].toUpperCase();
    }
  }
  return null;
}

// RH (reefer high cube, "40 REEF 9'6") is kept apart from RF — the terminal / trucker needs the height.
function normSize(s) { return { HQ: 'HC', DV: 'GP', DC: 'GP', ST: 'GP' }[s] || s; }
function normUnit(u) {
  if (/^CT|^CART/.test(u)) return 'CTNS';
  if (/^PL|^PALLET/.test(u)) return 'PLTS';
  if (/^PK|^PACK/.test(u)) return 'PKGS';
  return u;
}

/**
 * Party name under / after a SHIPPER / CONSIGNEE / NOTIFY label. Skips the form's own small print ("(As principal,
 * where 'care of'…)", "(see clause 22)"), keeps only the left cell when a right-hand column shares the line.
 */
const SMALL_PRINT = /^\(|^AS\s+PRINCIPAL|\b(NEGOTIABLE|CLAUSE|CARE\s+OF|PRINCIPAL|OF\s+BEARER)\b/i;
function partyName(lines, labelRe) {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!labelRe.test(line)) continue;
    const cell = line.split(/\s{2,}/)[0];
    const rest = cell.replace(labelRe, '').replace(/^[\s:/]*(?:\(?\s*(?:NAME\s*(?:&|AND)\s*ADDRESS|IMPORTER\s+OF\s+RECORD)\s*\)?)?[\s:)]*/i, '')
      .replace(/^(?:NAME\s*(?:&|AND)\s*ADDRESS|\(\s*IMPORTER\s+OF\s+RECORD\s*\))[\s:)]*/i, '').trim();
    if (rest.length > 2 && !/^(ADDRESS|NAME)\b/i.test(rest) && !SMALL_PRINT.test(rest)) return rest;
    for (let j = i + 1; j < Math.min(lines.length, i + 5); j++) {
      const v = lines[j].trim().split(/\s{2,}/)[0];
      if (!v || SMALL_PRINT.test(v) || /^\([A-Z]{4}\)/.test(v)) continue;
      if (/^(ADDRESS|NAME)\b/i.test(v) || isLabelCell(v)) break;
      return v;
    }
  }
  return null;
}

/** Packing-list line items from a spreadsheet: find the header row, map columns by name. */
function itemsFromRows(rows) {
  const COLS = {
    po_no: /^(P\.?O\.?|PO\s*NO|ORDER)/i,
    sku: /^(SKU|ITEM\s*(NO|CODE|#)|STYLE\s*(NO|#)?$|MODEL|BARCODE|UPC)/i,
    description: /DESCRIPTION|ITEM|PRODUCT|GOODS|COMMODITY|품명|품목/i,
    hs_code: /HS\s*CODE|HTS/i,
    unit_price: /UNIT\s*PRICE|PRICE|단가/i,
    amount: /AMOUNT|TOTAL\s*VALUE|VALUE|금액/i,
    quantity: /^(Q'?TY|QUANTITY|PCS|수량)/i,
    unit: /^UNIT$/i,
    packages: /CTNS?|CARTONS?|PKGS?|PACKAGES?|^C\/?T\b|\bBOX(ES)?\b|박스/i,
    // Gross weight only — "N. WEIGHT", "N.W", "NET" are net weight.
    weight_kg: /^(?!\s*N\.?\s*(W\b|WT|WEIGHT))(?!.*\bNET\b).*(G\.?\s?W|GROSS|WEIGHT|중량)/i,
    // CBM / measurement; a bare "VOLUME" column on cosmetics lists is the bottle size (35ml), not CBM.
    cbm: /CBM|MEAS|M3|^VOLUME\s*\(?\s*(CBM|M3)/i,
  };
  let header = -1; let map = {}; let dataFrom = 0;
  // A two-row header ("QUANTITY" over "PCS | BOX | PLT") is read as one: top text + sub text per column.
  const isNum = (v) => /^-?[\d,]*\.?\d+$/.test(String(v ?? '').trim());
  const subHeader = (row) => row && row.filter((c) => String(c ?? '').trim()).length >= 2 && !row.some(isNum) && !row.some((c) => /\d/.test(String(c ?? '')));
  for (let r = 0; r < Math.min(rows.length, 40); r++) {
    const m = {};
    const filled = (row) => row.filter((c) => String(c ?? '').trim()).length;
    const two = filled(rows[r]) >= 3 && subHeader(rows[r + 1]) && filled(rows[r + 1]) < filled(rows[r]) + 3 && !rows[r + 1].some((c) => /DESCRIPTION|PRODUCT/i.test(String(c)));
    const hdr = two ? rows[r].map((c, i) => `${String(c ?? '').trim()} ${String(rows[r + 1][i] ?? '').trim()}`.trim()) : rows[r];
    if (two) for (let i = rows[r].length; i < rows[r + 1].length; i++) hdr[i] = String(rows[r + 1][i] ?? '').trim();
    hdr.forEach((cell, i) => {
      const s = String(cell).trim();
      for (const [k, re] of Object.entries(COLS)) if (!(k in m) && re.test(s)) { m[k] = i; break; }
    });
    if ('description' in m && Object.keys(m).length >= 2) { header = r; map = m; dataFrom = two ? r + 2 : r + 1; rows = [...rows]; rows[r] = hdr; break; }
  }
  if (header < 0) return { items: [], totals: null };
  // "Q'TY(pcs)" / "Q'TY / (pcs)": the unit sits in the header.
  const qh = 'quantity' in map ? /\(\s*([A-Z]{2,5})\s*\)|\b(PCS|EA|SETS?|UNITS?)\b/i.exec(String(rows[header][map.quantity])) : null;
  const qtyHeaderUnit = qh ? (qh[1] || qh[2]).toUpperCase() : null;
  const items = [];
  let totals = null;
  // The table ends at its TOTAL row, or where the next form section / document starts ("PACKING LIST",
  // "3. NOTIFY PARTY:", "SAY: …", a repeated header): nothing after it is a cargo line.
  const SECTION = /^(PACKING\s+LIST|COMMERCIAL\s+INVOICE|\d{1,2}\.\s*[A-Z][A-Z /&]+:?$|SAY\b|TOTAL\s+(?:PACKAGES|AMOUNT)\s*:|SHIPPER\b|CONSIGNEE\b|NOTIFY\b|SIGNED\b|SIGNATURE\b|REMARKS?\b|MARKS\s*&)/i;
  for (const row of rows.slice(dataFrom)) {
    const cells = row.map((c) => String(c ?? '').trim());
    const pick = (k) => (k in map ? cells[map[k]] || '' : '');
    // Excel float noise (242.79999999999998) → 3 decimals.
    const n = (k) => { const v = numIn(pick(k)); return v == null ? null : Math.round(v * 1000) / 1000; };
    // Some lists put the full product name in the SKU column and only a category ("Shampoo") under description.
    const skuCell = pick('sku');
    const skuIsName = /\s/.test(skuCell) && skuCell.length > 20 && skuCell.length > pick('description').length;
    const desc = skuIsName ? skuCell : pick('description');
    const isTotal = cells.some((c) => /^(TOTAL|SUB\s*-?TOTAL|G(RAND)?\.?\s*TOTAL|합계)\b/i.test(c));
    if (isTotal) {
      totals = { packages: n('packages'), weight_kg: n('weight_kg'), cbm: n('cbm'), quantity: n('quantity'), amount: n('amount') };
      if (items.length) break;
      continue;
    }
    const first = cells.find((c) => c) || '';
    if (items.length && (SECTION.test(first) || SECTION.test(desc))) break;
    if (!desc || SECTION.test(desc) || COLS.description.test(desc) && !numIn(pick('quantity'))) continue;
    // "12,000 PCS" in the quantity cell carries the unit
    const qtyUnit = /[\d.,]+\s*([A-Z]{2,6})\b/i.exec(pick('quantity'));
    items.push({
      po_no: pick('po_no') || (skuIsName ? null : skuCell) || null, description: desc, hs_code: pick('hs_code') || null,
      quantity: n('quantity'), unit: pick('unit') || (qtyUnit ? qtyUnit[1].toUpperCase() : null) || qtyHeaderUnit,
      // Box counts from a formula (1883 pcs / 12 = 156.917) are whole boxes.
      packages: n('packages') == null ? null : Math.round(n('packages')), weight_kg: n('weight_kg'), cbm: n('cbm'), unit_price: n('unit_price'), amount: n('amount'),
    });
  }
  // Unit of the packages column: cartons (CT / CTNS / CARTON), pallets, or plain packages.
  const ph = 'packages' in map ? String(rows[header][map.packages]).toUpperCase() : '';
  const packageUnit = /PALLET|PLT/.test(ph) ? 'PLTS' : /C\/?T|CTN|CARTON|BOX|박스/.test(ph) ? 'CTNS' : ph ? 'PKGS' : null;
  return { items, totals, packageUnit };
}

// Final buyers (the retailer the goods are for) seen on P/L / C/I: named in the text, or coded in the invoice no.
const RETAILERS = [['TARGET', 'Target'], ['NORDSTROM RACK', 'Nordstrom Rack'], ['NORDSTROM', 'Nordstrom'], ['ULTA', 'Ulta'], ['WALMART', 'Walmart'],
  ['COSTCO', 'Costco'], ['SEPHORA', 'Sephora'], ['AMAZON', 'Amazon'], ['TJ ?MAXX', 'TJ Maxx'], ['TJX', 'TJX'], ['MARSHALLS', 'Marshalls'],
  ['HOME ?GOODS', 'HomeGoods'], ['ROSS STORES', 'Ross'], ["MACY'?S", "Macy's"], ['CVS', 'CVS'], ['WALGREENS', 'Walgreens'], ["KOHL'?S", "Kohl's"],
  ['KROGER', 'Kroger'], ['WHOLE FOODS', 'Whole Foods'], ["TRADER JOE'?S", "Trader Joe's"], ['BEST BUY', 'Best Buy'], ["BLOOMINGDALE'?S", "Bloomingdale's"],
  ['SAKS', 'Saks'], ['NEIMAN MARCUS', 'Neiman Marcus'], ['URBAN OUTFITTERS', 'Urban Outfitters'], ['BURLINGTON', 'Burlington'], ['DOLLAR TREE', 'Dollar Tree'],
  ['DOLLAR GENERAL', 'Dollar General'], ['FIVE BELOW', 'Five Below'], ['IPSY', 'Ipsy'], ['BOXYCHARM', 'BoxyCharm'], ['MEIJER', 'Meijer'],
  ['ALBERTSONS', 'Albertsons'], ['SAFEWAY', 'Safeway'], ['PUBLIX', 'Publix'], ['H ?MART', 'H Mart'], ['OLIVE YOUNG', 'Olive Young'], ['REVOLVE', 'Revolve'],
  ["DILLARD'?S", "Dillard's"], ['JCPENNEY|JC PENNEY', 'JCPenney']];
const BUYER_CODES = { TGT: 'Target', NDS: 'Nordstrom', NORD: 'Nordstrom', WMT: 'Walmart', ULTA: 'Ulta', CSTCO: 'Costco', COSTCO: 'Costco', AMZ: 'Amazon', SEP: 'Sephora', CVS: 'CVS' };
/** The final buyer of a P/L / C/I: a retailer named on it, one coded in the invoice no. (EZVC_TGT_26-09 → Target), or the
 *  FINAL BUYER / SOLD TO / SHIP TO / DELIVERY ADDRESS party when it is not the consignee. */
function finalBuyer(U, lines, { invoiceNo, consignee } = {}) {
  for (const [re, name] of RETAILERS) if (new RegExp(`(^|[^A-Z])(?:${re})([^A-Z]|$)`).test(U)) return name;
  for (const tok of String(invoiceNo || '').toUpperCase().split(/[^A-Z]+/)) if (BUYER_CODES[tok]) return BUYER_CODES[tok];
  const p = partyName(lines, /^(?:\d{1,2}\.\s*)?(?:FINAL\s+BUYER|ULTIMATE\s+CONSIGNEE|SOLD\s+TO|SHIP\s+TO|DELIVERY\s+ADDRESS|DELIVER\s+TO)\b/i);
  if (p && !/^SAME\s+AS/i.test(p) && (!consignee || p.toUpperCase() !== String(consignee).toUpperCase())) return p;
  return null;
}

/** First number in a cell ("USD 25,200.00" -> 25200, "980 CTNS" -> 980). */
function numIn(s) {
  const m = /-?[\d,]*\.?\d+/.exec(String(s || '').replace(/\s/g, ''));
  if (!m) return null;
  const v = Number(m[0].replace(/,/g, ''));
  return Number.isFinite(v) ? v : null;
}

module.exports = { finalBuyer, extractRules, detectDocType, isValidContainer, containerCheckDigit, toISODate, itemsFromRows };
