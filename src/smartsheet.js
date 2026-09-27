/**
 * Smartsheet sync (sheets shared with customers, e.g. Unlockt).
 *  - Pull: each row becomes / updates a shipment (matched by HBL, MBL or container); row attachments
 *    (P/L, C/I, B/L …) are downloaded, stored as shipment documents and read by the document extractor.
 *  - Push (optional, off by default): ETA / status / delivery columns written back so the shared sheet stays current.
 * REST API 2.0 with a personal access token (SMARTSHEET_TOKEN). Sheets and column mapping: SMARTSHEET_SHEETS (JSON)
 * or Admin › Automation.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('./config');
const store = require('./db');
const S = require('./shipments');

const BASE = 'https://api.smartsheet.com/2.0';
let fetchImpl = (...a) => fetch(...a);
function setFetch(f) { fetchImpl = f; }

function token() { return process.env.SMARTSHEET_TOKEN || ''; }

async function api(pathname, { method = 'GET', body } = {}) {
  const res = await fetchImpl(BASE + pathname, {
    method,
    headers: { Authorization: `Bearer ${token()}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Smartsheet ${method} ${pathname.split('?')[0]}: ${data.message || res.status}`);
  return data;
}

/**
 * Sheet configs: [{ id, name, preset, customer, columns: { field: 'Column title' }, push }].
 * From SMARTSHEET_SHEETS / Admin setting, else discovered by sheet name (see NAME_RULES).
 */
function sheetConfigs(db = store.db) {
  try {
    return JSON.parse(db.setting('smartsheet_sheets') || process.env.SMARTSHEET_SHEETS || '[]');
  } catch { return []; }
}

// Current sheets in the "Logistics" workspace and how each is read.
const NAME_RULES = [
  { re: /^Unlockt - GlobalBridge$/i, preset: 'unlockt', customer: 'UNLOCKT BRANDS, INC' },
  { re: /^Delivery Status/i, preset: 'delivery' },
  { re: /^Seorin$/i, preset: 'generic', customer: 'SOLVENZA TRADE INC' },
  { re: /^Other Solvenza$/i, preset: 'generic', customer: 'SOLVENZA TRADE INC' },
  { re: /^(Lumare|ATELIER QUINCE|OPULEN|BK Trading|Leepop Inc|Other Shippers)$/i, preset: 'generic' },
  { re: /^(Marketing Tracker|Test- ?James|Frank's Shipments)$/i, skip: true },
];

async function discoverSheets() {
  const list = await api('/sheets?includeAll=true');
  return (list.data || []).map((sh) => {
    const rule = NAME_RULES.find((r) => r.re.test(sh.name.trim()));
    if (!rule || rule.skip) return null;
    return { id: sh.id, name: sh.name, preset: rule.preset, customer: rule.customer || sh.name.trim() };
  }).filter(Boolean);
}

async function activeConfigs(db = store.db) {
  const confs = sheetConfigs(db);
  return confs.length ? confs : discoverSheets();
}

// Default column titles tried for each field when a sheet has no explicit mapping (case-insensitive).
const DEFAULT_COLUMNS = {
  detail: ['Detail', 'Primary Column', 'Vessel ETA'],
  mbl_no: ['MBL', 'MBL#', 'MB/L', 'Master BL', 'MAWB', 'MBL / MAWB'],
  hbl_no: ['HBL', 'HBL#', 'HB/L', 'House BL', 'HAWB', 'BL#', 'B/L'],
  containers: ['Container', 'Container#', 'CNTR', 'CNTR#', 'CTN#', 'Container No', 'Container #'],
  carrier: ['SSL', 'Carrier'], mode: ['Shipping Mode'], cargo_ready: ['Origin W/H Date', 'W/H In'],
  isf: ['ISF', 'ISF Filed'], customs: ['Custom', 'Custom Cleared'], value: ['Column3', 'Value'], pallets_col: ['Column4'],
  terminal: ['Terminal'], available: ['Available'], delivered: ['Delivered'], lfd: ['LFD'], prepull: ['Prepull'], memo: ['Memo'],
  size: ['Size', 'Type', 'CNTR Type', 'Size/Type'],
  vessel: ['Vessel/Voy', 'Vessel / Voyage', 'Flight'],
  pol: ['POL', 'Origin'], pod: ['POD', 'Destination', 'Port'],
  etd: ['ETD'], eta: ['ETA'], ata: ['ATA'], atd: ['ATD'],
  status: ['Status'], customs_status: ['Customs', 'Customs Status', 'Exam'],
  delivery_address: ['Deliver to:', 'Deliver to', 'Destination', 'Delivery', 'Delivery Location', 'Warehouse', 'Ship To'],
  delivery_date: ['Delivery Date', 'Appt', 'Appointment', 'Delivery Appt'], delivery_time: ['Delivery Time', 'Appt Time'],
  vessel_col: ['Vessel', 'Vessel Name'],
  packages: ['CTNS', 'Cartons', 'PKGS', 'Packages', 'Qty'], pallets: ['PLTS', 'Pallets', 'PLT'],
  weight_kg: ['Weight', 'KGS', 'GW'], cbm: ['CBM'],
  commodity: ['Commodity', 'Description', 'Product', 'Brand'], po: ['PO', 'PO#', 'PO No'],
  shipper_name: ['Shipper', 'Brand', 'Vendor'], notes: ['UB Remarks', 'Comments', 'Notes', 'Remark', 'Remarks', 'Comment', 'Column7'],
  ref_no: ['Filing No', 'Ref', 'GB Ref'],
};

function columnIndex(sheet, mapping = {}) {
  const byTitle = new Map(sheet.columns.map((c) => [c.title.trim().toLowerCase(), c.id]));
  const out = {};
  for (const [field, titles] of Object.entries(DEFAULT_COLUMNS)) {
    const wanted = mapping[field] ? [mapping[field]] : titles;
    for (const t of wanted) { const id = byTitle.get(String(t).trim().toLowerCase()); if (id) { out[field] = id; break; } }
  }
  return out;
}

function cellValues(row, cols) {
  const byId = new Map(row.cells.map((c) => [c.columnId, c.value ?? c.displayValue ?? null]));
  const v = {};
  for (const [field, id] of Object.entries(cols)) {
    const x = byId.get(id);
    if (x !== null && x !== undefined && String(x).trim() !== '') v[field] = typeof x === 'string' ? x.trim() : x;
  }
  return v;
}

const PLACEHOLDER = /^(-+|TBD|TBA|N\/?A|REF;?.*|SEE BELOW.*|DONE)$/i;
const clean = (v) => (v == null || PLACEHOLDER.test(String(v).trim()) ? null : String(v).trim());

/**
 * Sheet dates: "9/2", "8/28 > 8/24" (revised: the last value counts), "2026-09-23", "9/9, 11:30 AM", "8/3/2026".
 * Year-less dates take the year that puts them closest to `hint` (the HBL's yymm, e.g. NSCLGB2608… = 2026-08).
 */
function sheetDate(v, hint = new Date()) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const last = String(v).split(/>+/).map((x) => x.trim()).filter(Boolean).pop() || '';
  if (/^\d{4}-\d{2}-\d{2}/.test(last)) return last.slice(0, 10);
  const full = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/.exec(last);
  if (full) return require('./extract/rules').toISODate(`${full[1]}/${full[2]}/${full[3]}`);
  const md = /^(\d{1,2})\/(\d{1,2})\b/.exec(last);
  if (!md) return null;
  const mo = Number(md[1]); const d = Number(md[2]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const h = hint instanceof Date ? hint : new Date(hint);
  let best = null;
  for (const y of [h.getUTCFullYear() - 1, h.getUTCFullYear(), h.getUTCFullYear() + 1]) {
    const t = Date.UTC(y, mo - 1, d);
    if (!best || Math.abs(t - h.getTime()) < Math.abs(best - h.getTime())) best = t;
  }
  return new Date(best).toISOString().slice(0, 10);
}
const timePart = (v) => { const m = /(\d{1,2}(:\d{2})?\s*[AP]M)/i.exec(String(v || '')); return m ? m[1].toUpperCase() : null; };

/** yymm inside NSC / ESSA house numbers → date hint for year-less sheet dates. */
function hintFrom(no) {
  const m = /^(?:NSC[A-Z]{2,4}|ESSA[A-Z]{2,4})(\d{2})(\d{2})/.exec(String(no || ''));
  return m && Number(m[2]) >= 1 && Number(m[2]) <= 12 ? new Date(Date.UTC(2000 + Number(m[1]), Number(m[2]) - 1, 15)) : new Date();
}

const STATUS_WORDS = [
  [/deliver(ed)?\b|완료|POD/i, 'DELIVERED'], [/out for|dispatch|배송중|picked/i, 'OUT_FOR_DELIVERY'],
  [/releas|clear|통관\s*완료/i, 'CUSTOMS_CLEARED'], [/arriv|discharg|도착|ATA/i, 'ARRIVED'],
  [/transit|sail|departed|출항|on board/i, 'IN_TRANSIT'], [/book/i, 'BOOKED'],
];

/** Parse the "Detail" text: "[NSC] MEDICUBE (INV#: CI-UN-260909-SEA-1-A), 240 PLT_12 X 40HQ" / "…, 2 PLT, AIR". */
function parseDetail(text) {
  const t = String(text || '');
  const inv = /INV#?\s*:?\s*([^),]+)/i.exec(t);
  // "240 PLT_12 X 40HQ": the unit can be followed by "_" (no word boundary there)
  const plt = /(\d[\d,]*)\s*PLTS?(?![A-Za-z])/i.exec(t);
  const ct = /(\d[\d,]*)\s*(?:CTNS?|CT)(?![A-Za-z])/i.exec(t);
  const eq = /(\d+)\s*X\s*(20|40|45)\s*'?\s*(HQ|HC|GP|DV|RH|RF|OT|FR)/i.exec(t) || /\b(\d+)?\s*(20|40|45)\s*(HQ|HC|GP|DV|RH|RF)\b/i.exec(t);
  const brand = t.replace(/\[[^\]]*\]/g, '').split(/\(|,/)[0].trim();
  return {
    brand: brand || null, invoice: inv ? inv[1].trim() : null,
    pallets: plt ? Number(plt[1].replace(/,/g, '')) : null, cartons: ct ? Number(ct[1].replace(/,/g, '')) : null,
    size: eq ? `${eq[2]}${{ HQ: 'HC', DV: 'GP' }[eq[3].toUpperCase()] || eq[3].toUpperCase()}` : null,
    air: /\bAIR\b/i.test(t), lcl: /\bLCL\b/i.test(t),
  };
}

/** House numbers in one cell ("NSCLGB26070035 // ESSASEL26071573"): ESSA… is the HBL, NSC… the sub B/L / agent ref. */
function splitHouse(v) {
  const toks = String(v || '').toUpperCase().split(/\s*(?:\/\/|&|,|\s)\s*/).filter(Boolean);
  const essa = toks.find((x) => /^ESS[A-Z]*\d{6,}$/.test(x));
  const nsc = toks.find((x) => /^NSC[A-Z]{2,5}\d{5,}$/.test(x));
  const other = toks.find((x) => /^[A-Z0-9-]{8,}$/.test(x) && x !== essa && x !== nsc);
  if (essa) return { hbl_no: essa, sub_bl_no: nsc || null, agent_ref: nsc || null };
  if (nsc) return { hbl_no: nsc, sub_bl_no: null, agent_ref: nsc };
  return { hbl_no: other || null, sub_bl_no: null, agent_ref: null };
}

/** A row describes a real shipment only with a B/L-like MBL / AWB, an NSC/ESSA house no. or a container. */
function isShipmentRow(m) {
  const mblOk = m.input.mbl_no && (/^[A-Z]{4}[A-Z0-9]{6,}$/.test(m.input.mbl_no) || /^\d{3}-?\d{8}$/.test(m.input.mbl_no)) && !/^FBA/i.test(m.input.mbl_no);
  const hblOk = m.input.hbl_no && /^(NSC|ESS)/.test(m.input.hbl_no);
  return Boolean(mblOk || hblOk || m.containers.length);
}

/** Map one sheet row to shipment input + containers + P/L line. */
function rowToShipment(v, conf) {
  const d = parseDetail(v.detail);
  const house = splitHouse(v.hbl_no);
  const mbl = clean(v.mbl_no);
  const mblNo = mbl && !/^BKG/i.test(mbl) ? mbl.toUpperCase().replace(/\s*\(.*\)\s*$/, '').replace(/\s+/g, '') : null;
  const hint = hintFrom(house.agent_ref || house.hbl_no);
  const containers = [...new Set((String(v.containers || '').toUpperCase().match(/[A-Z]{4}\d{7}/g) || []))];
  const air = /^air$/i.test(String(v.mode || '')) || d.air || /^NSCXA/.test(house.hbl_no || '') || /^\d{3}-?\d{8}$/.test(mblNo || '');
  const value = /USD\s*([\d,.]+)/i.exec(String(v.value || ''));
  const input = {
    mbl_no: mblNo, ...house, carrier: clean(v.carrier),
    vessel: clean(v.vessel_col) || clean(v.vessel), pol: clean(v.pol), pod: clean(v.pod),
    etd: sheetDate(clean(v.etd), hint), eta: sheetDate(clean(v.eta), hint), atd: sheetDate(clean(v.atd), hint), ata: sheetDate(clean(v.ata), hint),
    delivery_address: clean(v.delivery_address), delivery_date: /ETA/i.test(String(v.delivery_date || '')) ? null : sheetDate(clean(v.delivery_date), hint),
    delivery_time: clean(v.delivery_time) || timePart(v.delivery_date),
    packages: v.packages ?? d.cartons, pallets: v.pallets ?? (Number(String(v.pallets_col || '').replace(/\D/g, '')) || d.pallets),
    weight_kg: v.weight_kg, cbm: v.cbm, commodity: clean(v.commodity), shipper_name: clean(v.shipper_name) || d.brand,
    ci_invoice_no: d.invoice, cargo_value: value ? Number(value[1].replace(/,/g, '')) : null,
    isf_filed: v.isf === true ? 1 : undefined, customs_status: v.customs === true ? 'RELEASED' : undefined,
    mode: air ? 'AIR' : d.lcl || (house.hbl_no && /^ESS/.test(house.hbl_no)) ? 'LCL' : conf.mode || 'FCL',
    customer_ref: d.invoice,
  };
  if (v.status) { const hit = STATUS_WORDS.find(([re]) => re.test(String(v.status))); if (hit) input.status = hit[1]; }
  if (v.customs_status && /exam|hold/i.test(v.customs_status)) input.customs_status = /exam/i.test(v.customs_status) ? 'EXAM' : 'HOLD';
  for (const k of Object.keys(input)) if (input[k] === undefined || input[k] === null || input[k] === '' || Number.isNaN(input[k])) delete input[k];
  return { input, containers, size: d.size, brand: d.brand, invoice: d.invoice, pallets: input.pallets, notes: [clean(v.notes), clean(v.memo)].filter(Boolean).join(' / ') || null };
}

function findShipment(db, { input, containers }) {
  for (const no of [input.hbl_no, input.mbl_no].filter(Boolean)) {
    const s = db.get('SELECT id FROM shipments WHERE hbl_no = ? OR sub_bl_no = ? OR agent_ref = ? OR mbl_no = ? ORDER BY id DESC', no, no, no, no);
    if (s) return s.id;
  }
  for (const c of containers) {
    const s = db.get("SELECT s.id FROM shipments s JOIN containers k ON k.shipment_id = s.id WHERE k.container_no = ? AND s.status <> 'DELIVERED' ORDER BY s.id DESC", c);
    if (s) return s.id;
  }
  return null;
}

/** Pull one sheet. Returns { rows, created, updated, attachments, skipped }. */
async function pullSheet(conf, { db = store.db, withAttachments = true } = {}) {
  const sheet = await api(`/sheets/${conf.id}?include=attachments`);
  const cols = columnIndex(sheet, conf.columns || {});
  if (conf.preset === 'delivery') return pullDeliveryStatus(conf, sheet, cols, db);
  const customer = conf.customer ? db.get('SELECT id FROM companies WHERE name = ? OR short_name = ?', conf.customer, conf.customer) : null;
  const out = { sheet: sheet.name, rows: 0, created: 0, updated: 0, attachments: 0, skipped: 0 };
  for (const row of sheet.rows || []) {
    const v = cellValues(row, cols);
    const m = rowToShipment(v, conf);
    if (!isShipmentRow(m)) { out.skipped++; continue; } // section headers, pre-booking placeholders, FBA / UPS rows
    out.rows++;
    let id = db.get('SELECT shipment_id FROM smartsheet_rows WHERE sheet_id = ? AND row_id = ?', String(conf.id), String(row.id))?.shipment_id
      || findShipment(db, m);
    if (id && !S.find(id, null, { db })) id = null;
    if (id) {
      // Fill what the system does not know yet; the customer's sheet leads for delivery plans.
      const cur = S.find(id, null, { db });
      const patch = {};
      for (const [k, val] of Object.entries(m.input)) {
        if (cur[k] == null || cur[k] === '' || ['delivery_date', 'delivery_time', 'delivery_address'].includes(k)) patch[k] = val;
      }
      delete patch.mode;
      if (Object.keys(patch).length) {
        const changes = S.update(id, patch, { db });
        if (changes.length) { out.updated++; await require('./notify').onShipmentChanged(id, changes, { db }); }
      }
    } else {
      id = S.create({ ...m.input, customer_id: customer?.id, notes: m.notes ? `Smartsheet: ${m.notes}` : `Imported from Smartsheet (${sheet.name})` }, { db });
      out.created++;
    }
    const s = S.find(id, null, { db });
    for (const c of m.containers.filter((c) => !s.containers.some((k) => k.container_no === c))) {
      db.run('INSERT INTO containers (shipment_id, container_no, size_type) VALUES (?, ?, ?)', id, c, m.size || null);
    }
    // Consol rows repeat MBL/HBL per brand: one P/L line per brand / C/I until the real P/L arrives.
    const key = m.invoice || m.brand;
    if (key && !s.items.some((i) => i.po_no === (m.invoice || null) && i.description === (m.brand || 'See P/L'))) {
      db.run("INSERT INTO cargo_items (shipment_id, po_no, description, quantity, unit, source) VALUES (?, ?, ?, ?, ?, 'sheet')",
        id, m.invoice || null, m.brand || 'See P/L', m.pallets ?? null, m.pallets ? 'PLT' : null);
    }
    db.run(`INSERT INTO smartsheet_rows (sheet_id, row_id, shipment_id, synced_at) VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(sheet_id, row_id) DO UPDATE SET shipment_id = excluded.shipment_id, synced_at = excluded.synced_at`, String(conf.id), String(row.id), id);
    if (withAttachments) out.attachments += await pullAttachments(conf.id, row, id, db, { po: m.invoice || null, brand: m.brand || null });
  }
  db.setSetting(`smartsheet_last_${conf.id}`, new Date().toISOString());
  return out;
}

/** "Delivery Status_Unlockt": one row per container — terminal, availability, LFD, delivery appointment, delivered. */
function pullDeliveryStatus(conf, sheet, cols, db) {
  const out = { sheet: sheet.name, rows: 0, created: 0, updated: 0, attachments: 0, skipped: 0 };
  for (const row of sheet.rows || []) {
    const v = cellValues(row, cols);
    const no = String(v.containers || '').toUpperCase().match(/[A-Z]{4}\d{7}/)?.[0];
    if (!no) { out.skipped++; continue; }
    const k = db.get(`SELECT k.id, k.shipment_id FROM containers k JOIN shipments s ON s.id = k.shipment_id
      WHERE k.container_no = ? ORDER BY (s.status = 'DELIVERED'), s.id DESC LIMIT 1`, no);
    if (!k) { out.skipped++; continue; }
    out.rows++;
    const s = S.find(k.shipment_id, null, { db });
    const hint = hintFrom(s.agent_ref || s.hbl_no);
    const lfd = sheetDate(clean(v.lfd), hint);
    db.run('UPDATE containers SET available = COALESCE(?, available), pickup_lfd = COALESCE(?, pickup_lfd), location = COALESCE(?, location) WHERE id = ?',
      v.available === true ? 1 : v.available === false ? 0 : null, lfd, clean(v.terminal), k.id);
    const patch = {};
    const dd = /ETA/i.test(String(v.delivery_date || '')) ? null : sheetDate(clean(v.delivery_date), hint);
    if (dd && s.containers.length === 1) { patch.delivery_date = dd; patch.delivery_time = clean(v.delivery_time) || timePart(v.delivery_date) || s.delivery_time; }
    if (clean(v.terminal) && !s.devan_location) patch.devan_location = clean(v.terminal);
    if (lfd && (!s.last_free_day || lfd < s.last_free_day)) patch.last_free_day = lfd;
    if (v.delivered === true) {
      db.run("UPDATE containers SET current_status = 'delivered' WHERE id = ?", k.id);
      const all = db.all('SELECT current_status FROM containers WHERE shipment_id = ?', s.id);
      if (all.every((c) => c.current_status === 'delivered') && s.status !== 'DELIVERED') { patch.status = 'DELIVERED'; patch.pod_received = 1; }
    }
    if (Object.keys(patch).length && S.update(s.id, patch, { db }).length) out.updated++;
  }
  return out;
}

/** Download row attachments not seen before; store as documents; P/L / C/I / B/L are read by the extractor. */
async function pullAttachments(sheetId, row, shipmentId, db, rowKey = {}) {
  // The sheet was read with include=attachments: rows without files simply have no "attachments" key.
  const list = row.attachments || [];
  let n = 0;
  for (const a of list) {
    if (a.attachmentType && a.attachmentType !== 'FILE') continue; // links (Google Drive, etc.) are skipped
    if (db.get('SELECT 1 FROM smartsheet_files WHERE attachment_id = ?', String(a.id))) continue;
    const meta = await api(`/sheets/${sheetId}/attachments/${a.id}`);
    if (!meta.url) continue;
    const res = await fetchImpl(meta.url);
    if (!res.ok) continue;
    const buf = Buffer.from(await res.arrayBuffer());
    const dir = path.join(config.uploadDir, 'smartsheet');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, crypto.randomBytes(12).toString('hex'));
    fs.writeFileSync(file, buf);
    let docType = 'OTHER';
    let extracted = null;
    if (/\.(pdf|xlsx|csv|jpe?g|png)$/i.test(a.name)) {
      try {
        const parts = await require('./extract').extractFile({ buffer: buf, filename: a.name, mime: a.mimeType || '' });
        docType = parts[0]?.doc_type || 'OTHER';
        extracted = parts;
        applyPackingList(db, shipmentId, parts, rowKey);
      } catch (e) { console.error(`Smartsheet attachment ${a.name}:`, e.message); }
    }
    const d = db.run(`INSERT INTO documents (shipment_id, doc_type, filename, stored_path, mime, size, source, extracted_json)
      VALUES (?, ?, ?, ?, ?, ?, 'upload', ?)`, shipmentId, docType, a.name, file, a.mimeType || 'application/octet-stream', buf.length, extracted ? JSON.stringify(extracted) : null);
    db.run('INSERT INTO smartsheet_files (attachment_id, document_id, shipment_id) VALUES (?, ?, ?)', String(a.id), Number(d.lastInsertRowid), shipmentId);
    n++;
  }
  return n;
}

/**
 * P/L lines from an attached file replace the sheet's summary line for the same row (brand / C/I no.), so a consol
 * keeps one set of lines per brand. Totals still empty on the shipment are filled from the P/L.
 */
function applyPackingList(db, shipmentId, parts, rowKey = {}) {
  const pl = parts.find((p) => p.doc_type === 'PL' && p.items?.length) || parts.find((p) => p.items?.length);
  if (!pl) return;
  db.tx(() => {
    db.run(`DELETE FROM cargo_items WHERE shipment_id = ? AND (description = 'See P/L'
      OR (source = 'sheet' AND (po_no IS ? OR description IS ?)))`, shipmentId, rowKey.po ?? null, rowKey.brand ?? null);
    for (const i of pl.items) {
      db.run(`INSERT INTO cargo_items (shipment_id, po_no, description, hs_code, quantity, unit, packages, weight_kg, cbm, unit_price, amount, source)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pl')`, shipmentId, i.po_no || rowKey.po || null, i.description, i.hs_code, i.quantity, i.unit,
      i.packages, i.weight_kg, i.cbm, i.unit_price ?? null, i.amount ?? null);
    }
  });
  const s = S.find(shipmentId, null, { db });
  const fill = {};
  for (const k of ['packages', 'weight_kg', 'cbm']) if (s[k] == null && pl[k] != null) fill[k] = pl[k];
  if (Object.keys(fill).length) S.update(shipmentId, fill, { db });
}

/** Write system values back to the sheet (ETA / ATA / status / delivery) for linked rows. Off unless conf.push. */
async function pushSheet(conf, { db = store.db } = {}) {
  // Writing into the customer-shared sheet is opt-in (Admin › Automation) and never touches attachments.
  if (!(conf.push || db.setting('smartsheet_push') === '1') || conf.preset === 'delivery') return { pushed: 0 };
  const sheet = await api(`/sheets/${conf.id}`);
  const cols = columnIndex(sheet, conf.columns || {});
  const links = db.all('SELECT row_id, shipment_id FROM smartsheet_rows WHERE sheet_id = ?', String(conf.id));
  const rows = [];
  for (const l of links) {
    const s = S.find(l.shipment_id, null, { db });
    if (!s) continue;
    const cells = [];
    const put = (field, value) => { if (cols[field] && value != null && value !== '') cells.push({ columnId: cols[field], value }); };
    // Same style the team uses: "M/D", revised as "old > new".
    const md = (d) => (d ? `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}` : null);
    const eta = s.original_eta && s.eta && s.original_eta !== s.eta ? `${md(s.original_eta)} > ${md(s.eta)}` : md(s.eta);
    put('eta', eta); put('etd', md(s.etd));
    if (cells.length) rows.push({ id: Number(l.row_id), cells });
  }
  for (let i = 0; i < rows.length; i += 100) await api(`/sheets/${conf.id}/rows`, { method: 'PUT', body: rows.slice(i, i + 100) });
  return { pushed: rows.length };
}

async function syncAll({ db = store.db } = {}) {
  const results = [];
  const confs = await activeConfigs(db);
  // Shipment sheets first, then the container-level delivery sheet (it needs the containers to exist).
  confs.sort((a, b) => (a.preset === 'delivery') - (b.preset === 'delivery'));
  for (const conf of confs) {
    try {
      const r = await pullSheet(conf, { db });
      const p = await pushSheet(conf, { db });
      results.push({ ...r, ...p });
    } catch (e) {
      results.push({ sheet: conf.name || conf.id, error: e.message });
    }
  }
  db.setSetting('smartsheet_last_sync', JSON.stringify({ at: new Date().toISOString(), results }));
  return results;
}

function start() {
  if (!token()) return null;
  const run = () => {
    if (store.db.setting('smartsheet_sync') === '0') return;
    syncAll().then((r) => console.log('Smartsheet:', r.map((x) => x.error ? `${x.sheet}: ${x.error}` : `${x.sheet}: +${x.created} ~${x.updated} 📎${x.attachments}`).join(' | ')))
      .catch((e) => console.error('Smartsheet:', e.message));
  };
  setTimeout(run, 60000);
  return setInterval(run, Number(process.env.SMARTSHEET_MINUTES || 30) * 60000);
}

module.exports = {
  pullSheet, pushSheet, syncAll, start, setFetch, sheetConfigs, discoverSheets, columnIndex, rowToShipment, sheetDate, splitHouse, parseDetail, DEFAULT_COLUMNS,
};
