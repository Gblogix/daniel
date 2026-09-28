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
  'shipper_address', 'consignee_address', 'notify_address', 'consignee_contact'];

/** Combine per-document extractions into one shipment draft. */
function mergeExtractions(docs) {
  const rank = (field, type) => {
    const order = PRIORITY[field] || PRIORITY.default;
    const i = order.indexOf(type);
    return i < 0 ? 99 : i;
  };
  const draft = { containers: [], items: [], warnings: [], sources: {} };
  for (const field of SCALARS) {
    const candidates = docs.filter((d) => d[field] !== null && d[field] !== undefined && d[field] !== '')
      .sort((a, b) => rank(field, a.doc_type) - rank(field, b.doc_type));
    if (candidates.length) {
      draft[field] = candidates[0][field];
      draft.sources[field] = candidates[0].doc_type;
      const distinct = [...new Set(candidates.map((c) => String(c[field])))];
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
  const itemDoc = docs.filter((d) => d.items?.length).sort((a, b) => rank('items', a.doc_type) - rank('items', b.doc_type))[0];
  draft.items = itemDoc ? itemDoc.items.map((i) => ({ ...i })) : [];
  // P/L lines carry cartons/weight; C/I lines carry price/value — join them by PO + description.
  const ciItems = docs.filter((d) => d.doc_type === 'CI' && d !== itemDoc).flatMap((d) => d.items || []);
  const key = (i) => `${(i.po_no || '').toUpperCase()}|${(i.description || '').toUpperCase().replace(/\s+/g, ' ')}`;
  for (const it of draft.items) {
    const ci = ciItems.find((c) => key(c) === key(it));
    if (!ci) continue;
    for (const k of ['unit_price', 'amount', 'hs_code', 'quantity', 'unit']) if (it[k] == null && ci[k] != null) it[k] = ci[k];
  }
  // HBL on the AWB side
  if (!draft.mbl_no && draft.mawb_no) draft.mbl_no = draft.mawb_no;
  if (!draft.hbl_no && draft.hawb_no) draft.hbl_no = draft.hawb_no;
  const types = new Set(docs.map((d) => d.doc_type));
  draft.mode = types.has('AWB') || draft.mawb_no || draft.flight_no ? 'AIR' : draft.containers.length ? 'FCL' : 'LCL';
  for (const d of docs) for (const w of d.warnings || []) if (!draft.warnings.includes(w)) draft.warnings.push(w);
  draft.doc_types = [...types];
  return draft;
}

module.exports = { extractFile, mergeExtractions };
