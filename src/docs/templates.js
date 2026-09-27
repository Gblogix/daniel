/**
 * Generated documents, modelled on what GB Logix sends today:
 *   A/N   — ARRIVAL NOTICE / FREIGHT INVOICE  (file ARRIVAL_NOTICE___FREIGHT_INVOICE_<ref>.pdf) → broker, customer, partner
 *   D/O   — DELIVERY ORDER                    (file Delivery_Order_<ref>.pdf)                   → trucker / warehouse, driver signs
 *   ATME  — AUTHORITY TO MAKE ENTRY           (file AUTH_HBL_<ref>.pdf)                         → broker / pickup trucker (air)
 * Layouts are generic until the company forms are loaded; field order follows the broker's correction requests
 * (weight must match the B/L, firms code, freight location, piece count).
 */
const config = require('../config');
const { MODES } = require('../shipments');

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const n = (v, d = 0) => (v == null || v === '' ? '' : Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
const lbs = (kg) => (kg == null ? '' : n(Number(kg) * 2.20462, 1));
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: config.timezone });

const DOC_TITLES = {
  AN: 'Arrival Notice / Freight Invoice',
  DO: 'Delivery Order',
  ATME: 'Authority to Make Entry',
};

/** Reference used in file names: MAWB digits for air, MBL without the carrier SCAC for ocean (e.g. SHZ8105615). */
function docRef(s) {
  if (s.mode === 'AIR') return String(s.mbl_no || s.ref_no).replace(/\D/g, '') || s.ref_no;
  const mbl = String(s.mbl_no || '').replace(/\s/g, '');
  if (!mbl) return s.hbl_no || s.ref_no;
  return /^[A-Z]{4}[A-Z0-9]{6,}$/.test(mbl) && /^(CMDU|HDMU|ONEY|MAEU|MEDU|MSCU|EGLV|COSU|OOLU|YMLU|ZIMU|HLCU|WHLC|SMLM|KMTU|SKLU)/.test(mbl) ? mbl.slice(4) : mbl;
}
const FILE_PREFIX = { AN: 'ARRIVAL_NOTICE___FREIGHT_INVOICE_', DO: 'Delivery_Order_', ATME: 'AUTH_HBL_' };
function fileName(type, s, revision = 0) {
  return `${FILE_PREFIX[type]}${docRef(s)}${revision ? (revision === 1 ? '_Rev' : `_Rev${revision}`) : ''}`;
}

function page(title, s, body, { revision = 0 } = {}) {
  const c = config.company;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)} — ${esc(docRef(s))}</title>
<style>
  @page { size: letter; margin: 12mm; }
  * { box-sizing: border-box; }
  body { font: 10.5px/1.4 Arial, Helvetica, sans-serif; color: #111; margin: 0; padding: 18px; }
  .head { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 3px solid #0b3d91; padding-bottom: 8px; margin-bottom: 10px; }
  .brand { font-size: 19px; font-weight: 700; color: #0b3d91; letter-spacing: .3px; }
  .muted { color: #444; }
  h1 { font-size: 16px; margin: 0; text-align: right; letter-spacing: .6px; }
  .rev { color: #b91c1c; font-weight: 700; }
  table { width: 100%; border-collapse: collapse; margin: 6px 0 10px; }
  th, td { border: 1px solid #888; padding: 4px 6px; text-align: left; vertical-align: top; }
  th { background: #eef2fa; font-size: 9px; text-transform: uppercase; letter-spacing: .3px; width: 18%; }
  .grid th { width: auto; }
  .num { text-align: right; }
  .box { border: 1px solid #888; padding: 6px 8px; min-height: 54px; white-space: pre-line; }
  .two { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 8px; }
  .three { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; margin-bottom: 8px; }
  .label { font-size: 9px; font-weight: 700; text-transform: uppercase; color: #0b3d91; margin-bottom: 2px; letter-spacing: .3px; }
  .hl { background: #fff7d6; }
  .total td, .total th { font-weight: 700; font-size: 11.5px; background: #eef2fa; }
  .sign { margin-top: 26px; display: grid; grid-template-columns: repeat(3, 1fr); gap: 18px; }
  .sign div { border-top: 1px solid #111; padding-top: 3px; font-size: 9.5px; }
  .note { font-size: 9.5px; color: #222; border-top: 1px dashed #888; padding-top: 6px; margin-top: 10px; }
  .stamp { border: 2px solid #b91c1c; color: #b91c1c; display: inline-block; padding: 3px 8px; font-weight: 700; transform: rotate(-3deg); }
</style></head><body>
<div class="head">
  <div><div class="brand">${esc(c.name)}</div>
    <div class="muted">${esc(c.address)}<br>${c.phone ? `Tel ${esc(c.phone)} · ` : ''}${esc(c.email)}${c.dot ? ` · US DOT# ${esc(c.dot)}` : ''}</div></div>
  <div><h1>${esc(title.toUpperCase())}</h1>
    <div class="muted" style="text-align:right">Date: ${today()}<br>Our Ref: <b>${esc(s.ref_no)}</b>${revision ? `<br><span class="rev">REVISED${revision > 1 ? ` #${revision}` : ''}</span>` : ''}</div></div>
</div>
${body}
</body></html>`;
}

const isAir = (s) => s.mode === 'AIR';
const hblText = (s) => (s.direct_shipment || !s.hbl_no ? (isAir(s) ? 'DIRECT (no HAWB)' : 'DIRECT') : s.hbl_no);

function refsTable(s) {
  return `<table>
  <tr><th>${isAir(s) ? 'MAWB No.' : 'MB/L No.'}</th><td class="hl"><b>${esc(s.mbl_no)}</b></td><th>${isAir(s) ? 'HAWB No.' : 'HB/L No.'}</th><td><b>${esc(hblText(s))}</b></td></tr>
  <tr><th>${isAir(s) ? 'Airline' : 'Carrier'}</th><td>${esc(s.carrier)}</td><th>${isAir(s) ? 'Flight' : 'Vessel / Voyage'}</th><td>${esc(isAir(s) ? s.flight_no : [s.vessel, s.voyage].filter(Boolean).join(' / '))}</td></tr>
  <tr><th>${isAir(s) ? 'Origin' : 'Port of Loading'}</th><td>${esc(s.pol)}</td><th>${isAir(s) ? 'Destination' : 'Port of Discharge'}</th><td>${esc(s.pod)}</td></tr>
  <tr><th>ETD${s.atd ? ' / ATD' : ''}</th><td>${esc(s.etd)}${s.atd ? ` / ${esc(s.atd)}` : ''}</td><th>ETA${s.ata ? ' / ATA' : ''}</th><td class="hl"><b>${esc(s.eta)}${s.ata ? ` / ${esc(s.ata)}` : ''}</b></td></tr>
  <tr><th>Freight Location</th><td class="hl">${esc(s.cfs_location)}</td><th>Firms Code</th><td class="hl"><b>${esc(s.firms_code)}</b></td></tr>
  <tr><th>Last Free Day</th><td class="hl"><b>${esc(s.last_free_day)}</b></td><th>${isAir(s) ? 'Storage Begins' : 'Place of Delivery'}</th><td>${esc(isAir(s) ? s.storage_start : s.place_of_delivery)}</td></tr>
  ${s.entry_no || s.isf_no ? `<tr><th>Entry No.</th><td>${esc(s.entry_no)}</td><th>ISF / AMS</th><td>${esc(s.isf_no)}</td></tr>` : ''}
</table>`;
}

function cargoTable(s) {
  const rows = s.containers.length
    ? s.containers.map((c) => `<tr><td><b>${esc(c.container_no)}</b></td><td>${esc(c.seal_no)}</td><td>${esc(c.size_type)}</td>
        <td class="num">${n(c.packages)}</td><td class="num">${n(c.weight_kg, 2)}</td><td class="num">${n(c.cbm, 3)}</td></tr>`).join('')
    : `<tr><td colspan="3">${isAir(s) ? 'Loose — ' : 'LCL — '}${s.pallets ? `${n(s.pallets)} pallet(s)` : 'loose cargo'}</td><td class="num"></td><td class="num"></td><td class="num"></td></tr>`;
  return `<table class="grid">
  <tr><th>Container No.</th><th>Seal No.</th><th>Size/Type</th><th class="num">Pieces</th><th class="num">Gross Wt (KG)</th><th class="num">CBM</th></tr>
  ${rows}
  <tr class="total"><th colspan="3">Total${s.pallets ? ` — ${n(s.pallets)} pallet(s)` : ''}</th><td class="num">${n(s.packages)} ${esc(s.package_unit)}</td>
    <td class="num">${n(s.weight_kg, 2)} KG<br><span style="font-weight:400">${lbs(s.weight_kg)} LBS</span></td>
    <td class="num">${isAir(s) && s.chargeable_weight ? `C/W ${n(s.chargeable_weight, 1)} KG` : `${n(s.cbm, 3)} CBM`}</td></tr>
</table>
<div class="label">Description of Goods</div>
<div class="box" style="min-height:36px">${esc(s.commodity || s.items.map((i) => i.description).slice(0, 8).join('\n'))}</div>`;
}

function chargesTable(s) {
  const lines = s.charges || [];
  const total = lines.reduce((a, c) => a + (Number(c.amount) || 0), 0);
  return `<table class="grid" style="margin-top:10px">
  <tr><th style="width:70%">Charges</th><th class="num">Amount (USD)</th></tr>
  ${lines.length ? lines.map((c) => `<tr><td>${esc(c.description)}</td><td class="num">${n(c.amount, 2)}</td></tr>`).join('')
    : '<tr><td class="muted">Charges to follow</td><td></td></tr>'}
  <tr class="total"><th>Total Due${s.invoice_no ? ` — Invoice ${esc(s.invoice_no)}` : ''}</th><td class="num">$ ${n(lines.length ? total : s.invoice_amount, 2)}</td></tr>
</table>`;
}

function arrivalNotice(s, opts = {}) {
  return page(DOC_TITLES.AN, s, `
<div class="three">
  <div><div class="label">Shipper</div><div class="box">${esc(s.shipper_name)}${s.shipper_address ? `\n${esc(s.shipper_address)}` : ''}</div></div>
  <div><div class="label">Consignee</div><div class="box">${esc(s.consignee_name || s.customer_name)}</div></div>
  <div><div class="label">Notify Party</div><div class="box">${esc(s.notify_party || s.customer_name)}</div></div>
</div>
${refsTable(s)}
${cargoTable(s)}
${chargesTable(s)}
<div class="two">
  <div><div class="label">Customs Broker</div><div class="box" style="min-height:30px">${esc(s.broker_name)}</div></div>
  <div><div class="label">Payment</div><div class="box" style="min-height:30px">${esc(config.company.remit || `Please remit to ${config.company.name}. Quote our ref ${s.ref_no}.`)}</div></div>
</div>
<div class="note">Cargo is released upon receipt of all charges, customs clearance (1C) and ${isAir(s) ? 'airline release' : 'original / telex-released B/L'}.
Storage, demurrage and any exam (CES) fees after the last free day are for the consignee's account. Please check the firms code and freight location before
dispatching a driver. Questions: ${esc(config.company.email)} — ref ${esc(s.ref_no)}.</div>`, opts);
}

function deliveryOrder(s, opts = {}) {
  const deliverTo = [s.delivery_company_name || s.customer_name, s.delivery_address].filter(Boolean).join('\n');
  return page(DOC_TITLES.DO, s, `
<div class="two">
  <div><div class="label">To (Trucker)</div><div class="box">${esc(s.trucker_name)}</div></div>
  <div><div class="label">Pick up at</div><div class="box hl"><b>${esc(s.cfs_location || s.pod)}</b>${s.firms_code ? `\nFirms code: ${esc(s.firms_code)}` : ''}${s.css_no ? `\nCES / CSS#: ${esc(s.css_no)}` : ''}</div></div>
</div>
<div class="two">
  <div><div class="label">Deliver to</div><div class="box hl">${esc(deliverTo)}</div></div>
  <div><div class="label">Appointment</div><div class="box"><b>${esc(s.delivery_date)} ${esc(s.delivery_time)}</b>${s.pickup_appt ? `\nPickup appt: ${esc(String(s.pickup_appt).replace('T', ' '))}` : ''}${s.last_free_day ? `\nLFD: ${esc(s.last_free_day)}` : ''}</div></div>
</div>
<p>Please release the following cargo to the bearer of this Delivery Order. Customs status: <b>${esc(s.customs_status === 'RELEASED' ? 'RELEASED (1C)' : s.customs_status)}</b>${s.entry_no ? ` · Entry ${esc(s.entry_no)}` : ''}.</p>
${refsTable(s)}
${cargoTable(s)}
<div class="note"><b>Driver instructions:</b> present this D/O${isAir(s) ? ' and the ATME' : ''} at pickup; safety vest required at the CES / terminal.
Count pieces before release and note any shortage or damage below. Have the consignee sign on delivery and return the signed D/O (POD) to ${esc(config.company.email)}.</div>
<div class="sign"><div>Driver name / truck #</div><div>Pieces received / date & time</div><div>Consignee signature (POD)</div></div>`, opts);
}

function authorityToMakeEntry(s, opts = {}) {
  return page(DOC_TITLES.ATME, s, `
<div class="two">
  <div><div class="label">To</div><div class="box">${esc(s.broker_name || 'Customs Broker')}${s.trucker_name ? `\n& ${esc(s.trucker_name)} (pickup)` : ''}</div></div>
  <div><div class="label">Importer / Consignee</div><div class="box">${esc(s.consignee_name || s.customer_name)}</div></div>
</div>
<p>${esc(config.company.name)}, as ${isAir(s) ? 'consignee / agent on the air waybill' : 'party named on the bill of lading'}, hereby authorizes
<b>${esc(s.broker_name || 'the customs broker named above')}</b> to make customs entry, and the carrier / terminal to release the shipment below
to the importer of record <b>${esc(s.consignee_name || s.customer_name)}</b> or its designated trucker.</p>
${refsTable(s)}
${cargoTable(s)}
<div class="sign"><div>${esc(config.company.name)} — authorized signature</div><div>Name / title</div><div>Date</div></div>`, opts);
}

const GENERATORS = { AN: arrivalNotice, DO: deliveryOrder, ATME: authorityToMakeEntry };

module.exports = { GENERATORS, DOC_TITLES, FILE_PREFIX, esc, docRef, fileName, arrivalNotice, deliveryOrder, authorityToMakeEntry };
