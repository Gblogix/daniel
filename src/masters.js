/**
 * Master B/L (ocean MB/L / air MAWB) and its house files — OPUS style: enter the master first, then add houses
 * under it; the carrier leg (MB/L, carrier, vessel / voyage, ETD / ETA, POL / POD) is kept on the master and copied
 * to every house. A house saved with an MB/L joins (or creates) that master automatically, so files made from
 * documents or by hand end up grouped the same way.
 */
const store = require('./db');

const FIELDS = ['mode', 'mbl_no', 'agent_id', 'carrier', 'scac', 'vessel', 'voyage', 'flight_no', 'etd', 'eta', 'atd', 'ata', 'pol', 'pod', 'place_of_delivery', 'service_term', 'notes'];
// Copied from the master to its houses (the carrier leg).
const SHARED = ['mbl_no', 'carrier', 'scac', 'vessel', 'voyage', 'flight_no', 'etd', 'eta', 'atd', 'ata', 'pol', 'pod'];
const key = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const isAir = (mode) => mode === 'AIR';

function clean(data) {
  const out = {};
  for (const f of FIELDS) {
    if (!(f in data)) continue;
    let v = data[f];
    if (typeof v === 'string') v = v.trim();
    if (v === '') v = null;
    if (f === 'agent_id' && v != null) v = Number(v) || null;
    if (f === 'mbl_no' && v) v = String(v).toUpperCase().replace(/\s+/g, '');
    out[f] = v;
  }
  return out;
}

function findByMbl(mbl, db = store.db) {
  const k = key(mbl);
  if (!k) return null;
  return db.all('SELECT * FROM masters WHERE mbl_no IS NOT NULL').find((m) => key(m.mbl_no) === k) || null;
}

function create(data, { db = store.db } = {}) {
  const d = clean(data);
  if (d.mbl_no) { const hit = findByMbl(d.mbl_no, db); if (hit) return hit.id; }
  const ref = require('./company').nextRef(isAir(d.mode) ? 'AM' : 'OM', { db, table: 'masters', column: 'ref_no' });
  const cols = ['ref_no', ...Object.keys(d)];
  return Number(db.run(`INSERT INTO masters (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, ref, ...Object.values(d)).lastInsertRowid);
}

/** Save the master; changed carrier-leg fields go to every house (through the normal file update — ETA mails etc.). */
function update(id, data, { db = store.db } = {}) {
  const S = require('./shipments');
  const cur = db.get('SELECT * FROM masters WHERE id = ?', id);
  if (!cur) throw new Error('Master not found');
  const d = clean(data);
  const changed = Object.keys(d).filter((k) => (cur[k] ?? null) != d[k]); // eslint-disable-line eqeqeq
  if (changed.length) db.run(`UPDATE masters SET ${changed.map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`, ...changed.map((k) => d[k]), id);
  const push = changed.filter((k) => SHARED.includes(k));
  const results = [];
  if (push.length) {
    for (const h of db.all('SELECT id FROM shipments WHERE master_id = ?', id)) {
      results.push({ id: h.id, changes: S.update(h.id, Object.fromEntries(push.map((k) => [k, d[k] ?? ''])), { db }) });
    }
  }
  return { changed, houses: results };
}

/**
 * Put a house file under its master (by MB/L), creating the master from the house when it is the first one.
 * Empty carrier-leg fields on the house are filled from the master; the house's own values are kept.
 */
function linkHouse(shipmentId, { db = store.db } = {}) {
  const s = db.get('SELECT * FROM shipments WHERE id = ?', shipmentId);
  if (!s || s.mode === 'OTHER' || s.mode === 'TRUCK') return null;
  let m = s.master_id ? db.get('SELECT * FROM masters WHERE id = ?', s.master_id) : null;
  if (s.mbl_no && (!m || key(m.mbl_no) !== key(s.mbl_no))) {
    m = findByMbl(s.mbl_no, db);
    if (!m) m = db.get('SELECT * FROM masters WHERE id = ?', create(Object.fromEntries(['mode', ...SHARED].map((k) => [k, s[k]]).concat([['agent_id', s.agent_id]])), { db }));
  }
  if (!m) return null;
  if (s.master_id !== m.id) db.run('UPDATE shipments SET master_id = ? WHERE id = ?', m.id, s.id);
  const fill = SHARED.filter((k) => (s[k] == null || s[k] === '') && m[k] != null && m[k] !== '');
  if (fill.length) db.run(`UPDATE shipments SET ${fill.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...fill.map((k) => m[k]), s.id);
  // A master missing what the house knows (first house from documents) learns it.
  const learn = SHARED.filter((k) => (m[k] == null || m[k] === '') && s[k] != null && s[k] !== '');
  if (learn.length) db.run(`UPDATE masters SET ${learn.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...learn.map((k) => s[k]), m.id);
  return m.id;
}

/** Link every file that has an MB/L but no master yet (runs at start-up). */
function backfill({ db = store.db } = {}) {
  let n = 0;
  for (const r of db.all("SELECT id FROM shipments WHERE master_id IS NULL AND mbl_no IS NOT NULL AND mbl_no <> '' AND mode NOT IN ('OTHER', 'TRUCK')")) if (linkHouse(r.id, { db })) n++;
  return n;
}

function get(id, { db = store.db } = {}) {
  const S = require('./shipments');
  const m = db.get('SELECT m.*, a.name AS agent_name FROM masters m LEFT JOIN companies a ON a.id = m.agent_id WHERE m.id = ?', id);
  if (!m) return null;
  m.houses = db.all('SELECT id FROM shipments WHERE master_id = ? ORDER BY id', id).map((r) => S.find(r.id, null, { db })).filter(Boolean);
  const seen = new Set();
  m.containers = m.houses.flatMap((h) => h.containers || []).filter((c) => !seen.has(c.container_no) && seen.add(c.container_no));
  return m;
}

function list({ q = '', db = store.db } = {}) {
  const like = `%${q}%`;
  return db.all(`SELECT m.*, a.name AS agent_name,
      (SELECT COUNT(*) FROM shipments s WHERE s.master_id = m.id) AS houses,
      (SELECT GROUP_CONCAT(DISTINCT c.name) FROM shipments s JOIN companies c ON c.id = s.customer_id WHERE s.master_id = m.id) AS customers,
      (SELECT GROUP_CONCAT(DISTINCT k.container_no) FROM shipments s JOIN containers k ON k.shipment_id = s.id WHERE s.master_id = m.id) AS ctns,
      (SELECT MIN(s.status = 'DELIVERED') FROM shipments s WHERE s.master_id = m.id) AS all_delivered
    FROM masters m LEFT JOIN companies a ON a.id = m.agent_id
    WHERE (? = '' OR m.mbl_no LIKE ? OR m.ref_no LIKE ? OR m.vessel LIKE ? OR EXISTS (SELECT 1 FROM shipments s WHERE s.master_id = m.id AND (s.hbl_no LIKE ? OR s.ref_no LIKE ?)))
    ORDER BY COALESCE(m.eta, m.created_at) DESC, m.id DESC LIMIT 300`, q, like, like, like, like, like);
}

function missing(m) {
  return require('./shipments').MASTER_REQUIRED.filter(([k]) => !m[k]).map(([, l]) => l);
}

module.exports = { FIELDS, SHARED, create, update, linkHouse, backfill, get, list, findByMbl, missing };
