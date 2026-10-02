/**
 * File tools (GoFreight / OPUS "Tools" menu): copy a file, move a house to another master, block (lock) a file,
 * the memo log, and the badges on the file's header bar.
 */
const store = require('./db');
const S = require('./shipments');

// What a copy keeps: the parties and the lane — not the B/L numbers, containers, dates or status.
const COPY_FIELDS = ['mode', 'origin_country', 'customer_id', 'bill_to_id', 'agent_id', 'broker_id', 'trucker_id', 'delivery_company_id', 'owner_id', 'sales_id',
  'shipper_name', 'shipper_address', 'consignee_name', 'consignee_address', 'notify_party', 'notify_address', 'pol', 'pod', 'place_of_delivery', 'final_destination',
  'carrier', 'scac', 'cfs_location', 'firms_code', 'freight_location_tel', 'delivery_address', 'commodity', 'package_unit', 'service_term', 'release_type', 'title'];

function copy(id, { db = store.db, userId = null } = {}) {
  const s = db.get('SELECT * FROM shipments WHERE id = ?', id);
  if (!s) throw new Error('File not found');
  const data = { status: 'BOOKED', customs_status: 'PENDING' };
  for (const k of COPY_FIELDS) if (s[k] != null && s[k] !== '') data[k] = s[k];
  const nid = S.create(data, { db, userId });
  S.addEvent(nid, 'COPIED', `Copied from ${s.ref_no}`, { db, userId, customerVisible: false });
  return nid;
}

/** Put a house under another master: the carrier leg (MB/L, vessel, dates, ports) comes from that master. */
function move(id, masterId, { db = store.db, userId = null } = {}) {
  const M = require('./masters');
  const m = db.get('SELECT * FROM masters WHERE id = ?', masterId);
  if (!m) throw new Error('Master not found');
  const s = db.get('SELECT ref_no, master_id FROM shipments WHERE id = ?', id);
  const from = s.master_id ? db.get('SELECT mbl_no, ref_no FROM masters WHERE id = ?', s.master_id) : null;
  const data = { master_id: m.id, mode: m.mode };
  for (const k of M.SHARED) data[k] = m[k] ?? '';
  const changes = S.update(id, data, { db });
  S.addEvent(id, 'MOVED', `Moved ${from ? `from master ${from.mbl_no || from.ref_no} ` : ''}to master ${m.mbl_no || m.ref_no}`, { db, userId, customerVisible: false });
  return changes;
}

function block(id, on, { reason = '', db = store.db, userId = null } = {}) {
  if (on) db.run("UPDATE shipments SET blocked_at = datetime('now'), blocked_by = ?, block_reason = ? WHERE id = ?", userId, String(reason || '').slice(0, 200) || null, id);
  else db.run('UPDATE shipments SET blocked_at = NULL, blocked_by = NULL, block_reason = NULL WHERE id = ?', id);
  S.addEvent(id, on ? 'BLOCKED' : 'UNBLOCKED', on ? `File blocked${reason ? `: ${reason}` : ''}` : 'File unblocked', { db, userId, customerVisible: false });
}

function memos(id, db = store.db) {
  return db.all('SELECT m.*, u.name AS user_name FROM shipment_memos m LEFT JOIN users u ON u.id = m.user_id WHERE m.shipment_id = ? ORDER BY m.id DESC', id);
}
function addMemo(id, { subject, body }, { db = store.db, userId = null } = {}) {
  const sub = String(subject || '').trim().slice(0, 200); const txt = String(body || '').trim().slice(0, 4000);
  if (!sub && !txt) return null;
  return Number(db.run('INSERT INTO shipment_memos (shipment_id, subject, body, user_id) VALUES (?, ?, ?, ?)', id, sub || null, txt || null, userId).lastInsertRowid);
}

/** Header bar badges: payment terms and overdue / credit of the bill-to party. */
function badges(s, { db = store.db, today = new Date().toISOString().slice(0, 10) } = {}) {
  const out = [];
  const partyId = s.bill_to_id || s.customer_id;
  if (!partyId) return out;
  const c = db.get('SELECT terms_days FROM companies WHERE id = ?', partyId) || {};
  if (c.terms_days === 0) out.push({ cls: 'cod', label: 'COD', title: 'Payment due on receipt — collect before release' });
  const od = db.get(`SELECT COUNT(*) AS n, ROUND(SUM(ABS(total) - paid_amount), 2) AS amt, MIN(due_date) AS oldest FROM invoices
    WHERE company_id = ? AND kind IN ('AR', 'DN') AND total > 0 AND status = 'OPEN' AND due_date < ?`, partyId, today);
  if (od.n) out.push({ cls: 'overdue', label: 'Over due', title: `${od.n} invoice(s) past due since ${od.oldest}`, amount: od.amt });
  return out;
}

module.exports = { copy, move, block, memos, addMemo, badges, COPY_FIELDS };
