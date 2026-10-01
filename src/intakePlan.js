/**
 * How an upload becomes files (OPUS order: master first, houses under it):
 *   master — only the carrier's MB/L / MAWB: create or fill the master, no house file
 *   single — one house B/L (with or without its MB/L): one house file under the master (the usual review form)
 *   multi  — several house B/Ls: one house file per HB/L; each P/L / C/I / ISF goes to the house it belongs to
 *            (same HB/L no., or its invoice no. listed on that HB/L), the rest is picked on the review page
 */
const { mergeExtractions } = require('./extract/index');
const S = require('./shipments');

const key = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const exOf = (d) => { try { return { ...JSON.parse(d.extracted_json || '{}'), doc_type: d.doc_type }; } catch { return { doc_type: d.doc_type }; } };
const isHouseAwb = (ex) => ex.doc_type === 'AWB' && (ex.hawb_no || (ex.hbl_no && key(ex.hbl_no) !== key(ex.mbl_no || ex.mawb_no)));
const isMasterDoc = (ex) => ex.doc_type === 'MBL' || (ex.doc_type === 'AWB' && !isHouseAwb(ex));
const isHouseBl = (ex) => ex.doc_type === 'HBL' || isHouseAwb(ex);
const houseNo = (ex) => ex.hawb_no || ex.hbl_no || null;

function plan(docs) {
  const rows = docs.map((d) => ({ doc: d, ex: exOf(d) }));
  const master = rows.filter((r) => isMasterDoc(r.ex));
  let keys = [...new Map(rows.filter((r) => isHouseBl(r.ex) && houseNo(r.ex)).map((r) => [key(houseNo(r.ex)), houseNo(r.ex)])).values()];
  if (!keys.length) keys = [...new Map(rows.filter((r) => !isMasterDoc(r.ex) && r.ex.hbl_no && key(r.ex.hbl_no) !== key(r.ex.mbl_no)).map((r) => [key(r.ex.hbl_no), r.ex.hbl_no])).values()];
  if (!keys.length && master.length && master.length === rows.length) {
    return { kind: 'master', master: mergeExtractions(master.map((r) => r.ex)), masterDocs: master.map((r) => r.doc.id), houses: [], unassigned: [] };
  }
  if (keys.length <= 1) return { kind: 'single' };
  const houses = keys.map((hbl) => {
    const hb = rows.find((r) => isHouseBl(r.ex) && key(houseNo(r.ex)) === key(hbl));
    return { hbl, invoices: new Set((hb?.ex.invoice_refs || []).map(key)), docs: [] };
  });
  const unassigned = [];
  for (const r of rows) {
    if (isMasterDoc(r.ex)) continue;
    const h = houses.find((x) => r.ex.hbl_no && key(r.ex.hbl_no) === key(x.hbl))
      || houses.find((x) => r.ex.hawb_no && key(r.ex.hawb_no) === key(x.hbl))
      || houses.find((x) => r.ex.ci_invoice_no && x.invoices.has(key(r.ex.ci_invoice_no)));
    if (h) h.docs.push(r); else unassigned.push(r.doc.id);
  }
  const masterEx = master.map((r) => r.ex);
  const md = mergeExtractions(masterEx.length ? masterEx : houses.flatMap((h) => h.docs.map((r) => r.ex)));
  // Several houses differ in HB/L, packages, weight and CBM by nature — not a warning on the master.
  md.warnings = md.warnings.filter((w) => !/^(hbl_no|packages|weight_kg|cbm|hawb_no) differs/.test(w));
  return {
    kind: 'multi',
    master: md,
    masterDocs: master.map((r) => r.doc.id),
    houses: houses.map((h) => ({ hbl: h.hbl, docIds: h.docs.map((r) => r.doc.id), draft: mergeExtractions([...masterEx, ...h.docs.map((r) => r.ex)]) })),
    unassigned,
  };
}

/** Form body for S.create / S.update / S.saveLines from a merged draft. */
function bodyFromDraft(d) {
  const b = {};
  for (const [k, v] of Object.entries(d)) if (S.EDITABLE_FIELDS.includes(k) && v != null && v !== '' && typeof v !== 'object') b[k] = v;
  if (d.freight_location && !b.cfs_location) b.cfs_location = d.freight_location;
  if (d.telex_release) b.telex_release = 1;
  const c = d.containers || []; const it = d.items || [];
  const col = (arr, k) => arr.map((x) => x[k] ?? '');
  Object.assign(b, { ctn_no: col(c, 'container_no'), ctn_seal: col(c, 'seal_no'), ctn_size: col(c, 'size_type'), ctn_pkgs: col(c, 'packages'), ctn_kg: col(c, 'weight_kg'), ctn_cbm: col(c, 'cbm') });
  if (it.length) Object.assign(b, { item_buyer: col(it, 'buyer'), item_inv: col(it, 'invoice_no'), item_po: col(it, 'po_no'), item_desc: col(it, 'description'), item_hs: col(it, 'hs_code'),
    item_qty: col(it, 'quantity'), item_unit: col(it, 'unit'), item_pkgs: col(it, 'packages'), item_kg: col(it, 'weight_kg'), item_cbm: col(it, 'cbm'), item_price: col(it, 'unit_price'), item_amount: col(it, 'amount') });
  return b;
}

module.exports = { plan, bodyFromDraft, isMasterDoc, isHouseBl };
