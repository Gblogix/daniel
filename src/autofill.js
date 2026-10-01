/**
 * Fill what we already know, so nobody types it twice:
 *  - carrier / airline from the B/L SCAC prefix, the AWB 3-digit prefix or the container owner code — and, for a prefix
 *    the tables don't know, from the last file with the same prefix (whatever the team typed there);
 *  - pick-up (freight location / terminal / CFS, firms code, tel) from the last file with the same carrier + port
 *    (LCL: same co-loader agent + port);
 *  - delivery (deliver-to, address, trucker, broker) from the customer's / consignee's last file.
 * Only empty fields are filled; anything typed stays.
 */
const store = require('./db');
const codes = require('./tracking/codes');

const PICKUP = ['cfs_location', 'firms_code', 'freight_location_tel'];
const DELIVERY = ['delivery_company_id', 'delivery_address', 'trucker_id', 'broker_id'];

const empty = (v) => v == null || v === '';
const norm = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
// "LOS ANGELES,CA U.S.A." / "LOS ANGELES, CA" / "LAX" are the same port for this purpose: compare the first word.
const portKey = (v) => String(v || '').toUpperCase().replace(/[^A-Z ]/g, ' ').trim().split(/\s+/)[0] || '';

/** Carrier + SCAC from the numbers on the documents. */
function carrierFor(s, { db = store.db } = {}) {
  const air = s.mode === 'AIR';
  const no = norm(s.mbl_no || s.mawb_no);
  if (air || /^\d{11}$/.test(no)) {
    const awb = codes.parseAwb(no);
    if (!awb) return null;
    if (awb.airline) return { carrier: awb.airline, prefix: awb.prefix, how: `AWB prefix ${awb.prefix}` };
    const seen = learned(db, (r) => norm(r.mbl_no).slice(0, 3) === awb.prefix && /^\d{11}$/.test(norm(r.mbl_no)));
    return seen ? { carrier: seen.carrier, prefix: awb.prefix, how: `AWB prefix ${awb.prefix} (as on ${seen.ref_no})` } : null;
  }
  const scac = codes.detectScac({ ...s, mbl_no: no });
  if (scac && codes.CARRIERS[scac]) return { carrier: codes.CARRIERS[scac], scac, how: `SCAC ${scac}` };
  const p = /^[A-Z]{4}/.test(no) ? no.slice(0, 4) : null;
  const seen = p && learned(db, (r) => norm(r.mbl_no).startsWith(p));
  if (seen) return { carrier: seen.carrier, scac: seen.scac || scac || p, how: `B/L prefix ${p} (as on ${seen.ref_no})` };
  return scac ? { carrier: null, scac, how: `SCAC ${scac}` } : null;
}

function learned(db, match) {
  const rows = db.all(`SELECT ref_no, mbl_no, carrier, scac FROM shipments WHERE carrier IS NOT NULL AND carrier <> '' AND mbl_no IS NOT NULL
    UNION ALL SELECT ref_no, mbl_no, carrier, scac FROM masters WHERE carrier IS NOT NULL AND carrier <> '' AND mbl_no IS NOT NULL
    ORDER BY ref_no DESC LIMIT 2000`);
  return rows.find(match) || null;
}

/** Last file (not this one) matching `where`, that has at least one of `fields` filled. */
function lastWith(db, s, fields, where, params) {
  const has = fields.map((f) => `(${f} IS NOT NULL AND ${f} <> '')`).join(' OR ');
  return db.all(`SELECT * FROM shipments WHERE id <> ? AND mode <> 'OTHER' AND (${has}) AND ${where} ORDER BY COALESCE(eta, created_at) DESC, id DESC LIMIT 200`,
    s.id || 0, ...params);
}

/**
 * What the history suggests for this file: { fills: {field: value}, from: {pickup: ref, delivery: ref, carrier: how} }.
 * `s` is the file as it stands (or the form being typed).
 */
function suggest(s, { db = store.db } = {}) {
  const fills = {};
  const from = {};
  if (!s || s.mode === 'OTHER') return { fills, from };
  if (empty(s.carrier) || empty(s.scac)) {
    const c = carrierFor(s, { db });
    if (c?.carrier && empty(s.carrier)) { fills.carrier = c.carrier; from.carrier = c.how; }
    if (c?.scac && empty(s.scac) && s.mode !== 'AIR') fills.scac = c.scac;
  }
  const carrier = s.carrier || fills.carrier;
  const pod = portKey(s.pod);
  if (PICKUP.some((f) => empty(s[f])) && pod) {
    const cands = lastWith(db, s, PICKUP, 'mode = ?', [s.mode || 'FCL']).filter((r) => portKey(r.pod) === pod);
    const same = (r) => (s.mode === 'LCL' && s.agent_id ? String(r.agent_id) === String(s.agent_id) : norm(r.carrier) === norm(carrier) && !!carrier);
    const hit = cands.find(same);
    if (hit) {
      for (const f of PICKUP) if (empty(s[f]) && !empty(hit[f])) fills[f] = hit[f];
      if (PICKUP.some((f) => f in fills)) from.pickup = hit.ref_no;
    }
  }
  if (DELIVERY.some((f) => empty(s[f]))) {
    let rows = [];
    if (s.customer_id) rows = lastWith(db, s, DELIVERY, 'customer_id = ?', [s.customer_id]);
    if (!rows.length && s.consignee_name) rows = lastWith(db, s, DELIVERY, '1 = 1', []).filter((r) => norm(r.consignee_name) === norm(s.consignee_name));
    const hit = rows.find((r) => !empty(r.delivery_address) || !empty(r.delivery_company_id)) || rows[0];
    if (hit) {
      for (const f of DELIVERY) if (empty(s[f]) && !empty(hit[f])) fills[f] = hit[f];
      if (DELIVERY.some((f) => f in fills)) from.delivery = hit.ref_no;
    }
  }
  return { fills, from };
}

/** Fill the empty fields of a saved file from its history; logs what came from where. Returns the filled field names. */
function apply(id, { db = store.db } = {}) {
  const s = db.get('SELECT * FROM shipments WHERE id = ?', id);
  if (!s) return [];
  const first = db.get('SELECT container_no FROM containers WHERE shipment_id = ? ORDER BY id LIMIT 1', id);
  const { fills, from } = suggest({ ...s, containers: first ? [first] : [] }, { db });
  const keys = Object.keys(fills);
  if (!keys.length) return [];
  db.run(`UPDATE shipments SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`, ...keys.map((k) => fills[k]), id);
  const parts = [];
  if (from.carrier) parts.push(`carrier ${fills.carrier} (${from.carrier})`);
  if (from.pickup) parts.push(`pick-up location from ${from.pickup}`);
  if (from.delivery) parts.push(`delivery details from ${from.delivery}`);
  if (parts.length) require('./shipments').addEvent(id, 'AUTOFILL', `Auto-filled: ${parts.join('; ')}`, { db, customerVisible: false });
  return keys;
}

/** Same for a master: carrier from the MB/L / MAWB prefix. */
function applyMaster(id, { db = store.db } = {}) {
  const m = db.get('SELECT * FROM masters WHERE id = ?', id);
  if (!m || (!empty(m.carrier) && (m.mode === 'AIR' || !empty(m.scac)))) return [];
  const c = carrierFor(m, { db });
  const fills = {};
  if (c?.carrier && empty(m.carrier)) fills.carrier = c.carrier;
  if (c?.scac && empty(m.scac) && m.mode !== 'AIR') fills.scac = c.scac;
  const keys = Object.keys(fills);
  if (keys.length) db.run(`UPDATE masters SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => fills[k]), id);
  return keys;
}

module.exports = { carrierFor, suggest, apply, applyMaster, PICKUP, DELIVERY };
