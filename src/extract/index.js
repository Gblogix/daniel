const config = require('../config');
const { readDocument } = require('./text');
const { extractRules, isValidContainer } = require('./rules');

/** Extract fields from one uploaded file. `docTypeHint` is what the uploader selected (optional). */
async function extractFile({ buffer, filename, mime, docTypeHint }) {
  let text = ''; let rows = null;
  try { ({ text, rows } = await readDocument(buffer, filename, mime)); } catch (e) { /* unreadable — AI may still help */ }
  let result = extractRules(text, { filename, rows });
  let method = 'rules';
  if (docTypeHint && docTypeHint !== 'AUTO') result.doc_type = docTypeHint;
  if (config.ai.enabled) {
    try {
      const ai = await require('./ai').extractAI({ buffer, filename, mime, text });
      if (ai) {
        result = mergeFieldwise(ai, result);
        if (docTypeHint && docTypeHint !== 'AUTO') result.doc_type = docTypeHint;
        method = 'ai';
      }
    } catch (e) {
      result.warnings.push(`AI extraction unavailable (${e.message}); used rule-based extraction`);
    }
  }
  if (!text.trim() && method === 'rules') {
    result.warnings.push('No readable text (scanned image?). Enter the details manually or enable AI extraction.');
  }
  return { ...result, method, warnings: result.warnings || [] };
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
  default: ['HBL', 'MBL', 'AWB', 'ISF', 'PL', 'CI', 'OTHER'],
  items: ['PL', 'CI'],
};
const SCALARS = ['mbl_no', 'hbl_no', 'mawb_no', 'hawb_no', 'carrier', 'vessel', 'voyage', 'flight_no', 'pol', 'pod',
  'place_of_delivery', 'etd', 'eta', 'shipper_name', 'consignee_name', 'notify_party', 'packages', 'package_unit',
  'weight_kg', 'cbm', 'chargeable_weight', 'commodity'];

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
  draft.items = itemDoc ? itemDoc.items : [];
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
