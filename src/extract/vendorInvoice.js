/**
 * Vendor / CFS invoice reader: invoice no., date, due date / terms, total, charge lines, and the references
 * (container, MBL / HBL, our file no.) used to find the file it belongs to. Rule-based offline; the Claude
 * extractor is used on top when ANTHROPIC_API_KEY is set (scans, odd layouts).
 */
const { toISODate, isValidContainer } = require('./rules');

const AMT = String.raw`\(?-?\$?\s?-?[\d,]*\d\.\d{2}\)?`;
const money = (s) => {
  if (s == null) return null;
  const neg = /^\(.*\)$/.test(s.trim()) || /-/.test(s);
  const v = Number(String(s).replace(/[^\d.]/g, ''));
  return Number.isFinite(v) ? (neg ? -v : v) : null;
};
const round = (v) => Math.round(v * 100) / 100;

// Lines that are not charges.
const NOT_A_CHARGE = /\b(SUB\s*-?\s*TOTAL|TOTAL|BALANCE|AMOUNT\s+DUE|AMOUNT\s+PAID|PAID|PAYMENT|CREDIT\s+CARD|DEPOSIT|INVOICE\s*(DATE|NO|#|NUMBER)|DUE\s+DATE|TERMS|ROUTING|ACCOUNT|ACH|WIRE|SWIFT|PAGE\s+\d|TEL|PHONE|FAX|EMAIL|WEIGHT|KGS?\b|LBS\b|CBM\b|PIECES|PCS\b|PKGS?\b|CARTONS|CTNS\b|ETA\b|ETD\b)/i;
const HEADER = /\b(DESCRIPTION|CHARGES?|SERVICE|ITEM)\b.*\b(AMOUNT|TOTAL|PRICE|RATE)\b/i;

// A label with nothing after it ("INVOICE NO." / "INVOICE DATE" on their own line or as table headers).
const LABEL = String.raw`(?:INVOICE\s*(?:NO\.?|NUMBER|#|DATE)|INV\.?\s*(?:NO\.?|#|DATE)|BILL\s*(?:NO\.?|#)|(?:DUE|SHIP|ENTRY|EFFECTIVE)\s*DATE|DATE(?:\s+OF\s+ENTRY)?|CLIENT\s+REF\.?\s*(?:NO\.?)?|(?:CUSTOMER|ACCOUNT|P\.?\s*O\.?)\s*(?:NO\.?|#|ID)|REF(?:ERENCE)?\s*(?:NO\.?|#)|TERMS|PAGE|CARRIER|COUNTRY|ENTRY\s+(?:NO\.?|TYPE)|ARRIVAL|SHIPMENT|GROSS\s+WEIGHT)`;
const LABEL_ONLY = new RegExp(`^\\s*${LABEL}[\\s:.#]*$`, 'i');
const LABEL_START = new RegExp(`^${LABEL}\\b`, 'i');

/**
 * The value that belongs to a label, whichever way the PDF text came out:
 *   same line        "INVOICE NO.  0000131-C"
 *   header row       "INVOICE NO.   INVOICE DATE" over "0000131-C   09/28/26"
 *   stacked labels   "INVOICE NO." / "INVOICE DATE" / "0000131-C" / "09/28/26"
 * `ok(v)` says whether a candidate is a real value (a number with digits, a date…).
 */
function labelled(lines, labelRe, ok) {
  const raw = lines.map((l) => l.replace(/\s+$/, ''));
  for (let i = 0; i < raw.length; i += 1) {
    const m = labelRe.exec(raw[i]);
    if (!m) continue;
    // 1. Same line, right after the label (skipping other labels on a header row).
    const after = raw[i].slice(m.index + m[0].length).replace(/^[\s:.#-]+/, '');
    const firstCell = after.split(/\s{2,}/)[0].trim();
    if (firstCell && !LABEL_START.test(firstCell)) {
      if (ok(firstCell)) return ok(firstCell);
      const tok = firstCell.split(/\s+/)[0];
      if (ok(tok)) return ok(tok);
    }
    // 2. Header row: the value sits in the same column on the next line.
    // Header cells: split on wide gaps, or — when the PDF put single spaces between them — on the known labels.
    const labelsOnLine = [...raw[i].matchAll(new RegExp(LABEL, 'gi'))].map((x) => x[0]);
    const onlyLabels = labelsOnLine.length > 1 && !raw[i].replace(new RegExp(LABEL, 'gi'), '').replace(/[\s:.#]/g, '');
    const heads = onlyLabels ? labelsOnLine : raw[i].trim().split(/\s{2,}/);
    const k = heads.findIndex((h) => labelRe.test(h));
    const next = (raw[i + 1] || '').trim();
    if (heads.length > 1 && next && !LABEL_ONLY.test(next)) {
      const cells = next.split(/\s{2,}/);
      const cand = cells.length === heads.length ? cells[k] : null;
      if (cand && ok(cand.trim())) return ok(cand.trim());
      const byPos = (raw[i + 1] || '').slice(Math.max(0, raw[i].indexOf(heads[k]) - 3)).trim().split(/\s{2,}/)[0];
      if (byPos && ok(byPos)) return ok(byPos);
    }
    // 3. Stacked labels: n label-only lines, then n values in the same order.
    if (LABEL_ONLY.test(raw[i])) {
      let a = i; while (a > 0 && LABEL_ONLY.test(raw[a - 1])) a -= 1;
      let b = i; while (b + 1 < raw.length && LABEL_ONLY.test(raw[b + 1])) b += 1;
      const v = (raw[b + 1 + (i - a)] || '').trim();
      if (v && ok(v)) return ok(v);
      const v1 = (raw[b + 1 + (i - a)] || '').trim().split(/\s{2,}/)[0];
      if (v1 && ok(v1)) return ok(v1);
    }
  }
  return null;
}

function labelDate(lines, re) {
  return labelled(lines, re, (v) => toISODate(v) || toISODate(v.split(/\s+/)[0]));
}

const NUMBER_OK = (v) => {
  const t = String(v).trim().toUpperCase().replace(/^[#:.\s]+/, '');
  return /^[A-Z0-9][A-Z0-9\-/]{2,24}$/.test(t) && /\d/.test(t) && !toISODate(t) ? t : null;
};

function invoiceNumber(lines, text) {
  const byLabel = labelled(lines, /INVOICE\s*(?:NO\.?|NUMBER|#)|\bINV\.?\s*(?:NO\.?|#)/i, NUMBER_OK)
    || labelled(lines, /\bBILL\s*(?:NO\.?|#)/i, NUMBER_OK);
  if (byLabel) return byLabel;
  const U = text.toUpperCase();
  for (const re of [/\bINV(?:OICE)?\s*#\s*[:.]?\s*([A-Z0-9][A-Z0-9\-/]{2,24})/g, /\bREF(?:ERENCE)?\s*(?:NO\.?|#)\s*[:.]?\s*([A-Z0-9][A-Z0-9\-/]{3,24})/g]) {
    for (const m of U.matchAll(re)) if (NUMBER_OK(m[1])) return NUMBER_OK(m[1]);
  }
  return null;
}

function totalDue(lines) {
  let best = null;
  const PRI = [/BALANCE\s+DUE|AMOUNT\s+DUE|TOTAL\s+DUE|PLEASE\s+PAY/i, /INVOICE\s+TOTAL|GRAND\s+TOTAL|TOTAL\s+AMOUNT|TOTAL\s+CHARGES/i, /\bTOTAL\b/i];
  PRI.forEach((re, rank) => {
    if (best && best.rank < rank) return;
    for (const l of lines) {
      if (!re.test(l) || /SUB\s*-?\s*TOTAL/i.test(l)) continue;
      const amts = l.match(new RegExp(AMT, 'g'));
      if (!amts) continue;
      const v = money(amts[amts.length - 1]);
      if (v != null && (!best || rank < best.rank || (rank === best.rank && Math.abs(v) > Math.abs(best.v)))) best = { v, rank };
    }
  });
  return best ? round(best.v) : null;
}

/** Charge lines: text + trailing amount, optionally qty and rate before it. */
function chargeLines(lines) {
  let start = lines.findIndex((l) => HEADER.test(l));
  start = start < 0 ? 0 : start + 1;
  const out = [];
  for (let i = start; i < lines.length; i += 1) {
    const l = lines[i];
    if (/^\s*(SUB\s*-?\s*TOTAL|TOTAL|BALANCE|AMOUNT\s+DUE|INVOICE\s+TOTAL|GRAND\s+TOTAL)/i.test(l) && out.length) break;
    const m = new RegExp(String.raw`^(.*?[A-Za-z].*?)\s+((?:${AMT}|\d+(?:\.\d+)?)\s+){0,3}(${AMT})\s*$`).exec(l);
    if (!m) continue;
    if (NOT_A_CHARGE.test(m[1]) && !/HANDLING|STORAGE|DEVAN|CHASSIS|DRAY|FUEL|PIER|CLEAN|EXAM|CFS|TRUCK|DELIVERY|PICK/i.test(m[1])) continue;
    const nums = l.slice(m[1].length).trim().split(/\s+/).map((x) => money(x)).filter((x) => x != null);
    const amount = nums.pop();
    let desc = m[1].replace(/\s{2,}.*$/, (tail) => (/[A-Za-z]{3}/.test(tail) ? tail : '')).replace(/\s+/g, ' ').trim();
    desc = desc.replace(/^\d+\s+/, '').replace(/[\s$:-]+$/, '');
    if (desc.length < 2 || amount == null || amount === 0) continue;
    let qty = null; let rate = null;
    const tailNums = l.slice(m[1].length).trim().split(/\s+/).slice(0, -1);
    if (nums.length >= 2 && Math.abs(nums[nums.length - 2] * nums[nums.length - 1] - amount) < 0.02) {
      [qty, rate] = nums.slice(-2);
    } else if (nums.length === 1) {
      // "Chassis 3 days @ 45.00   135.00": quantity is in the text
      const q = /(\d+(?:\.\d+)?)\s*(?:DAYS?|X|PCS|UNITS?|HRS?|HOURS?|PLTS?|CBM)?\s*@?\s*$/i.exec(desc);
      if (q && Math.abs(Number(q[1]) * nums[0] - amount) < 0.02) { qty = Number(q[1]); rate = nums[0]; desc = `${desc} ${tailNums.join(' ')}`.trim(); }
      else if (Math.abs(nums[0] - amount) < 0.005) rate = nums[0];
      else desc = `${desc} ${tailNums.join(' ')}`.trim();
    } else if (nums.length >= 2) desc = `${desc} ${tailNums.join(' ')}`.trim();
    out.push({ description: desc.toUpperCase().slice(0, 80), qty, rate, amount: round(amount) });
  }
  return out;
}

function references(text) {
  const U = text.toUpperCase();
  const containers = [...new Set((U.match(/\b[A-Z]{3}[UJZ]\s?\d{7}\b/g) || []).map((c) => c.replace(/\s/g, '')).filter(isValidContainer))];
  const tokens = [...new Set((U.match(/\b[A-Z0-9][A-Z0-9-]{6,24}\b/g) || []).filter((t) => /\d{4}/.test(t) && /[A-Z]/.test(t) || /^\d{3}-\d{8}$/.test(t)))];
  return { containers, tokens: tokens.slice(0, 400) };
}

function termsDays(text) {
  const m = /\bNET\s*(\d{1,3})\b|\bTERMS?\s*[:.]?\s*(\d{1,3})\s*DAYS/i.exec(text);
  if (m) return Number(m[1] || m[2]);
  if (/DUE\s+(UPON|ON)\s+RECEIPT|\bC\.?O\.?D\b/i.test(text)) return 0;
  return null;
}

/**
 * Parse vendor invoice text. `companies` [{id, name, short_name, emails, type}] to recognise the vendor,
 * `ownName` to skip our own name on the bill-to block.
 */
function parseVendorInvoice(text, { companies = [], ownName = 'GLOBALBRIDGE' } = {}) {
  const T = String(text || '').replace(/ /g, ' ');
  const lines = T.split(/\r?\n/).map((l) => l.replace(/\t/g, '  ').replace(/\s+$/, '')).filter((l) => l.trim());
  const flat = lines.map((l) => l.replace(/\s+/g, ' ').trim());
  const out = { warnings: [] };
  out.number = invoiceNumber(lines, T);
  // The invoice's own date first; a bare DATE only when there is none (never EFFECTIVE / ENTRY / SHIP / DUE DATE).
  out.invoice_date = labelDate(lines, /INVOICE\s*DATE|INV\.?\s*DATE|BILLING\s*DATE|STATEMENT\s*DATE/i)
    || labelDate(lines, /(?<!(?:DUE|EFFECTIVE|ENTRY|SHIP|ARRIVAL|EXPIRY|EXPIRATION|DELIVERY|PICK\s?UP)\s*)\bDATE\b(?!\s*(?:DUE|OF))/i);
  out.due_date = labelDate(lines, /DUE\s*DATE|PAYMENT\s*DUE/i);
  out.terms_days = termsDays(T);
  if (!out.due_date && out.invoice_date && out.terms_days != null) {
    const d = new Date(`${out.invoice_date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + out.terms_days);
    out.due_date = d.toISOString().slice(0, 10);
  }
  if (out.terms_days == null && out.invoice_date && out.due_date) out.terms_days = Math.max(0, Math.round((Date.parse(out.due_date) - Date.parse(out.invoice_date)) / 86400000));
  out.total = totalDue(flat);
  out.lines = chargeLines(lines);
  out.currency = /\bKRW\b|₩/.test(T) ? 'KRW' : 'USD';
  out.refs = references(T);
  out.vendor = matchVendor(T, companies, ownName);

  const sum = round(out.lines.reduce((a, l) => a + l.amount, 0));
  if (out.total == null && out.lines.length) out.total = sum;
  if (out.total != null && out.lines.length && Math.abs(sum - out.total) > 0.01) {
    out.warnings.push(`Line items add up to ${sum.toFixed(2)} but the invoice total is ${out.total.toFixed(2)} — check the lines`);
  }
  if (!out.lines.length && out.total != null) {
    out.lines = [{ description: 'PER INVOICE', qty: null, rate: null, amount: out.total }];
    out.warnings.push('Charge lines not recognised — booked as one line; split it if needed');
  }
  if (!out.number) out.warnings.push('Invoice number not found');
  if (!out.invoice_date) out.warnings.push('Invoice date not found');
  if (!out.vendor) out.warnings.push('Vendor not recognised — pick it from the list');
  return out;
}

/** The vendor is the known party whose name (or email domain) appears first on the invoice, never ourselves. */
function matchVendor(text, companies, ownName) {
  const U = text.toUpperCase();
  const own = String(ownName || '').toUpperCase();
  let best = null;
  for (const c of companies) {
    const keys = [];
    const name = String(c.name || '').toUpperCase().replace(/\(.*?\)/g, '').replace(/[,.]?\s*(INC|LLC|LTD|CO|CORP|CORPORATION|COMPANY)\.?$/g, '').trim();
    if (name.length >= 4) keys.push(name);
    if (c.short_name && c.short_name.length >= 3) keys.push(String(c.short_name).toUpperCase());
    for (const e of String(c.emails || '').toLowerCase().split(/[,;\s]+/)) {
      const d = e.split('@')[1];
      if (d && !/gmail|yahoo|outlook|hotmail|naver|daum|example$/.test(d)) keys.push(`@${d.toUpperCase()}`);
    }
    for (const k of keys) {
      if (own && own.includes(k)) continue;
      const re = new RegExp(`(^|[^A-Z0-9])${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Z0-9]|$)`);
      const m = re.exec(U);
      if (m && (!best || m.index < best.index)) best = { id: c.id, name: c.name, index: m.index };
    }
  }
  return best ? { id: best.id, name: best.name } : null;
}

module.exports = { parseVendorInvoice, chargeLines, totalDue, matchVendor, references };
