/**
 * Generated documents: Arrival Notice (A/N), Delivery Order (D/O), Authority to Make Entry (ATME).
 * These are generic layouts; replace the body functions with the company forms when they are ready.
 * Each returns a standalone, print-ready HTML page (use the browser's "Save as PDF").
 */
const config = require('../config');
const { MODES } = require('../shipments');

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const n = (v, d = 0) => (v == null || v === '' ? '' : Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
const today = () => new Date().toISOString().slice(0, 10);

const DOC_TITLES = {
  AN: 'Arrival Notice',
  DO: 'Delivery Order',
  ATME: 'Authority to Make Entry',
};

function page(title, s, body) {
  const c = config.company;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)} — ${esc(s.ref_no)}</title>
<style>
  @page { size: letter; margin: 14mm; }
  body { font: 12px/1.45 Arial, Helvetica, sans-serif; color: #111; margin: 0; padding: 24px; }
  .head { display: flex; justify-content: space-between; border-bottom: 3px solid #0b3d91; padding-bottom: 10px; margin-bottom: 14px; }
  .brand { font-size: 20px; font-weight: 700; color: #0b3d91; }
  .muted { color: #555; }
  h1 { font-size: 18px; margin: 0; text-align: right; letter-spacing: .5px; }
  table { width: 100%; border-collapse: collapse; margin: 8px 0 14px; }
  th, td { border: 1px solid #999; padding: 5px 7px; text-align: left; vertical-align: top; }
  th { background: #eef2fa; font-size: 11px; text-transform: uppercase; width: 22%; }
  .grid th { width: auto; }
  .num { text-align: right; }
  .box { border: 1px solid #999; padding: 8px 10px; min-height: 60px; white-space: pre-line; }
  .two { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 12px; }
  .label { font-size: 11px; font-weight: 700; text-transform: uppercase; color: #0b3d91; margin-bottom: 3px; }
  .sign { margin-top: 40px; display: flex; justify-content: space-between; }
  .sign div { width: 45%; border-top: 1px solid #111; padding-top: 4px; }
  .note { font-size: 11px; color: #333; border-top: 1px dashed #999; padding-top: 8px; margin-top: 16px; }
</style></head><body>
<div class="head">
  <div><div class="brand">${esc(c.name)}</div>
    <div class="muted">${esc(c.address)}${c.phone ? ` · Tel ${esc(c.phone)}` : ''}<br>${esc(c.email)}</div></div>
  <div><h1>${esc(title.toUpperCase())}</h1><div class="muted" style="text-align:right">Date: ${today()}<br>Our Ref: ${esc(s.ref_no)}</div></div>
</div>
${body}
</body></html>`;
}

function shipmentTable(s) {
  const isAir = s.mode === 'AIR';
  return `<table>
  <tr><th>${isAir ? 'MAWB No.' : 'MB/L No.'}</th><td>${esc(s.mbl_no)}</td><th>${isAir ? 'HAWB No.' : 'HB/L No.'}</th><td>${esc(s.hbl_no)}</td></tr>
  <tr><th>Mode</th><td>${esc(MODES[s.mode]?.label || s.mode)}</td><th>${isAir ? 'Flight' : 'Vessel / Voyage'}</th><td>${esc(isAir ? s.flight_no : [s.vessel, s.voyage].filter(Boolean).join(' / '))}</td></tr>
  <tr><th>Port of Loading</th><td>${esc(s.pol)}</td><th>Port of Discharge</th><td>${esc(s.pod)}</td></tr>
  <tr><th>ETD</th><td>${esc(s.etd)}</td><th>ETA</th><td>${esc(s.eta)}</td></tr>
  <tr><th>Place of Delivery</th><td>${esc(s.place_of_delivery)}</td><th>CFS / Terminal</th><td>${esc(s.cfs_location)}</td></tr>
  <tr><th>Last Free Day</th><td>${esc(s.last_free_day)}</td><th>Carrier</th><td>${esc(s.carrier)}</td></tr>
</table>`;
}

function cargoTable(s) {
  const rows = s.containers.length
    ? s.containers.map((c) => `<tr><td>${esc(c.container_no)}</td><td>${esc(c.seal_no)}</td><td>${esc(c.size_type)}</td>
        <td class="num">${n(c.packages)}</td><td class="num">${n(c.weight_kg, 2)}</td><td class="num">${n(c.cbm, 3)}</td></tr>`).join('')
    : '<tr><td colspan="3">(Loose cargo)</td><td></td><td></td><td></td></tr>';
  return `<table class="grid">
  <tr><th>Container No.</th><th>Seal No.</th><th>Size/Type</th><th class="num">Packages</th><th class="num">Weight (KG)</th><th class="num">CBM</th></tr>
  ${rows}
  <tr><th colspan="3">Total</th><th class="num">${n(s.packages)} ${esc(s.package_unit)}</th><th class="num">${n(s.weight_kg, 2)}</th><th class="num">${n(s.cbm, 3)}</th></tr>
</table>
<div class="label">Description of Goods</div>
<div class="box">${esc(s.commodity || s.items.map((i) => i.description).slice(0, 8).join('\n'))}</div>`;
}

function arrivalNotice(s) {
  return page(DOC_TITLES.AN, s, `
<div class="two">
  <div><div class="label">Shipper</div><div class="box">${esc(s.shipper_name)}\n${esc(s.shipper_address)}</div></div>
  <div><div class="label">Consignee</div><div class="box">${esc(s.consignee_name || s.customer_name)}</div></div>
</div>
<div class="two">
  <div><div class="label">Notify Party</div><div class="box">${esc(s.notify_party || s.customer_name)}</div></div>
  <div><div class="label">Customs Broker</div><div class="box">${esc(s.broker_name)}</div></div>
</div>
${shipmentTable(s)}
${cargoTable(s)}
<table><tr><th>Freight / Charges</th><td>${s.invoice_amount != null ? `USD ${n(s.invoice_amount, 2)}` : 'See invoice'}</td><th>Invoice No.</th><td>${esc(s.invoice_no)}</td></tr></table>
<div class="note">Cargo will be released upon receipt of all charges, customs clearance, and original/telex-released B/L.
Storage and demurrage after the last free day are for the consignee's account. Please contact us with any questions quoting our reference ${esc(s.ref_no)}.</div>`);
}

function deliveryOrder(s) {
  return page(DOC_TITLES.DO, s, `
<div class="two">
  <div><div class="label">To (Trucker)</div><div class="box">${esc(s.trucker_name)}</div></div>
  <div><div class="label">Pick up at (CFS / Terminal)</div><div class="box">${esc(s.cfs_location || s.pod)}</div></div>
</div>
<div class="two">
  <div><div class="label">Deliver to</div><div class="box">${esc(s.delivery_company_name || s.customer_name)}\n${esc(s.delivery_address)}</div></div>
  <div><div class="label">Delivery Appointment</div><div class="box">${esc(s.delivery_date)} ${esc(s.delivery_time)}</div></div>
</div>
<p>Please release / deliver the following cargo to the party named above. Customs status: <b>${esc(s.customs_status)}</b>.</p>
${shipmentTable(s)}
${cargoTable(s)}
<div class="sign"><div>Issued by ${esc(config.company.name)}</div><div>Received by (signature / date)</div></div>`);
}

function authorityToMakeEntry(s) {
  return page(DOC_TITLES.ATME, s, `
<p>To: <b>${esc(s.broker_name || 'Customs Broker')}</b></p>
<p>We hereby authorize you to make customs entry for the shipment described below on behalf of the consignee
<b>${esc(s.consignee_name || s.customer_name)}</b>.</p>
${shipmentTable(s)}
${cargoTable(s)}
<div class="sign"><div>${esc(config.company.name)} (Authorized signature)</div><div>Date</div></div>`);
}

const GENERATORS = { AN: arrivalNotice, DO: deliveryOrder, ATME: authorityToMakeEntry };

module.exports = { GENERATORS, DOC_TITLES, esc, arrivalNotice, deliveryOrder, authorityToMakeEntry };
