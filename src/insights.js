/**
 * Management dashboard: how the business is running for a period, compared with the period before (M/M) or the same
 * period last year (Y/Y). Files count by ETA (else created date), like the P&L report.
 *  - profit, volume (B/L · AWB), active customers, lost customers (no file for LOST_DAYS)
 *  - top 5 customers by profit and by volume
 *  - files that lost money (by house B/L or grouped by master), with a remark and "ignore"
 */
const store = require('./db');
const A = require('./accounting');

const LOST_DAYS = 60;
const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const ms = (d) => Date.parse(`${d}T00:00:00Z`);
const round = (v) => Math.round((Number(v) || 0) * 100) / 100;
const FILE_DATE = "COALESCE(NULLIF(s.eta, ''), date(s.created_at))";

/** The period on screen and the one it is compared with. Default: last 60 days, compared with the 60 days before. */
function period({ from, to, cmp } = {}, now = new Date()) {
  const ok = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '');
  const end = ok(to) ? to : iso(now.getTime());
  const start = ok(from) && from <= end ? from : iso(ms(end) - 59 * DAY);
  const mode = cmp === 'yy' ? 'yy' : 'mm';
  let prev;
  if (mode === 'yy') {
    const back = (d) => `${Number(d.slice(0, 4)) - 1}${d.slice(4)}`.replace(/-02-29$/, '-02-28');
    prev = { from: back(start), to: back(end) };
  } else {
    const len = Math.round((ms(end) - ms(start)) / DAY) + 1;
    prev = { from: iso(ms(start) - len * DAY), to: iso(ms(start) - DAY) };
  }
  return { from: start, to: end, cmp: mode, prev };
}

function files(from, to, db) {
  return db.all(`SELECT s.id, s.ref_no, s.mode, s.customer_id, s.master_id, s.mbl_no, s.hbl_no, s.etd, s.eta, s.owner_id, s.shipper_name,
      s.profit_remark, s.profit_ignore, ${FILE_DATE} AS fdate, c.name AS customer_name, u.name AS owner_name,
      (SELECT k.container_no FROM containers k WHERE k.shipment_id = s.id ORDER BY k.id LIMIT 1) AS first_ctn,
      (SELECT COUNT(*) FROM containers k WHERE k.shipment_id = s.id) AS ctn_count,
      EXISTS (SELECT 1 FROM invoices i WHERE i.shipment_id = s.id AND i.status <> 'VOID') AS billed
    FROM shipments s LEFT JOIN companies c ON c.id = s.customer_id LEFT JOIN users u ON u.id = s.owner_id
    WHERE s.mode <> 'OTHER' AND ${FILE_DATE} BETWEEN ? AND ?`, from, to);
}

/** Customers whose last file is more than LOST_DAYS before `asOf` (and within the year before — older ones are gone). */
function lostCustomers(asOf, { db = store.db, view = 'active' } = {}) {
  const rows = db.all(`SELECT c.id, c.name, c.lost_ignored, MAX(${FILE_DATE}) AS last_date, COUNT(s.id) AS files
    FROM companies c JOIN shipments s ON s.customer_id = c.id
    WHERE s.mode <> 'OTHER' AND ${FILE_DATE} <= ?
    GROUP BY c.id HAVING last_date < ? AND last_date >= ?
    ORDER BY last_date DESC`, asOf, iso(ms(asOf) - LOST_DAYS * DAY), iso(ms(asOf) - 365 * DAY))
    .map((r) => ({ ...r, days: Math.round((ms(asOf) - ms(r.last_date)) / DAY), ignored: Boolean(r.lost_ignored) }));
  if (view === 'ignored') return rows.filter((r) => r.ignored);
  if (view === 'all') return rows;
  return rows.filter((r) => !r.ignored);
}

function totals(from, to, db) {
  const list = files(from, to, db);
  const profitOf = new Map(list.filter((f) => f.billed).map((f) => [f.id, A.shipmentProfit(f.id, db)]));
  return {
    list, profitOf,
    profit: round([...profitOf.values()].reduce((a, p) => a + p.profit, 0)),
    volume: list.length,
    active: new Set(list.map((f) => f.customer_id).filter(Boolean)).size,
    lost: lostCustomers(to, { db }).length,
  };
}

const change = (now, before) => (before ? Math.round(((now - before) / Math.abs(before)) * 1000) / 10 : null);

/** Top N + "Other" by a measure. */
function top(list, measure, n = 5) {
  const by = new Map();
  for (const f of list) {
    if (!f.customer_id) continue;
    const v = measure(f);
    if (v == null) continue;
    const cur = by.get(f.customer_id) || { id: f.customer_id, name: f.customer_name, value: 0 };
    cur.value = round(cur.value + v);
    by.set(f.customer_id, cur);
  }
  const all = [...by.values()].sort((a, b) => b.value - a.value);
  const head = all.slice(0, n);
  const rest = all.slice(n);
  const total = round(all.reduce((a, r) => a + r.value, 0));
  if (rest.length) head.push({ id: null, name: `Other (${rest.length})`, value: round(rest.reduce((a, r) => a + r.value, 0)), other: true });
  return { rows: head.map((r) => ({ ...r, share: total ? Math.round((r.value / total) * 1000) / 10 : 0 })), total };
}

/** Files that lost money in the period; `by` = 'hbl' (each file) or 'mbl' (summed per master B/L). */
function negative(p, { db = store.db, by = 'hbl', status = 'notice', data = null } = {}) {
  const t = data || totals(p.from, p.to, db);
  let rows = t.list.filter((f) => t.profitOf.has(f.id)).map((f) => ({ ...f, ...t.profitOf.get(f.id) }));
  if (by === 'mbl') {
    const groups = new Map();
    for (const r of rows) {
      const key = r.master_id ? `m${r.master_id}` : r.mbl_no ? `b${r.mbl_no}` : `f${r.id}`;
      const g = groups.get(key) || { ...r, files: [], profit: 0, hbls: [] };
      g.files.push(r); g.hbls.push(r.hbl_no || r.ref_no);
      g.profit = round(g.profit + r.profit);
      g.profit_ignore = g.files.every((x) => x.profit_ignore);
      groups.set(key, g);
    }
    rows = [...groups.values()];
  }
  rows = rows.filter((r) => r.profit < 0);
  if (status === 'notice') rows = rows.filter((r) => !r.profit_ignore);
  if (status === 'ignored') rows = rows.filter((r) => r.profit_ignore);
  rows.sort((a, b) => a.profit - b.profit);
  return { rows, total: round(rows.reduce((a, r) => a + r.profit, 0)) };
}

/** Everything the dashboard section shows. */
function dashboard(q = {}, { db = store.db, now = new Date() } = {}) {
  const p = period(q, now);
  const cur = totals(p.from, p.to, db);
  const prev = totals(p.prev.from, p.prev.to, db);
  const kpi = ['profit', 'volume', 'active', 'lost'].map((k) => ({ key: k, value: cur[k], prev: prev[k], change: change(cur[k], prev[k]) }));
  return {
    period: p, kpi,
    topProfit: top(cur.list, (f) => (cur.profitOf.has(f.id) ? cur.profitOf.get(f.id).profit : null)),
    topVolume: top(cur.list, () => 1),
    negative: negative(p, { db, data: cur }),
    noCustomer: cur.list.filter((f) => !f.customer_id).length,
  };
}

module.exports = { period, dashboard, lostCustomers, negative, top, LOST_DAYS };
