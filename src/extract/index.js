const config = require('../config');
const { readDocument } = require('./text');
const { extractRules, isValidContainer } = require('./rules');

/**
 * Extract fields from one uploaded file. Returns an array — one extraction per logical document
 * (a merged PDF with MBL + HBL + P/L yields three). `docTypeHint` is the upload slot (optional).
 */
async function extractFile({ buffer, filename, mime, docTypeHint }) {
  let segments;
  try { ({ segments } = await readDocument(buffer, filename, mime)); } catch (e) {
    segments = [{ text: '', rows: null, error: e.message }];
  }
  const hint = docTypeHint && docTypeHint !== 'AUTO' && docTypeHint !== 'OTHER' ? docTypeHint : null;
  const out = [];
  for (const seg of segments) {
    const single = segments.length === 1;
    // In a merged file trust the page title; in a single-document file the upload slot / filename wins.
    let result = extractRules(seg.text, { filename: single ? filename : '', rows: seg.rows });
    if (!single && seg.docType && seg.docType !== 'OTHER') result.doc_type = seg.docType;
    if (single && hint) result.doc_type = hint;
    let method = seg.ocr ? 'ocr' : 'rules';
    if (config.ai.enabled) {
      try {
        const ai = await require('./ai').extractAI({
          buffer, filename, mime, text: seg.ocr ? '' : seg.text,
          pages: single ? null : seg.pages, docType: result.doc_type,
        });
        if (ai) {
          const keepType = result.doc_type;
          result = mergeFieldwise(ai, result);
          if (!single || hint) result.doc_type = keepType;
          method = 'ai';
        }
      } catch (e) {
        result.warnings.push(`AI extraction unavailable (${e.message}); used ${method === 'ocr' ? 'OCR' : 'rule-based'} extraction`);
      }
    }
    if (seg.error) result.warnings.push(`Could not read file: ${seg.error}`);
    if (!seg.text.trim() && method !== 'ai') {
      result.warnings.push('No readable text found. Enter the details manually or enable AI extraction.');
    } else if (seg.ocr && method === 'ocr') {
      result.warnings.push(`Scanned document read by OCR (confidence ${seg.ocrConfidence ?? '?'}%) — please double-check numbers`);
    }
    out.push({ ...result, method, pages: seg.pages || null, sheet: seg.sheet || null, ocr: Boolean(seg.ocr), warnings: result.warnings || [] });
  }
  return out;
}

/** Prefer `primary` values, fill gaps from `fallback`. */
function mergeFieldwise(primary, fallback) {
  const out = { ...fallback };
  for (const [k, v] of Object.entries(primary)) {
    if (Array.isArray(v)) out[k] = v.length ? v : fallback[k] || [];
    else if (v !== null && v !== undefined && v !== '') out[k] = v;
  }
  out.warnings = [...(fallback.warnings || [])];
  for (const c of out.containers || []) {
    if (!isValidContainer(c.container_no) && !out.warnings.some((w) => w.includes(c.container_no))) {
      out.warnings.push(`Container ${c.container_no}: check digit does not match — please verify`);
    }
  }
  return out;
}

// Which document is the authority for which field when several documents disagree.
const PRIORITY = {
  mbl_no: ['MBL', 'HBL', 'ISF', 'AWB'],
  hbl_no: ['HBL', 'ISF', 'PL', 'CI'],
  default: ['HBL', 'MBL', 'AWB', 'NOA', 'ISF', 'PL', 'CI', 'DO', 'OTHER'],
  // The house parties (the carrier's MBL names the agent / us as shipper / consignee).
  shipper_name: ['HBL', 'ISF', 'CI', 'PL', 'AWB', 'MBL'],
  consignee_name: ['HBL', 'ISF', 'CI', 'PL', 'AWB', 'NOA', 'MBL'],
  notify_party: ['HBL', 'ISF', 'CI', 'AWB', 'MBL'],
  shipper_address: ['HBL', 'ISF', 'CI', 'MBL'],
  consignee_address: ['HBL', 'ISF', 'CI', 'MBL'],
  notify_address: ['HBL', 'ISF', 'MBL'],
  consignee_contact: ['HBL', 'ISF', 'CI', 'MBL'],
  eta: ['NOA', 'ISF', 'HBL', 'MBL', 'AWB'],
  scac: ['MBL', 'ISF', 'HBL'],
  firms_code: ['NOA', 'AWB', 'MBL', 'HBL', 'ISF'],
  freight_location: ['NOA', 'DO', 'MBL', 'HBL'],
  last_free_day: ['NOA', 'DO'],
  ci_invoice_no: ['CI', 'PL'],
  cargo_value: ['CI'],
  items: ['PL', 'CI'],
};
const SCALARS = ['mbl_no', 'hbl_no', 'mawb_no', 'hawb_no', 'carrier', 'vessel', 'voyage', 'flight_no', 'pol', 'pod',
  'place_of_delivery', 'etd', 'eta', 'shipper_name', 'consignee_name', 'notify_party', 'packages', 'package_unit',
  'weight_kg', 'cbm', 'chargeable_weight', 'commodity', 'firms_code', 'freight_location', 'last_free_day',
  'ci_invoice_no', 'cargo_value', 'isf_no', 'telex_release', 'sub_bl_no', 'agent_ref',
  'shipper_address', 'consignee_address', 'notify_address', 'consignee_contact', 'scac', 'ams_bl_no', 'service_term'];

/** Combine per-document extractions into one shipment draft. */
function mergeExtractions(docs) {
  const HOUSE_FIRST = ['shipper_name', 'shipper_address', 'consignee_name', 'consignee_address', 'consignee_contact', 'notify_party', 'notify_address', 'commodity', 'packages', 'weight_kg', 'chargeable_weight', 'ci_invoice_no'];
  const rank = (field, type, d = {}) => {
    const order = PRIORITY[field] || PRIORITY.default;
    const i = order.indexOf(type);
    // MAWB vs HAWB are both 'AWB': for the house's parties and cargo the house waybill wins.
    return (i < 0 ? 99 : i) + (HOUSE_FIRST.includes(field) && d.doc_role === 'master' ? 0.5 : 0);
  };
  const draft = { containers: [], items: [], warnings: [], sources: {} };
  const consolidated = new Set(docs.filter((d) => ['PL', 'CI'].includes(d.doc_type)).map((d) => d.ci_invoice_no || d.filename || Math.random())).size > 1;
  for (const field of SCALARS) {
    const candidates = docs.filter((d) => d[field] !== null && d[field] !== undefined && d[field] !== '')
      .sort((a, b) => rank(field, a.doc_type, a) - rank(field, b.doc_type, b));
    if (candidates.length) {
      draft[field] = candidates[0][field];
      draft.sources[field] = candidates[0].doc_type;
      // Consolidated box (several invoices): a P/L / C/I total is only part of it — compare B/L-type documents only.
      const comparable = ['weight_kg', 'cbm', 'packages'].includes(field) && consolidated ? candidates.filter((c) => !['PL', 'CI'].includes(c.doc_type)) : candidates;
      const distinct = [...new Set(comparable.map((c) => String(c[field])))];
      if (distinct.length > 1 && ['mbl_no', 'hbl_no', 'weight_kg', 'cbm', 'packages', 'eta', 'etd'].includes(field)) {
        draft.warnings.push(`${field} differs between documents: ${distinct.join(' vs ')} — using ${candidates[0].doc_type}`);
      }
    } else {
      draft[field] = null;
    }
  }
  const byNo = new Map();
  for (const d of docs) {
    for (const c of d.containers || []) {
      const prev = byNo.get(c.container_no) || {};
      byNo.set(c.container_no, { ...c, ...Object.fromEntries(Object.entries(prev).filter(([, v]) => v != null)) });
    }
  }
  draft.containers = [...byNo.values()];
  // Cargo lines: every P/L (a consolidated shipment has one per invoice / buyer), plus the C/I lines of any invoice
  // that has no P/L. C/I prices / HS codes fill in the matching P/L line of the same invoice.
  const plDocs = docs.filter((d) => d.items?.length && d.doc_type === 'PL');
  const ciDocs = docs.filter((d) => d.items?.length && d.doc_type === 'CI');
  const invOf = (d) => (d.ci_invoice_no || '').toUpperCase();
  const plInvoices = new Set(plDocs.map(invOf));
  const itemDocs = plDocs.length
    ? [...plDocs, ...ciDocs.filter((d) => invOf(d) && !plInvoices.has(invOf(d)))]
    : docs.filter((d) => d.items?.length).sort((a, b) => rank('items', a.doc_type) - rank('items', b.doc_type)).slice(0, 1);
  draft.items = itemDocs.flatMap((d) => d.items.map((i) => ({ ...i })));
  const key = (i) => `${(i.invoice_no || '').toUpperCase()}|${(i.po_no || '').toUpperCase()}|${(i.description || '').toUpperCase().replace(/\s+/g, ' ')}`;
  const ciItems = ciDocs.filter((d) => !itemDocs.includes(d)).flatMap((d) => d.items);
  for (const it of draft.items) {
    const ci = ciItems.find((c) => key(c) === key(it)) || ciItems.find((c) => key({ ...c, invoice_no: '' }) === key({ ...it, invoice_no: '' }));
    if (!ci) continue;
    for (const k of ['unit_price', 'amount', 'hs_code', 'quantity', 'unit', 'buyer']) if (it[k] == null && ci[k] != null) it[k] = ci[k];
  }
  // HBL on the AWB side
  if (!draft.mbl_no && draft.mawb_no) draft.mbl_no = draft.mawb_no;
  if (!draft.hbl_no && draft.hawb_no) draft.hbl_no = draft.hawb_no;
  const types = new Set(docs.map((d) => d.doc_type));
  if (!draft.carrier && draft.scac) draft.carrier = require('../tracking/codes').CARRIERS[draft.scac] || null;
  draft.mode = types.has('AWB') || draft.mawb_no || draft.flight_no ? 'AIR' : draft.containers.length ? 'FCL' : 'LCL';
  for (const d of docs) for (const w of d.warnings || []) if (!draft.warnings.includes(w)) draft.warnings.push(w);
  // Heads-up: an invoice the B/L names with no C/I or P/L uploaded for it.
  draft.invoice_refs = [...new Set(docs.flatMap((d) => d.invoice_refs || []))];
  const haveInv = new Set(docs.filter((d) => ['CI', 'PL'].includes(d.doc_type)).map((d) => String(d.ci_invoice_no || '').toUpperCase()).filter(Boolean));
  draft.missing_invoices = draft.invoice_refs.filter((r) => !haveInv.has(r.toUpperCase()));
  if (draft.missing_invoices.length && haveInv.size) draft.warnings.push(`B/L lists invoice ${draft.missing_invoices.join(', ')} — no C/I / P/L uploaded for it yet (ask the shipper / agent)`);
  draft.doc_types = [...types];
  return draft;
}

module.exports = { extractFile, mergeExtractions };
