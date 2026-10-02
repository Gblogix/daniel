/**
 * Customer credit: limit and hold on the bill-to party. A party on hold (set by hand, or over its limit with
 * invoices past due) stops the D/O — cargo is not released until an admin lets that one file go.
 */
const store = require('./db');

function state(companyId, { db = store.db, today = new Date().toISOString().slice(0, 10) } = {}) {
  if (!companyId) return null;
  const c = db.get('SELECT id, name, credit_limit, credit_hold, credit_note, terms_days FROM companies WHERE id = ?', companyId);
  if (!c) return null;
  const b = db.get(`SELECT ROUND(SUM(ABS(total) - paid_amount), 2) AS open, ROUND(SUM(CASE WHEN due_date < ? THEN ABS(total) - paid_amount ELSE 0 END), 2) AS overdue
    FROM invoices WHERE company_id = ? AND kind IN ('AR', 'DN') AND total > 0 AND status = 'OPEN'`, today, companyId);
  const open = b.open || 0; const overdue = b.overdue || 0;
  const over = c.credit_limit != null && c.credit_limit > 0 && open > c.credit_limit;
  const hold = Boolean(c.credit_hold) || (over && overdue > 0);
  return { party: c.name, limit: c.credit_limit, open, overdue, over, manual: Boolean(c.credit_hold), hold, note: c.credit_note,
    reason: c.credit_hold ? (c.credit_note || 'credit hold') : over && overdue > 0 ? `over credit limit $${c.credit_limit} with $${overdue} past due` : null };
}

/** The file's credit state (bill-to, else customer) and whether its cargo may be released. */
function forShipment(s, opts = {}) {
  const st = state(s.bill_to_id || s.customer_id, opts);
  if (!st) return null;
  return { ...st, released: Boolean(s.credit_released_at), blocksRelease: st.hold && !s.credit_released_at };
}

module.exports = { state, forShipment };
