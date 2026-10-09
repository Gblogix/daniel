/**
 * Company documents, laid out after the current GlobalBridge forms:
 *   AN    ARRIVAL NOTICE / FREIGHT INVOICE   ARRIVAL_NOTICE___FREIGHT_INVOICE_<HBL>.pdf
 *   DO    DELIVERY ORDER                     Delivery_Order _<HBL>.pdf
 *   ATME  AUTHORITY TO MAKE ENTRY            AUTH_HBL_<HAWB>.pdf   (issued in the consignee's name)
 *   AR    INVOICE (to customers)             AR_INV12214_<Customer>.pdf
 *   DN    DEBIT NOTE (to overseas agents)    DC_DCN11664-<Agent>.pdf
 * Company details (address, tel, bank / remittance text) come from the Company profile in admin settings.
 */
const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nl = (v) => esc(v).replace(/\n/g, '<br>');
const n = (v, d = 2) => (v == null || v === '' ? '' : Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
const lbs = (kg) => (kg == null || kg === '' ? '' : `${n(Number(kg) * 2.20462)} LBS`);
const addr = (v, name) => require('../address').tidy(v || '', name || '');
const up = (v) => esc(String(v ?? '').toUpperCase());
/** 2026-09-16 -> 09/16/2026 (forms use US dates) */
const us = (d) => (d && /^\d{4}-\d{2}-\d{2}/.test(d) ? `${d.slice(5, 7)}/${d.slice(8, 10)}/${d.slice(0, 4)}` : esc(d || ''));
/** 2026-09-19 -> Sep-19-2026 (invoice / debit note style) */
const mon = (d) => {
  if (!d) return '';
  const [y, m, dd] = d.slice(0, 10).split('-');
  return `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m) - 1]}-${dd}-${y}`;
};
const nowOffice = () => {
  const d = new Date();
  const date = d.toLocaleDateString('en-US', { timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const time = d.toLocaleTimeString('en-US', { timeZone: config.timezone, hour12: false, hour: '2-digit', minute: '2-digit' });
  return { date, time, iso: d.toLocaleDateString('en-CA', { timeZone: config.timezone }) };
};

let logos;
function logo(kind) {
  if (!logos) {
    const read = (f) => { try { return `data:image/png;base64,${fs.readFileSync(path.join(config.root, 'public', 'img', f)).toString('base64')}`; } catch { return ''; } };
    logos = { full: read('logo-full.png'), mark: read('logo-mark.png') };
  }
  return logos[kind];
}

const DOC_TITLES = {
  AN: 'Arrival Notice / Freight Invoice', DO: 'Delivery Order', ATME: 'Authority to Make Entry', AR: 'Invoice', DN: 'Debit Note',
};

const clean = (v) => String(v || '').replace(/[^A-Za-z0-9-]/g, '');
/** House B/L (or HAWB digits) is the document reference, as on the current forms. */
function docRef(s) {
  if (s.mode === 'AIR') return clean(s.hbl_no && !s.direct_shipment ? s.hbl_no : s.mbl_no).replace(/-/g, '') || s.ref_no;
  return clean(s.hbl_no) || clean(s.mbl_no) || s.ref_no;
}
const FILE_PREFIX = { AN: 'ARRIVAL_NOTICE___FREIGHT_INVOICE_', DO: 'Delivery_Order _', ATME: 'AUTH_HBL_' };
function fileName(type, s, revision = 0) {
  return `${FILE_PREFIX[type]}${docRef(s)}${revision ? (revision === 1 ? '_Rev' : `_Rev${revision}`) : ''}`;
}
const shortName = (name) => String(name || '').replace(/\(.*?\)/g, '').replace(/,?\s*(INC|LLC|LTD|CO)\.?$/i, '').trim().split(/\s+/)[0].replace(/[^A-Za-z0-9가-힣]/g, '') || 'Customer';
function invoiceFileName(inv) {
  const who = inv.company_short_name || shortName(inv.company_name);
  return inv.kind === 'DN' ? `DC_${clean(inv.number).replace(/-/g, '')}-${who}` : `AR_${clean(inv.number).replace(/-/g, '')}_${who}`;
}

const BASE_CSS = `
  @page { size: letter; margin: 10mm; }
  * { box-sizing: border-box; }
  body { font: 10px/1.3 Arial, Helvetica, sans-serif; color: #000; margin: 0; }
  table { border-collapse: collapse; width: 100%; }
  .b td, .b th { border: 1px solid #000; }
  td, th { padding: 2px 4px; vertical-align: top; text-align: left; }
  .lbl { font-size: 8.5px; font-style: italic; display: block; text-transform: uppercase; }
  .val { font-size: 11px; font-weight: 700; display: block; min-height: 13px; }
  .big { font-size: 13px; }
  .r { text-align: right; } .c { text-align: center; }
  .title { text-align: center; font-size: 19px; font-weight: 700; letter-spacing: .3px; margin: 10px 0 8px; }
  .small { font-size: 8px; }
  .nob td { border: none; }
`;
const doc = (title, css, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>${BASE_CSS}${css || ''}</style></head><body>${body}</body></html>`;
const cell = (label, value, attrs = '') => `<td ${attrs}><span class="lbl">${esc(label)}</span><span class="val">${value || ''}</span></td>`;

function remitBlock(co) {
  return co.remit ? nl(co.remit) : '<span style="color:#b91c1c">Payment instructions not set — Admin › Company profile</span>';
}

// ---------------------------------------------------------------------------------------------------------------
// ARRIVAL NOTICE / FREIGHT INVOICE
function arrivalNotice(s, { company: co, preparedBy = '', revision = 0, invoice: inv = null, prices = true } = {}) {
  // Without prices (chosen in the send window): the charges box stays empty.
  const invoice = prices ? inv : null;
  const t = nowOffice();
  const air = s.mode === 'AIR';
  const ctnRows = s.containers.length ? s.containers : [{}];
  const sizes = {};
  for (const c of s.containers) if (c.size_type) sizes[c.size_type] = (sizes[c.size_type] || 0) + 1;
  const sizeText = Object.entries(sizes).map(([k, v]) => `${k} X ${v}`).join('<br>');
  const lines = !prices ? [] : invoice?.lines?.length ? invoice.lines : (s.charges || []).map((c) => ({ description: c.description, amount: c.amount }));
  const total = invoice ? invoice.total : lines.reduce((a, l) => a + (Number(l.amount) || 0), 0);
  const body = `
<table class="nob"><tr>
  <td style="width:26%">${logo('full') ? `<img src="${logo('full')}" style="height:52px">` : ''}</td>
  <td class="c"><div style="font-size:20px;font-weight:700">${esc(co.name)}</div>
    <div>${esc(co.address)}</div><div>Prepared by ${esc(preparedBy)} &nbsp; ${t.date} ${t.time}</div>
    <div>TEL: ${esc(co.accounting_tel || co.tel)} FAX: ${esc(co.fax)} EMAIL: ${esc(co.accounting_email || co.email)}</div></td>
  <td style="width:26%" class="r">${revision ? `<b style="color:#b91c1c">REVISED${revision > 1 ? ` #${revision}` : ''}</b>` : ''}</td>
</tr></table>
<div class="title">ARRIVAL NOTICE / FREIGHT INVOICE</div>
<table class="b" style="table-layout:fixed">
  <colgroup><col style="width:45%"><col style="width:13%"><col style="width:13%"><col style="width:16%"><col style="width:13%"></colgroup>
  <tr><td rowspan="3"><span class="lbl">Shipper</span><span class="val">${up(s.shipper_name)}</span><b>${nl(String(addr(s.shipper_address, s.shipper_name)).toUpperCase())}</b></td>
    ${cell(air ? 'MASTER AWB NO.' : 'MASTER B/L NO.', up(s.mbl_no), 'colspan="2" class="big"')}${cell(air ? 'HOUSE AWB NO.' : 'HOUSE B/L NO.', up(s.direct_shipment ? '' : s.hbl_no), 'colspan="2"')}</tr>
  <tr>${cell('FILING NO.', esc(s.ref_no), 'colspan="2"')}${cell('CUSTOMER REFERENCE NO.', esc(s.customer_ref), 'colspan="2"')}</tr>
  <tr>${cell(air ? 'AMS AWB NO.' : 'AMS B/L NO.', esc(s.ams_bl_no), 'colspan="2"')}${cell('ISF NO.', esc(s.isf_no), 'colspan="2"')}</tr>
  <tr><td rowspan="3"><span class="lbl">Consignee</span><span class="val">${up(s.consignee_name || s.customer_name)}</span><b>${nl(String(addr(s.consignee_address, s.consignee_name || s.customer_name)).toUpperCase())}</b></td>
    ${cell(air ? 'FLIGHT INFO.' : 'VESSEL INFO.', up(air ? s.flight_no : [s.vessel, s.voyage].filter(Boolean).join(' ')), 'colspan="2"')}${cell('SUB B/L NO.', esc(s.sub_bl_no), 'colspan="2"')}</tr>
  <tr>${cell(air ? 'AIRPORT OF DEPARTURE' : 'PORT OF LOADING', up(s.pol), 'colspan="3"')}${cell(s.atd ? 'ATD' : 'ETD', us(s.atd || s.etd))}</tr>
  <tr>${cell(air ? 'AIRPORT OF DESTINATION' : 'PORT OF DISCHARGE', up(s.pod), 'colspan="3"')}${cell(s.ata ? 'ATA' : 'ETA', us(s.ata || s.eta))}</tr>
  <tr><td rowspan="3"><span class="lbl">Notify Party</span><span class="val">${up(s.notify_party || 'SAME AS CONSIGNEE')}</span><b>${nl(String(addr(s.notify_address, s.notify_party)).toUpperCase())}</b></td>
    ${cell('PLACE OF DELIVERY', up(s.place_of_delivery), 'colspan="3"')}${cell('ETA', us(s.place_of_delivery ? s.eta : s.eta))}</tr>
  <tr>${cell('FINAL DESTINATION', up(s.final_destination), 'colspan="3"')}${cell('ETA', us(s.eta))}</tr>
  <tr>${cell('I.T. NO. & PLACE', esc([s.it_no, s.it_place].filter(Boolean).join(' / ')), 'colspan="3"')}${cell('I.T. DATE', us(s.it_date))}</tr>
  <tr><td rowspan="3"><span class="lbl">Customs Broker</span><span class="val">${up(s.broker_name)}</span></td>
    ${cell(air ? 'TERMINAL' : 'DEVAN LOCATION', up(s.devan_location), 'colspan="4"')}</tr>
  <tr>${cell('FREIGHT LOCATION', `${up(s.cfs_location)}${s.cfs_address ? `<br>${nl(String(s.cfs_address).toUpperCase())}` : ''}${s.freight_location_tel ? ` T : ${esc(s.freight_location_tel)}` : ''}`, 'colspan="4"')}</tr>
  <tr>${cell('FIRMS CODE', up(s.firms_code))}${cell('AVAILABLE DATE', us(s.available_date))}${cell('LAST FREE DATE', us(s.last_free_day))}${cell('G.O. DATE', us(s.go_date), 'colspan="2"')}</tr>
</table>
<table style="margin-top:4px">
  <tr style="border-bottom:1px solid #000" class="small"><td style="width:22%">CONTAINER NO./SEAL NO.<br>MARKS &amp; NUMBERS</td><td style="width:14%">NO.OF PACKAGES<br>NO. OF CONTAINERS</td>
    <td>DESCRIPTION OF GOODS</td><td class="r" style="width:15%">WEIGHT</td><td class="r" style="width:13%">MEASUREMENT</td></tr>
  ${ctnRows.map((c, i) => `<tr><td><b>${esc(c.container_no || '')}${c.seal_no ? `/${esc(c.seal_no)}` : ''}</b></td>
    <td><b>${i === 0 ? `${n(s.packages, 0)} ${esc(s.package_unit || 'PACKAGE(S)')}` : ''}</b></td>
    <td><b>${i === 0 ? `${up(s.commodity || s.items.map((it) => it.description).slice(0, 4).join(', '))}<br>${n(s.packages, 0)} ${esc(s.package_unit || 'PACKAGE(S)')}` : ''}</b></td>
    <td class="r"><b>${i === 0 ? `${n(s.weight_kg)} KGS<br>${lbs(s.weight_kg)}` : ''}</b></td><td class="r"><b>${i === 0 ? (air && s.chargeable_weight ? `C/W ${n(s.chargeable_weight)} KGS<br>${lbs(s.chargeable_weight)}` : `${n(s.cbm, 3)} CBM`) : ''}</b></td></tr>`).join('')}
  <tr><td></td><td><b>${sizeText}</b></td><td>${nl(String(s.marks || '').toUpperCase())}</td>
    <td colspan="2" class="r"><b>${up(s.release_type || (s.telex_release ? 'EXPRESS RELEASE' : ''))}</b><br><br><b>${up(s.service_term)}</b></td></tr>
</table>
<div style="height:14px"></div>
<table class="b"><tr><td style="width:7%"><b>REMARK</b></td><td style="height:34px">${nl(s.an_remark || '')}</td></tr></table>
<table class="b" style="margin-top:4px;table-layout:fixed">
  <tr><td rowspan="2" style="width:53%;font-size:8.5px">TO ALL CUSTOMERS:<br>
    1. PLEASE MAKE THE CHECK PAYABLE TO "${esc(co.legal_name)}"<br>
    2. WE WILL RELEASE THE FREIGHT UPON RECEIVING YOUR FULL PAYMENT AS SHOWN ABOVE AND YOUR PROPERLY ENDORSED ORIGINAL BILL OF LADING.<br>
    3. ALL STORAGE CHARGE AND DEMURRAGE CHARGES ARE FOR THE ACCOUNT OF THE ULTIMATE CONSIGNEE TO WHOM THIS FREIGHT IS RELEASED.<br>
    4. WE DO NOT ACCEPT FAXED COPIES OF ORIGINAL B/L OR FAXED COPIES OF CHECK FOR RELEASE.<br>
    5. PLEASE ALLOW MINIMUM OF 24 HOURS IN ORDER TO RELEASE THE SHIPMENT AFTER RECEIVING YOUR CHECK AND ORIGINAL B/L.<br>
    6. PLEASE CALL WAREHOUSE/TERMINAL FOR CARGO AVAILABILITY PRIOR TO PICK UP.<br>
    - IF FREIGHT HAS BEEN DAMAGED, YOU MUST FILE CLAIMS WITHIN 7 DAYS FROM DELIVERED DATE WITH ORIGINAL DOCUMENTS. OTHERWISE, YOUR CLAIMS WILL NOT BE PROCESSED AND WILL BE DECLINED.<br><br>
    ${remitBlock(co)}</td>
    <td style="padding:0">
      <table><tr><td style="font-size:11px"><b>Invoice No : ${esc(invoice?.number || '')}</b></td><td class="r" style="font-size:11px"><b>Due Date: ${invoice ? us(invoice.due_date) : ''}</b></td></tr></table>
      <table class="b" style="border-left:none"><tr><td class="c small" style="width:72%">DESCRIPTION OF CHARGES</td><td class="c small">Amount</td></tr>
      ${lines.map((l) => `<tr><td>${up(l.description)}</td><td class="r">${n(l.amount)}</td></tr>`).join('')}
      ${Array(Math.max(0, 10 - lines.length)).fill('<tr><td>&nbsp;</td><td></td></tr>').join('')}
      </table></td></tr>
  <tr><td style="padding:0"><table class="b"><tr><td class="c" style="width:72%"><b>TOTAL DUE</b></td><td class="r"><b>${lines.length ? n(total) : ''}</b></td></tr>
    <tr><td class="c"><b>PLEASE PAY THIS AMOUNT</b></td><td class="r"><b>${lines.length ? `USD ${n(total - (invoice?.paid_amount || 0))}` : ''}</b></td></tr></table></td></tr>
</table>`;
  return doc(`${DOC_TITLES.AN} ${s.hbl_no || s.mbl_no || ''}`, '', body);
}

// ---------------------------------------------------------------------------------------------------------------
// DELIVERY ORDER
function deliveryOrder(s, { company: co, preparedBy = '', revision = 0 } = {}) {
  const t = nowOffice();
  const air = s.mode === 'AIR';
  const pickup = s.mode === 'FCL' && s.devan_location ? s.devan_location : [s.cfs_location || s.devan_location || s.pod, s.cfs_location ? s.cfs_address : null].filter(Boolean).join('\n');
  const deliverTo = [s.delivery_company_name || s.customer_name, addr(s.delivery_address, s.delivery_company_name || s.customer_name)].filter(Boolean).join('\n');
  const body = `
<table style="table-layout:fixed"><tr>
  <td style="width:58%;border:1px solid #000;padding:6px"><div style="font-size:19px;font-weight:700">${esc(co.name)}</div>
    <div>${esc(co.address)}</div><div>TEL: ${esc(co.tel)} FAX: ${esc(co.fax)} EMAIL: ${esc(co.email)}</div></td>
  <td style="padding-left:14px"><table class="b"><tr>${cell('DATE', `<span class="c" style="display:block">${t.date}</span>`)}${cell('OUR FILING NO.', `<span class="c" style="display:block">${esc(s.ref_no)}</span>`)}</tr></table>
    <div style="margin-top:8px;font-size:9.5px">THE MERCHANDISE DESCRIBED BELOW<br>WILL BE ENTERED AND/OR FORWARDED AS FOLLOWS:</div>
    ${revision ? `<div style="color:#b91c1c;font-weight:700">REVISED${revision > 1 ? ` #${revision}` : ''}</div>` : ''}</td>
</tr></table>
<div class="title">DELIVERY ORDER</div>
<table class="b" style="table-layout:fixed">
  <colgroup><col style="width:49%"><col style="width:21%"><col style="width:12%"><col style="width:18%"></colgroup>
  <tr><td rowspan="3"><span class="lbl">Pickup</span><span class="val">${nl(String(pickup || '').toUpperCase())}</span>${s.firms_code ? `<b>FIRMS CODE: ${up(s.firms_code)}</b>` : ''}${s.css_no ? `<br><b>CES / CSS#: ${esc(s.css_no)}</b>` : ''}</td>
    ${cell('TRUCKER', `${up(s.trucker_name)}${s.service_term ? ` (${up(s.service_term.replace('CFS/CFS', 'CFS / CFS').replace('CY/CY', 'CY / CY'))})` : ''}`, 'colspan="3"')}</tr>
  <tr>${cell(air ? 'MAWB No.' : 'MB/L No.', up(s.mbl_no))}${cell(air ? 'HAWB No.' : 'HB/L No.', up(s.direct_shipment ? '' : s.hbl_no), 'colspan="2"')}</tr>
  <tr>${cell(air ? 'AMS AWB No.' : 'AMS B/L No.', esc(s.ams_bl_no))}${cell('CUSTOMER REFERENCE No.', esc(s.customer_ref), 'colspan="2"')}</tr>
  <tr><td rowspan="3"><span class="lbl">Delivery ( Appointment is required prior delivery )</span><span class="val">${nl(deliverTo.toUpperCase())}</span>
      ${s.delivery_date ? `<b>APPT: ${us(s.delivery_date)} ${esc(s.delivery_time || '')}</b>` : ''}</td>
    ${cell('I.T. No. & PLACE', esc([s.it_no, s.it_place].filter(Boolean).join(' / ')))}${cell('DATE OF', us(s.ata || s.eta))}${cell('LAST FREE DATE', us(s.last_free_day))}</tr>
  <tr>${cell(air ? 'AIRLINE / FLIGHT' : 'CARRIER', up(air ? [s.carrier, s.flight_no].filter(Boolean).join(' / ') : [s.vessel, s.voyage].filter(Boolean).join(' / ')), 'colspan="3"')}</tr>
  <tr>${cell(air ? 'ORIGIN AIRPORT' : 'ORIGIN PORT', up(s.pol), 'colspan="3"')}</tr>
  <tr><td style="height:130px"><span class="lbl">Route</span>${nl(s.route_note || '')}</td>
    <td colspan="3" style="padding:0"><span class="lbl" style="padding:2px 4px">Container Information</span>
      <table class="small" style="font-size:8.5px"><tr style="border-bottom:1px solid #000"><td><i>CONTAINER No.</i></td><td><i>TYPE</i></td><td><i>SEAL No.</i></td><td><i>WEIGHT</i></td><td><i>PICKUP No.</i></td><td><i>LFD</i></td></tr>
      ${s.containers.map((c) => `<tr><td>${esc(c.container_no)}</td><td>${esc(c.size_type || '')}</td><td>${esc(c.seal_no || '')}</td><td>${c.weight_kg ? `${n(c.weight_kg)} K / ${n(c.weight_kg * 2.20462)} L` : ''}</td><td>${esc(c.pickup_no || '')}</td><td>${us(c.pickup_lfd)}</td></tr>`).join('')}
      ${!s.containers.length && s.pallets ? `<tr><td colspan="6">${n(s.pallets, 0)} PALLET(S)</td></tr>` : ''}</table></td></tr>
</table>
<table class="b" style="margin-top:6px">
  <tr style="background:#ccc"><th class="c" style="width:21%">MARK</th><th class="c">DESCRIPTION</th><th class="c" style="width:12%">PKGS</th><th class="c" style="width:14%">WEIGHT</th><th class="c" style="width:14%">MEASURMENT</th></tr>
  <tr style="height:130px"><td>${nl(String(s.marks || '').toUpperCase())}</td><td>${up(s.commodity || s.items.map((i) => i.description).join(', '))}</td>
    <td class="r">${n(s.packages, 0)}<br>${esc(s.package_unit || 'PACKAGE(S)')}</td><td class="r">${n(s.weight_kg)} KGS<br>${lbs(s.weight_kg)}</td><td class="r">${air && s.chargeable_weight ? `C/W ${n(s.chargeable_weight)} KGS<br>${lbs(s.chargeable_weight)}` : `${n(s.cbm, 3)} CBM`}</td></tr>
</table>
<table style="margin-top:6px;table-layout:fixed"><tr>
  <td style="width:50%"><b>ORIGINAL DELIVERY ORDER</b><br><b>INLAND FREIGHT :</b> &nbsp; PREPAID
    <table class="b" style="margin-top:4px"><tr><td><b>${esc(co.name)}</b></td></tr><tr><td>PREPARED BY &nbsp;&nbsp; ${esc(preparedBy)} &nbsp; ${t.date} ${t.time}</td></tr></table></td>
  <td style="padding-left:30px;font-size:10px">NOTICE: BAD ORDER PACKAGES MUST BE SIGNED FOR<br>AS IN CONDITION RECEIVED.<br>ALL PIER CHARGES FOR ACCOUNT OF RECEIVER UNLESS<br>OTHERWISE SPECIFIED.</td></tr></table>
<table style="margin-top:4px;table-layout:fixed"><tr>
  <td style="border:1px solid #000;padding:6px">CARRIER SIGNATURE / DATE<br><br>CARRIER : ______________________ Date : ________________</td><td style="width:20px"></td>
  <td style="border:1px solid #000;padding:6px">RECEIVED IN GOOD ORDER / DATE<br><br>BY : ______________________ Date : ________________</td></tr></table>
<table class="b" style="margin-top:6px"><tr><td style="width:7%;vertical-align:middle">REMARK</td><td style="height:110px">BAD ORDER PACKAGES MUST BE SIGNED FOR AS IN CONDITION RECEIVED. PROPERLY DOCUMENTED AND SIGNED POD REQUIRED. PLEASE EMAIL THE PROOF OF DELIVERY TO ${up(co.email)} REMARK: IF THE RECEIVING PARTY HAS PROBLEMS RECEIVING THE GOODS, PLEASE NOTIFY ${up(co.legal_name)} IMMEDIATELY. OTHERWISE, THE TRANSPORTATION COMPANY IS LIABLE FOR ANY ACCRUED CHARGES DUE.
  ${s.do_remark ? `<br><br>${nl(s.do_remark)}` : ''}</td></tr></table>`;
  return doc(`${DOC_TITLES.DO} ${s.hbl_no || s.mbl_no || ''}`, '', body);
}

// ---------------------------------------------------------------------------------------------------------------
// AUTHORITY TO MAKE ENTRY — issued on the consignee's letterhead, signed by the consignee as attorney-in-fact
function authorityToMakeEntry(s, { preparedBy = '' } = {}) {
  const t = nowOffice();
  const air = s.mode === 'AIR';
  const cons = s.consignee_name || s.customer_name || '';
  const lb = (kg) => (kg == null ? '' : `${n(Number(kg) * 2.20462, 3)} LBS`);
  const row = (a, b, c, d, e = '') => `<tr><td style="width:15%">${a}</td><td style="width:2%">:</td><td style="width:22%"><b>${b}</b></td><td style="width:15%">${c}</td><td style="width:2%">:</td><td><b>${d}</b></td><td class="r" style="width:22%">${e}</td></tr>`;
  const hr = '<div style="border-top:3px double #000;margin:6px 0"></div>';
  const body = `
<div class="c" style="font-size:14px">${up(cons)}</div><div class="c">${nl(String(addr(s.consignee_address, s.consignee_name || s.customer_name)).toUpperCase())}</div>
<div class="title" style="font-size:20px;margin-top:16px">AUTHORITY TO MAKE ENTRY</div>${hr}
<table><tr><td style="width:33%">SHIPPER :<br><b>${up(s.shipper_name)}<br>${nl(String(addr(s.shipper_address, s.shipper_name)).toUpperCase())}</b></td>
  <td style="width:34%">CONSIGNEE :<br><b>${up(cons)}<br>${nl(String(addr(s.consignee_address, s.consignee_name || s.customer_name)).toUpperCase())}</b></td>
  <td>NOTIFY PARTY :<br><b>${up(s.notify_party || 'SAME AS CONSIGNEE')}</b></td></tr></table>${hr}
<table><tr><td>Merchandise Imported at</td><td><b>${up(s.pod)}</b></td><td>on</td><td><b>${us(s.ata || s.eta)}</b></td><td>Via</td><td><b>${up(s.carrier || s.vessel)}</b></td></tr></table>${hr}
<table>
  ${row('FILING NO.', esc(s.ref_no), 'DATE', t.date)}
  ${row(air ? 'MAWB NO.' : 'MB/L NO.', up(s.mbl_no), 'PREP. BY', esc(preparedBy))}
  ${row(air ? 'SUB-AWB NO.' : 'SUB B/L NO.', esc(s.sub_bl_no), air ? 'DEP. AIRPORT' : 'PORT OF LOADING', up(s.pol), `${s.atd ? 'ATD' : 'ETD'} : <b>${us(s.atd || s.etd)}</b>`)}
  ${row(air ? 'HAWB NO.' : 'HB/L NO.', up(s.direct_shipment ? docRef(s) : s.hbl_no), 'ENTRY PORT', up(s.it_place), `ETA : <b>${us(s.eta)}</b>`)}
  ${row('MANIFEST NO.', esc(s.ams_bl_no), air ? 'DEST. AIRPORT' : 'PORT OF DISCHARGE', up(s.pod), `ETA : <b>${us(s.ata || s.eta)}</b>`)}
  ${row(air ? 'FLIGHT NO.' : 'VESSEL / VOY.', up(air ? s.flight_no : [s.vessel, s.voyage].filter(Boolean).join(' ')), 'FINAL DEST.', up(s.final_destination || s.pod), `ETA : <b>${us(s.eta)}</b>`)}
  <tr><td colspan="3"></td><td colspan="4">EFFECTIVE STORAGE DATE : <b>${us(s.storage_start)}</b></td></tr>
</table>${hr}
<table>
  <tr><td style="width:15%">FREIGHT LOC.</td><td style="width:2%">:</td><td style="width:40%"><b>${up(s.cfs_location)}</b>${s.cfs_address ? `<br>${nl(String(s.cfs_address).toUpperCase())}` : ''}</td><td style="width:15%">I.T.NO.</td><td>: <b>${esc(s.it_no)}</b></td></tr>
  <tr><td></td><td></td><td>Tel: ${esc(s.freight_location_tel)} &nbsp;&nbsp;&nbsp;&nbsp; Fax:</td><td>I.T.ISSUE PLACE</td><td>: <b>${up(s.it_place)}</b></td></tr>
  <tr><td>FIRM CODE</td><td>:</td><td><b>${up(s.firms_code)}</b></td><td>I.T.DATE</td><td>: <b>${us(s.it_date)}</b></td></tr>
</table>
<table style="border-top:2px solid #000;border-bottom:1px solid #000;margin-top:4px"><tr><th style="width:22%">MARKS</th><th style="width:20%">PACKAGE</th><th>DESCRIPTION</th><th class="r" style="width:16%">Gros. WEIGHT</th><th class="r" style="width:16%">Vol. WEIGHT</th></tr></table>
<table style="height:90px"><tr><td style="width:22%">${nl(String(s.marks || '').toUpperCase())}</td><td style="width:20%"><b>${n(s.packages, 0)} ${up(s.package_unit === 'CTNS' ? 'CARTON(S)' : s.package_unit || 'PACKAGE(S)')}</b></td>
  <td><b>${up(s.commodity || s.items.map((i) => i.description).join(', '))}</b></td>
  <td class="r" style="width:16%"><b>${n(s.weight_kg, 3)} KGS<br>${lb(s.weight_kg)}</b></td>
  <td class="r" style="width:16%"><b>${n(s.chargeable_weight || s.weight_kg, 3)} KGS<br>${lb(s.chargeable_weight || s.weight_kg)}</b></td></tr></table>
<div style="border-top:3px double #000;margin-top:10px"></div><div class="c"><b>REMARK</b></div><div style="border-top:1px solid #000;height:56px"></div>
<div style="border-top:3px double #000;margin-top:4px;padding-top:10px;font-style:italic;line-height:2.1">
  <b>WE,</b> &nbsp;&nbsp;&nbsp;<span style="font-style:normal;border-bottom:1px solid #000;display:inline-block;min-width:60%">${up(cons)}</span> ,<br>
  THE CONSIGNEE FOR ABOVE MENTIONED BILL OF LADING COVERING<br>MERCHANDISE FOR VARIOUS ULTIMATE CONSIGNEE, HEREBY AUTHORIZES<br>
  <span style="font-style:normal;border-bottom:1px solid #000;display:inline-block;min-width:44%">${up(s.broker_name)}</span> TO MAKE CUSTOMS<br>
  ENTRY FOR THE ABOVE DESCRIBED MERCHANDISE.</div>
<div style="margin:6px 0 0 60px;width:50%;text-align:center"><div style="border-bottom:1px solid #000;padding:14px 0 2px">${up(cons)}</div>
  <div style="border-bottom:1px solid #000;height:26px"></div><div style="padding-top:4px">Attorney - In - Fact</div></div>
<table style="border:1px solid #000;margin-top:10px"><tr><td style="height:34px;width:50%">DOCUMENT PICKED BY :</td><td style="width:25%">DATE :</td><td>TIME :</td></tr></table>`;
  return doc(`${DOC_TITLES.ATME} ${docRef(s)}`, '', body);
}

// ---------------------------------------------------------------------------------------------------------------
// AR INVOICE and DEBIT NOTE share the header / reference block
function invoiceHeader(co, title, numLabel, number) {
  return `<table class="nob"><tr>
  <td style="width:62%"><table class="nob"><tr><td style="width:60px">${logo('mark') ? `<img src="${logo('mark')}" style="height:52px">` : ''}</td>
    <td><div style="font-size:17px;font-weight:700">${esc(co.name)}</div><div style="font-size:10.5px">${esc(co.address)}<br>TEL: ${esc(co.tel)} FAX: ${esc(co.fax)}<br>EMAIL: ${esc(co.email)}</div></td></tr></table></td>
  <td class="r"><div style="font-size:26px;font-weight:700">${title}</div><div style="font-size:14px;font-weight:700;margin-top:14px">${numLabel} : ${esc(number)}</div></td></tr></table>`;
}
function refBlock(s, inv, leftExtra = '') {
  const air = s?.mode === 'AIR';
  const kv = (k, v) => `<tr><td style="width:36%">${k}</td><td style="width:4%">:</td><td>${v || ''}</td></tr>`;
  const ctn = s ? (s.containers.length ? s.containers.map((c) => c.container_no).join(', ') : '') : '';
  return `<table style="margin-top:6px;table-layout:fixed"><tr><td style="padding:0"><table>
    ${leftExtra}
    ${kv(air ? 'MASTER AWB NO.' : 'MASTER B/L NO.', up(s?.mbl_no))}${kv(air ? 'HOUSE AWB NO.' : 'HOUSE B/L NO.', up(s?.hbl_no))}
    ${kv('Vessel(Flight) NO.', up(air ? s?.flight_no : [s?.vessel, s?.voyage].filter(Boolean).join(' ')))}
    ${kv('POL / ETD', s ? `${up(s.pol)}${s.etd ? ` / ${us(s.etd)}` : ''}` : '')}${kv('POD / ETA', s ? `${up(s.pod)}${s.eta ? ` / ${us(s.eta)}` : ''}` : '')}
    ${kv('F.DEST. / ETA', s?.final_destination ? `${up(s.final_destination)} / ${us(s.eta)}` : '')}${kv('COMMODITY', up(s?.commodity))}</table></td>
  <td style="padding:0"><table>
    ${kv('NO. OF PKGS', s?.packages ? `${n(s.packages, 0)} ${esc(s.package_unit || '')}` : '')}
    ${kv('KGS / LBS', s?.weight_kg ? `${n(s.weight_kg)} / ${n(s.weight_kg * 2.20462)}` : '')}
    ${kv('CBM / CFT', s?.cbm ? `${n(s.cbm, 3)} / ${n(s.cbm * 35.3147)}` : '')}
    ${kv('CNTR. NO.', esc(ctn || inv.cntr_text || ''))}${kv('SHIPPER', up(s?.shipper_name))}${kv('CONSIGNEE', up(s?.consignee_name))}${kv('NOTIFY', up(s?.notify_party))}</table></td></tr></table>`;
}

function arInvoice(inv, { company: co, shipment: s = null, preparedBy = '' } = {}) {
  const box = (k, v) => `<tr><td style="width:48%;font-weight:700;font-size:11px">${k}</td><td style="font-size:11px">${v || ''}</td></tr>`;
  const lines = inv.lines || [];
  const body = `${invoiceHeader(co, 'INVOICE', 'INVOICE No.', inv.number)}
<table style="margin-top:10px;table-layout:fixed;border-bottom:1px solid #000"><tr>
  <td style="width:57%"><table class="nob"><tr><td style="width:18%">Bill To :</td><td>${nl(String(inv.bill_to || '').toUpperCase())}</td></tr>
    <tr><td style="padding-top:18px">Attn To :</td><td style="padding-top:18px">${up(inv.attn)}</td></tr>
    <tr><td>Ship To :</td><td>${up(inv.ship_to || (inv.bill_to || '').split('\n')[0])}</td></tr></table></td>
  <td><table class="b">${box('INVOICE DATE', mon(inv.invoice_date))}${box('TERMS', `${inv.terms_days} days`)}${box('DUE DATE', mon(inv.due_date))}
    ${box('OUR FILING NO.', esc(s?.ref_no || inv.filing_no || ''))}${box('Customer Ref. No.', esc(inv.customer_ref || s?.customer_ref || ''))}</table></td></tr></table>
${refBlock(s, inv)}
<table style="margin-top:10px"><tr style="border-top:1px solid #000;border-bottom:1px solid #000"><th>DESCRIPTION OF CHARGES</th><th class="r" style="width:10%">UNIT</th><th class="r" style="width:14%">RATE</th><th class="r" style="width:9%">QTY</th><th class="r" style="width:14%">AMOUNT</th></tr>
  ${lines.map((l) => `<tr><td>${up(l.description)}</td><td class="r">${esc(l.unit || '')}</td><td class="r">${l.rate != null ? n(l.rate, 3) : ''}</td><td class="r">${l.qty != null ? n(l.qty, 0) : ''}</td><td class="r">${n(l.amount)}</td></tr>`).join('')}
</table>
<div style="min-height:${Math.max(40, 300 - lines.length * 18)}px"></div>
<table style="border-top:1px solid #000"><tr><td style="width:46%"></td><td class="r"><b>TOTAL DUE</b></td><td style="width:10%"></td><td class="r" style="width:16%"><b>${n(inv.total)}</b></td></tr>
  <tr><td></td><td class="r"><b>PAID AMOUNT</b></td><td></td><td class="r"><b>${n(inv.paid_amount || 0)}</b></td></tr>
  <tr><td></td><td class="r" style="white-space:nowrap"><b>PLEASE PAY THIS AMOUNT</b></td><td class="c"><b>${esc(inv.currency || 'USD')}</b></td><td class="r"><b>${n(inv.total - (inv.paid_amount || 0))}</b></td></tr></table>
<table class="b" style="margin-top:10px"><tr><td class="c" style="width:9%;vertical-align:middle"><b>MEMO</b></td><td style="height:48px;font-size:11px">${nl(inv.memo || '')}</td></tr>
  <tr><td class="c" style="vertical-align:middle"><b>REMARK</b></td><td class="small">${remitBlock(co)}</td></tr></table>
<table style="margin-top:6px"><tr><td style="width:45%;border-bottom:1px solid #000"></td><td></td><td class="c" style="width:40%;border-bottom:1px solid #000">${esc(preparedBy)}</td></tr>
  <tr><td class="c"><b>${esc(co.name)}</b></td><td></td><td class="c"><b>PREPARED BY</b></td></tr></table>`;
  return doc(`${DOC_TITLES.AR} ${inv.number}`, '', body);
}

function debitNote(inv, { company: co, shipment: s = null } = {}) {
  const lines = inv.lines || [];
  const debit = lines.filter((l) => l.side !== 'CREDIT').reduce((a, l) => a + (Number(l.amount) || 0), 0);
  const credit = lines.filter((l) => l.side === 'CREDIT').reduce((a, l) => a + (Number(l.amount) || 0), 0);
  const balance = Math.round((debit - credit) * 100) / 100;
  const isCredit = balance < 0;
  const box = (k, v, cls = '') => `<tr><td style="width:40%;font-weight:700;font-size:11px">${k}</td><td class="${cls}" style="font-size:11px">${v || ''}</td></tr>`;
  const agentName = (inv.bill_to || '').split('\n')[0];
  const body = `${invoiceHeader(co, isCredit ? 'CREDIT NOTE' : 'DEBIT NOTE', 'D/C No.', inv.number)}
<table style="margin-top:12px;table-layout:fixed"><tr>
  <td style="width:57%"><table class="nob"><tr><td style="width:16%">AGENT :</td><td style="font-size:11px">${nl(String(inv.bill_to || '').toUpperCase())}</td></tr></table></td>
  <td><table class="b">${box('D/C DATE', mon(inv.invoice_date))}${box('TERMS', `${inv.terms_days} days`)}${box('DUE DATE', mon(inv.due_date))}
    ${box('PROFIT SHARE', `${n(inv.profit_share || 0, 0)} %`)}${box('CURRENCY', esc(inv.currency || 'USD'))}${box('TOTAL AMOUNT', n(Math.abs(balance)), 'r')}</table></td></tr></table>
${refBlock(s, inv, `<tr><td style="width:36%">OUR FILING NO.</td><td style="width:4%">:</td><td>${esc(s?.ref_no || inv.filing_no || '')}</td></tr>
  <tr><td>AGENT FILING NO.</td><td>:</td><td>${esc(inv.agent_ref || s?.agent_ref || '')}</td></tr>`)}
<table class="b" style="margin-top:10px"><tr><th class="c" style="width:5%">M/H</th><th class="c" style="width:13%">BL NO</th><th class="c">DESCRIPTION</th><th class="c" style="width:7%">UNIT</th>
  <th class="c" style="width:8%">RATE</th><th class="c" style="width:5%">QTY</th><th class="c" style="width:9%">REV/COST</th><th class="c" style="width:4%">P/C</th><th class="c" style="width:10%">DEBIT(+)</th><th class="c" style="width:10%">CREDIT(-)</th></tr>
  ${lines.map((l) => `<tr><td class="c">${esc(l.mh || 'M')}</td><td>${esc(l.bl_no || '')}</td><td>${up(l.description)}</td><td>${esc(l.unit || '')}</td>
    <td class="r">${l.rate != null ? n(l.rate, 3) : ''}</td><td class="r">${l.qty != null ? n(l.qty, 0) : ''}</td><td class="r">${n(l.amount)}</td><td class="c">${esc(l.pc || 'C')}</td>
    <td class="r">${l.side === 'CREDIT' ? '' : n(l.amount)}</td><td class="r">${l.side === 'CREDIT' ? n(l.amount) : ''}</td></tr>`).join('')}
</table>
<div style="min-height:${Math.max(40, 330 - lines.length * 18)}px"></div>
<table style="border-top:1px solid #000"><tr><td style="width:60%" class="r"><b>TOTAL</b></td><td></td><td class="r" style="width:13%"><b>${n(debit)}</b></td><td class="r" style="width:13%"><b>${n(credit)}</b></td></tr></table>
<table style="border-top:1px solid #000;border-bottom:3px double #000"><tr><td style="font-size:12px"><b>GRAND TOTAL BALANCE DUE TO &nbsp;${isCredit ? up(agentName) : esc(co.name)}</b></td>
  <td class="c" style="width:12%"><b>${esc(inv.currency || 'USD')}</b></td><td class="r" style="width:16%;font-size:12px"><b>${n(Math.abs(balance))}</b></td></tr></table>
<table class="b" style="margin-top:14px"><tr><td class="c" style="width:12%;vertical-align:middle"><b>REMARK</b></td><td class="small" style="height:60px">${remitBlock(co)}</td></tr>
  <tr><td class="c" style="vertical-align:middle"><b>MEMO</b></td><td style="height:60px;font-size:11px">${nl(inv.memo || '')}</td></tr></table>`;
  return doc(`${isCredit ? 'Credit' : 'Debit'} Note ${inv.number}`, '', body);
}

// ---------------------------------------------------------------------------------------------------------------
// STATEMENT OF ACCOUNT (any party: customer, agent, vendor) — by invoice date or ETA
function statementOfAccount({ company: co, party, st }) {
  const S = require('../shipments');
  const basis = { invoice: 'INVOICE DATE', eta: 'ETA', due: 'DUE DATE' }[st.basis] || 'INVOICE DATE';
  const box = (k, v) => `<tr><td style="width:44%;font-weight:700;font-size:11px">${k}</td><td style="font-size:11px">${v || ''}</td></tr>`;
  const t = st.totals;
  const dueTo = t.open >= 0 ? co.name : party.name;
  const rows = st.items.map((i) => `<tr>
    <td>${us(i.basis_date)}</td><td>${esc(i.number)}</td><td>${esc(i.type)}</td>
    <td>${up(i.shipment_id ? S.fileName(i) : i.memo || '')}<div style="color:#555">${esc([i.hbl_no && `HBL ${i.hbl_no}`, i.mbl_no && `MBL ${i.mbl_no}`, i.agent_ref && `REF ${i.agent_ref}`].filter(Boolean).join(' / '))}</div></td>
    <td>${us(i.eta)}</td><td>${us(i.due_date)}</td>
    <td class="r">${i.debit ? n(i.debit) : ''}</td><td class="r">${i.credit ? n(i.credit) : ''}</td><td class="r">${i.paid_amount ? n(i.paid_amount) : ''}</td>
    <td class="r"><b>${n(i.open)}</b></td><td class="r">${n(i.running)}</td></tr>`).join('');
  const ag = st.aging;
  const body = `${invoiceHeader(co, 'STATEMENT OF ACCOUNT', 'AS OF', us(st.asOf))}
<table style="margin-top:10px;table-layout:fixed;border-bottom:1px solid #000"><tr>
  <td style="width:57%"><table class="nob"><tr><td style="width:14%">TO :</td><td style="font-size:11px">${nl(String([party.name, party.address].filter(Boolean).join('\n')).toUpperCase())}</td></tr></table></td>
  <td><table class="b">${box('BASIS', basis)}${box('PERIOD', st.from || st.to ? `${us(st.from) || '…'} – ${us(st.to) || '…'}` : 'ALL')}
    ${box('ITEMS', `${st.items.length} · ${st.status === 'open' ? 'OPEN ONLY' : 'ALL (INCL. SETTLED)'}`)}${box('CURRENCY', 'USD')}</table></td></tr></table>
<table class="b soa" style="margin-top:10px"><tr><th>${basis}</th><th>DOC NO.</th><th>TYPE</th><th>FILE / B/L</th><th>ETA</th><th>DUE</th>
  <th class="r">DEBIT(+)</th><th class="r">CREDIT(-)</th><th class="r">PAID</th><th class="r">OPEN</th><th class="r">BALANCE</th></tr>
  ${rows || '<tr><td colspan="11" class="c">No items</td></tr>'}
  <tr><td colspan="6" class="r"><b>TOTAL</b></td><td class="r"><b>${n(t.debit)}</b></td><td class="r"><b>${n(t.credit)}</b></td><td class="r"><b>${n(t.paid)}</b></td><td class="r"><b>${n(t.open)}</b></td><td></td></tr></table>
<table style="margin-top:8px;border-top:1px solid #000;border-bottom:3px double #000"><tr><td style="font-size:12px"><b>BALANCE DUE TO &nbsp;${up(dueTo)}</b></td>
  <td class="c" style="width:10%"><b>USD</b></td><td class="r" style="width:18%;font-size:13px"><b>${n(Math.abs(t.open))}</b></td></tr></table>
<table class="b" style="margin-top:10px"><tr><th class="c">CURRENT</th><th class="c">1–30 DAYS</th><th class="c">31–60 DAYS</th><th class="c">61–90 DAYS</th><th class="c">OVER 90</th></tr>
  <tr><td class="r">${n(ag.current)}</td><td class="r">${n(ag.d30)}</td><td class="r">${n(ag.d60)}</td><td class="r">${n(ag.d90)}</td><td class="r">${n(ag.d90p)}</td></tr></table>
<table class="b" style="margin-top:10px"><tr><td class="c" style="width:12%;vertical-align:middle"><b>REMARK</b></td><td class="small" style="height:54px">${remitBlock(co)}<br>
  + = amount due to ${esc(co.name)} · − = amount due to ${esc(party.name)}. Please advise of any discrepancy.</td></tr></table>`;
  return doc(`Statement of Account ${party.name}`, '.soa td,.soa th{font-size:9.5px;padding:3px 4px}@page{size:letter landscape;margin:10mm}', body);
}

const GENERATORS = { AN: arrivalNotice, DO: deliveryOrder, ATME: authorityToMakeEntry };
const INVOICE_GENERATORS = { AR: arInvoice, DN: debitNote };

module.exports = {
  GENERATORS, INVOICE_GENERATORS, DOC_TITLES, FILE_PREFIX, esc, docRef, fileName, invoiceFileName,
  arrivalNotice, deliveryOrder, authorityToMakeEntry, arInvoice, debitNote, statementOfAccount,
};
