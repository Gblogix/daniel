const store = require('./db');

const MODES = {
  AIR: { label: 'Air', icon: '✈' },
  FCL: { label: 'Ocean (FCL)', icon: '🚢' },
  LCL: { label: 'Ocean (LCL)', icon: '🚢' },
  TRUCK: { label: 'Inland Trucking (CFS→CFS)', icon: '🚚' },
};

// Ordered milestones. Index is used for progress display.
const STATUSES = [
  { code: 'BOOKED', label: 'Booked', ko: '부킹 완료' },
  { code: 'CARGO_READY', label: 'Cargo Ready / Loaded', ko: '공장 적입' },
  { code: 'DEPARTED', label: 'Departed', ko: '출항' },
  { code: 'IN_TRANSIT', label: 'In Transit', ko: '운송중' },
  { code: 'ARRIVED', label: 'Arrived', ko: '도착' },
  { code: 'CUSTOMS_CLEARED', label: 'Customs Released', ko: '통관 완료' },
  { code: 'OUT_FOR_DELIVERY', label: 'Out for Delivery', ko: '배송중' },
  { code: 'DELIVERED', label: 'Delivered', ko: '배송 완료' },
];
const STATUS_INDEX = Object.fromEntries(STATUSES.map((s, i) => [s.code, i]));
const statusLabel = (code) => STATUSES.find((s) => s.code === code)?.label || code;

// Customs: FILED = entry filed, EXAM = 1H/CES exam, HOLD = other CBP/agency hold, RELEASED = 1C posted.
const CUSTOMS_STATUSES = ['PENDING', 'FILED', 'EXAM', 'HOLD', 'RELEASED'];
// Common holds seen on terminals / airlines / CES.
const HOLD_TYPES = ['1H (exam)', 'CBP hold', 'Freight/BL hold', 'Lien', 'USDA', 'FDA', 'Line hold'];

// Fields a staff member can edit on the shipment form / an intake can populate.
const EDITABLE_FIELDS = [
  'mode', 'origin_country', 'status', 'customer_id', 'agent_id', 'broker_id', 'trucker_id', 'delivery_company_id',
  'shipper_name', 'shipper_address', 'consignee_name', 'notify_party', 'mbl_no', 'hbl_no', 'carrier', 'vessel',
  'voyage', 'flight_no', 'pol', 'pod', 'place_of_delivery', 'cfs_location', 'etd', 'eta', 'atd', 'ata',
  'packages', 'package_unit', 'weight_kg', 'cbm', 'chargeable_weight', 'commodity', 'delivery_address',
  'delivery_date', 'delivery_time', 'last_free_day', 'customs_status', 'isf_filed', 'service_price',
  'invoice_no', 'invoice_amount', 'paid', 'notes',
  'scac', 'direct_shipment', 'isf_no', 'telex_release', 'firms_code', 'entry_no', 'css_no', 'holds', 'cargo_value',
  'ci_invoice_no', 'freight_paid', 'carrier_released', 'storage_start', 'available_for_pickup', 'pickup_appt',
  'picked_up_at', 'pallets', 'pod_received', 'empty_returned_at', 'tracking_enabled', 'vessel_imo', 'vessel_mmsi',
  'ams_bl_no', 'customer_ref', 'sub_bl_no', 'it_no', 'it_place', 'it_date', 'devan_location', 'freight_location_tel',
  'available_date', 'go_date', 'final_destination', 'service_term', 'release_type', 'consignee_address', 'notify_address',
  'marks', 'agent_ref',
];
const NUMERIC_FIELDS = new Set(['customer_id', 'agent_id', 'broker_id', 'trucker_id', 'delivery_company_id',
  'packages', 'weight_kg', 'cbm', 'chargeable_weight', 'service_price', 'invoice_amount', 'cargo_value', 'pallets']);
const BOOL_FIELDS = new Set(['isf_filed', 'paid', 'direct_shipment', 'telex_release', 'freight_paid', 'carrier_released',
  'pod_received', 'tracking_enabled']);

function normalizeInput(input) {
  const out = {};
  for (const f of EDITABLE_FIELDS) {
    if (!(f in input)) continue;
    let v = input[f];
    if (typeof v === 'string') v = v.trim();
    if (Array.isArray(v)) v = v.filter(Boolean).join(', ');
    if (BOOL_FIELDS.has(f)) v = v === true || v === '1' || v === 'on' || v === 1 ? 1 : 0;
    else if (f === 'available_for_pickup') v = v === '' || v == null ? null : v === '1' || v === 1 || v === true ? 1 : 0;
    else if (v === '' || v === undefined) v = null;
    else if (NUMERIC_FIELDS.has(f)) { v = Number(String(v).replace(/,/g, '')); if (!Number.isFinite(v)) v = null; }
    out[f] = v;
  }
  return out;
}

/** Filing number in the office format: OI-11828 (ocean import), AI-10009 (air import), OTH0010582 (trucking / other). */
function nextRefNo(db, mode = 'FCL') {
  const company = require('./company');
  if (mode === 'AIR') return `AI-${company.nextNumber('AI', db)}`;
  if (mode === 'TRUCK') return `OTH${String(company.nextNumber('OTH', db)).padStart(7, '0')}`;
  return `OI-${company.nextNumber('OI', db)}`;
}

function create(input, { db = store.db, userId } = {}) {
  const data = normalizeInput(input);
  let ref = input.ref_no && String(input.ref_no).trim();
  if (!ref || db.get('SELECT 1 FROM shipments WHERE ref_no = ?', ref)) ref = nextRefNo(db, data.mode || 'FCL');
  const cols = ['ref_no', ...Object.keys(data)];
  const res = db.run(`INSERT INTO shipments (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
    ref, ...Object.values(data));
  const id = Number(res.lastInsertRowid);
  addEvent(id, 'CREATED', `Shipment ${ref} created`, { db, userId, customerVisible: false });
  return id;
}

/** Updates a shipment and returns the list of changed fields ({field, from, to}). */
function update(id, input, { db = store.db } = {}) {
  const current = db.get('SELECT * FROM shipments WHERE id = ?', id);
  if (!current) throw new Error('Shipment not found');
  const data = normalizeInput(input);
  const changes = [];
  for (const [k, v] of Object.entries(data)) {
    const before = current[k] ?? null;
    // eslint-disable-next-line eqeqeq
    if (before != v && !(before === null && v === null)) changes.push({ field: k, from: before, to: v });
  }
  if (changes.length) {
    const sets = changes.map((c) => `${c.field} = ?`).join(', ');
    db.run(`UPDATE shipments SET ${sets}, updated_at = datetime('now') WHERE id = ?`, ...changes.map((c) => c.to), id);
  }
  return changes;
}

function addEvent(shipmentId, type, message, { db = store.db, userId = null, customerVisible = true } = {}) {
  db.run('INSERT INTO events (shipment_id, type, message, customer_visible, user_id) VALUES (?, ?, ?, ?, ?)',
    shipmentId, type, message, customerVisible ? 1 : 0, userId);
}

const BASE_SELECT = `
  SELECT s.*, c.name AS customer_name, a.name AS agent_name, b.name AS broker_name, t.name AS trucker_name,
         d.name AS delivery_company_name
  FROM shipments s
  LEFT JOIN companies c ON c.id = s.customer_id
  LEFT JOIN companies a ON a.id = s.agent_id
  LEFT JOIN companies b ON b.id = s.broker_id
  LEFT JOIN companies t ON t.id = s.trucker_id
  LEFT JOIN companies d ON d.id = s.delivery_company_id`;

/** Returns SQL WHERE fragment + params restricting shipments to what the user may see. */
function scopeFor(user) {
  switch (user.role) {
    case 'admin':
    case 'staff': return { where: '1=1', params: [] };
    case 'customer': return { where: 's.customer_id = ?', params: [user.company_id] };
    case 'agent': return { where: 's.agent_id = ?', params: [user.company_id] };
    case 'broker': return { where: 's.broker_id = ?', params: [user.company_id] };
    case 'trucker': return { where: 's.trucker_id = ?', params: [user.company_id] };
    default: return { where: '0', params: [] };
  }
}

function list(user, { q, status, mode, active, db = store.db } = {}) {
  const scope = scopeFor(user);
  const where = [scope.where];
  const params = [...scope.params];
  if (q) {
    where.push(`(s.ref_no LIKE ? OR s.mbl_no LIKE ? OR s.hbl_no LIKE ? OR c.name LIKE ? OR s.shipper_name LIKE ?
      OR EXISTS (SELECT 1 FROM containers k WHERE k.shipment_id = s.id AND k.container_no LIKE ?))`);
    params.push(...Array(6).fill(`%${q}%`));
  }
  if (status) { where.push('s.status = ?'); params.push(status); }
  if (mode) { where.push('s.mode = ?'); params.push(mode); }
  if (active) where.push("s.status <> 'DELIVERED'");
  const rows = db.all(`${BASE_SELECT} WHERE ${where.join(' AND ')} ORDER BY COALESCE(s.eta, s.created_at) DESC, s.id DESC`, ...params);
  const ids = rows.map((r) => r.id);
  if (ids.length) {
    const ph = ids.map(() => '?').join(',');
    const ctns = db.all(`SELECT * FROM containers WHERE shipment_id IN (${ph}) ORDER BY id`, ...ids);
    const items = db.all(`SELECT shipment_id, description, quantity, unit, packages FROM cargo_items WHERE shipment_id IN (${ph}) ORDER BY id`, ...ids);
    for (const r of rows) {
      r.containers = ctns.filter((c) => c.shipment_id === r.id);
      r.items = items.filter((i) => i.shipment_id === r.id);
    }
  }
  return rows;
}

function find(id, user, { db = store.db } = {}) {
  const scope = user ? scopeFor(user) : { where: '1=1', params: [] };
  const s = db.get(`${BASE_SELECT} WHERE s.id = ? AND ${scope.where}`, id, ...scope.params);
  if (!s) return null;
  s.containers = db.all('SELECT * FROM containers WHERE shipment_id = ? ORDER BY id', id);
  s.items = db.all('SELECT * FROM cargo_items WHERE shipment_id = ? ORDER BY id', id);
  s.charges = db.all('SELECT * FROM charges WHERE shipment_id = ? ORDER BY id', id);
  return s;
}

/** Replace containers / cargo lines from the form's parallel arrays. */
function saveLines(id, body, { db = store.db } = {}) {
  const arr = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
  const n = (v) => { if (v == null || String(v).trim() === '') return null; const x = Number(String(v).replace(/,/g, '')); return Number.isFinite(x) ? x : null; };
  if ('ctn_no' in body) {
    const kept = new Map(db.all('SELECT * FROM containers WHERE shipment_id = ?', id).map((c) => [c.container_no, c]));
    db.tx(() => {
      db.run('DELETE FROM containers WHERE shipment_id = ?', id);
      const no = arr(body.ctn_no);
      no.forEach((c, i) => {
        if (!String(c).trim()) return;
        const no = String(c).trim().toUpperCase().replace(/[\s-]/g, '');
        // Keep tracking data (discharge / LFD / holds) that came from the provider for containers that stay.
        const prev = kept.get(no) || {};
        db.run(`INSERT INTO containers (shipment_id, container_no, seal_no, size_type, packages, weight_kg, cbm, pickup_lfd,
            available, holds, discharged_at, full_out_at, empty_returned_at, current_status, location, pickup_no) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id, no, arr(body.ctn_seal)[i] || null, arr(body.ctn_size)[i] || null,
          n(arr(body.ctn_pkgs)[i]), n(arr(body.ctn_kg)[i]), n(arr(body.ctn_cbm)[i]), arr(body.ctn_lfd)[i] || prev.pickup_lfd || null,
          prev.available ?? null, prev.holds ?? null, prev.discharged_at ?? null, prev.full_out_at ?? null,
          prev.empty_returned_at ?? null, prev.current_status ?? null, prev.location ?? null, arr(body.ctn_pickup)[i] || prev.pickup_no || null);
      });
    });
  }
  if ('item_desc' in body) {
    db.tx(() => {
      db.run('DELETE FROM cargo_items WHERE shipment_id = ?', id);
      arr(body.item_desc).forEach((d, i) => {
        if (!String(d).trim()) return;
        db.run('INSERT INTO cargo_items (shipment_id, po_no, description, hs_code, quantity, unit, packages, weight_kg, cbm, unit_price, amount) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          id, arr(body.item_po)[i] || null, String(d).trim(), arr(body.item_hs)[i] || null, n(arr(body.item_qty)[i]),
          arr(body.item_unit)[i] || null, n(arr(body.item_pkgs)[i]), n(arr(body.item_kg)[i]), n(arr(body.item_cbm)[i]),
          n(arr(body.item_price)[i]), n(arr(body.item_amount)[i]));
      });
    });
  }
  if ('charge_desc' in body) {
    db.tx(() => {
      db.run('DELETE FROM charges WHERE shipment_id = ?', id);
      arr(body.charge_desc).forEach((d, i) => {
        if (!String(d).trim()) return;
        db.run('INSERT INTO charges (shipment_id, description, amount) VALUES (?, ?, ?)', id, String(d).trim(), n(arr(body.charge_amt)[i]) ?? 0);
      });
      const total = db.get('SELECT SUM(amount) AS t FROM charges WHERE shipment_id = ?', id).t;
      if (total != null) db.run('UPDATE shipments SET invoice_amount = ? WHERE id = ?', Math.round(total * 100) / 100, id);
    });
  }
}

/**
 * Clearance & release checklist — the steps staff chase on every import (from the real email flow).
 * Returns [{key, label, done, date?}] in order; the first not-done step is the "next action".
 */
function checklist(s) {
  const air = s.mode === 'AIR';
  const fcl = s.mode === 'FCL';
  const steps = [];
  const add = (key, label, done, extra = {}) => steps.push({ key, label, done: Boolean(done), ...extra });
  if (!air) add('isf', 'ISF filed', s.isf_filed);
  if (!air) add('telex', 'Telex release / OBL received', s.telex_release);
  add('an', 'A/N sent to broker & customer', s.an_sent_at, { date: s.an_sent_at });
  add('freight', air ? 'ISC / airline charges paid' : 'Carrier freight & fees paid', s.freight_paid);
  add('customs', 'Customs cleared (1C)', s.customs_status === 'RELEASED');
  add('holds', 'No holds (exam / lien / BL hold)', !s.holds && s.customs_status !== 'EXAM' && s.customs_status !== 'HOLD', { note: s.holds || null });
  add('release', air ? 'Airline / terminal released' : 'Carrier & terminal released', s.carrier_released || s.available_for_pickup === 1);
  add('do', air ? 'D/O + ATME sent to trucker' : 'D/O sent to trucker', s.do_sent_at, { date: s.do_sent_at });
  add('appt', 'Pickup appointment', s.pickup_appt, { date: s.pickup_appt });
  add('pickup', 'Picked up', s.picked_up_at, { date: s.picked_up_at });
  add('pod', 'Delivered — POD received', s.pod_received || s.status === 'DELIVERED');
  if (fcl) add('empty', 'Empty returned (EIR)', s.empty_returned_at, { date: s.empty_returned_at });
  const next = steps.find((x) => !x.done);
  if (next) next.next = true;
  return steps;
}

/** Earliest last-free-day across shipment and containers, with days remaining. */
function lfdInfo(s, now = new Date()) {
  const dates = [s.last_free_day, ...(s.containers || []).map((c) => c.pickup_lfd)].filter(Boolean).sort();
  if (!dates.length || s.picked_up_at || s.status === 'DELIVERED') return null;
  const days = Math.round((parseDate(dates[0]) - todayUTC(now)) / DAY);
  return { date: dates[0], days, level: days < 0 ? 'over' : days <= 1 ? 'urgent' : days <= 3 ? 'soon' : 'ok' };
}

function parseDate(d) {
  if (!d) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : null;
}
const DAY = 86400000;
function todayUTC(now = new Date()) { return Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()); }
function isoDay(ms) { return new Date(ms).toISOString().slice(0, 10); }

/**
 * Tracking bar model: one cell per day from ETD (or ATD) to ETA (or ATA).
 * Cells before today are "done", today's cell is "current" (blinks), after are "todo".
 */
function tracking(s, now = new Date()) {
  const start = parseDate(s.atd || s.etd);
  const end = parseDate(s.ata || s.eta);
  const today = todayUTC(now);
  const idx = STATUS_INDEX[s.status] ?? 0;
  const out = {
    statusIndex: idx, statusLabel: statusLabel(s.status), days: [], percent: 0,
    daysLeft: null, totalDays: null, phase: 'unscheduled', mode: MODES[s.mode] || MODES.FCL,
  };
  if (start == null || end == null || end < start) {
    out.percent = Math.round((idx / (STATUSES.length - 1)) * 100);
    return out;
  }
  const total = Math.round((end - start) / DAY);
  out.totalDays = total;
  out.daysLeft = Math.max(0, Math.round((end - today) / DAY));
  out.daysToDeparture = Math.max(0, Math.round((start - today) / DAY));
  const arrived = idx >= STATUS_INDEX.ARRIVED;
  const departed = idx >= STATUS_INDEX.DEPARTED || today >= start;
  out.phase = arrived ? 'arrived' : departed ? (today > end ? 'delayed' : 'sailing') : 'waiting';
  // Cap very long spans so the bar stays readable (air shipments are short, ocean ~14-40 days).
  const step = total > 60 ? Math.ceil(total / 60) : 1;
  for (let t = start; t <= end; t += DAY * step) {
    let state = 'todo';
    if (arrived || t < today) state = 'done';
    if (!arrived && t <= today && today < t + DAY * step) state = 'current';
    out.days.push({ date: isoDay(t), state });
  }
  if (arrived) out.percent = 100;
  else if (today <= start) out.percent = 0;
  else out.percent = Math.min(99, Math.round(((today - start) / (end - start || 1)) * 100));
  return out;
}

module.exports = {
  MODES, STATUSES, STATUS_INDEX, CUSTOMS_STATUSES, HOLD_TYPES, EDITABLE_FIELDS, checklist, lfdInfo,
  statusLabel, normalizeInput, saveLines, nextRefNo, create, update, addEvent, list, find, scopeFor, tracking,
};
