/**
 * Accounting: AR invoices (customers), D/N – C/N (overseas agents, e.g. National Shipping), AP (vendor costs),
 * payments with allocation, AR aging, agent statement of account (SOA) with netting.
 *
 * Sign conventions
 *   AR  total > 0  customer owes us
 *   DN  total = debit − credit; > 0 agent owes us (debit note), < 0 we owe the agent (credit note)
 *   AP  total > 0  we owe the vendor / agent
 * Payments: IN (money received) settles AR and positive DN; OUT (money paid) settles AP and negative DN.
 */
const store = require('./db');
const company = require('./company');

// Charge descriptions seen on current invoices / debit notes (datalist suggestions).
const CHARGE_CODES = [
  'OCEAN FREIGHT', 'AIR FREIGHT', 'THC', 'AMS', 'SEAL', 'DOCUMENT FEE', 'D/O FEE', 'PIERPASS & CTF', 'CFS CHARGE',
  'TRUCKING CHARGE', 'CHASSIS', 'DEVANNING', 'SEGREGATION', 'STORAGE CHARGE', 'HANDLING CHARGE', 'CUSTOMS CLEARANCE FEE',
  'DUTIES', 'ISC FEE PAID', 'CES EXAM FEE', 'INSURANCE', 'ANNUAL BOND', 'ISF FILING', 'W/H OUT', 'PICK & PACK', 'LABEL', 'WMS',
];

const round = (v) => Math.round((Number(v) || 0) * 100) / 100;
const today = () => new Date().toISOString().slice(0, 10);
function addDays(d, n) { const t = new Date(`${d}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + Number(n || 0)); return t.toISOString().slice(0, 10); }

function normLines(kind, lines = []) {
  return lines.filter((l) => String(l.description || '').trim()).map((l) => {
    const rate = l.rate === '' || l.rate == null ? null : Number(String(l.rate).replace(/,/g, ''));
    const qty = l.qty === '' || l.qty == null ? null : Number(String(l.qty).replace(/,/g, ''));
    let amount = l.amount === '' || l.amount == null ? null : Number(String(l.amount).replace(/,/g, ''));
    if (amount == null && rate != null) amount = rate * (qty ?? 1);
    return {
      mh: kind === 'DN' ? (l.mh || 'M') : null, bl_no: l.bl_no || null, description: String(l.description).trim().toUpperCase(),
      unit: l.unit || null, rate: Number.isFinite(rate) ? rate : null, qty: Number.isFinite(qty) ? qty : null,
      amount: round(amount), pc: kind === 'DN' ? (l.pc || 'C') : null,
      side: kind === 'DN' && String(l.side).toUpperCase() === 'CREDIT' ? 'CREDIT' : 'DEBIT',
    };
  });
}

function totalOf(kind, lines) {
  if (kind === 'DN') return round(lines.reduce((a, l) => a + (l.side === 'CREDIT' ? -l.amount : l.amount), 0));
  return round(lines.reduce((a, l) => a + l.amount, 0));
}

function partyBlock(c) {
  return [c?.name, c?.address].filter(Boolean).join('\n');
}

/** Create or update an invoice (AR / DN / AP) with its lines. Returns the id. */
function saveInvoice(data, { db = store.db, userId = null, id = null } = {}) {
  const kind = data.kind;
  if (!['AR', 'DN', 'AP'].includes(kind)) throw Object.assign(new Error('Unknown invoice type'), { status: 400, expose: true });
  const lines = normLines(kind, data.lines);
  const total = totalOf(kind, lines);
  const party = data.company_id ? db.get('SELECT * FROM companies WHERE id = ?', Number(data.company_id)) : null;
  const invoiceDate = data.invoice_date || today();
  const blank = (v) => v === undefined || v === null || String(v).trim() === '';
  // Empty terms on the form = the customer's default terms (Unlockt 25 days, PGP 0 days), else the company default.
  const terms = Number(!blank(data.terms_days) ? data.terms_days : party?.terms_days ?? (kind === 'AR' ? db.setting('ar_terms_days') : 0)) || 0;
  const row = {
    shipment_id: data.shipment_id ? Number(data.shipment_id) : null,
    kind, company_id: party?.id ?? null,
    bill_to: data.bill_to || partyBlock(party), attn: data.attn || null, ship_to: data.ship_to || null,
    invoice_date: invoiceDate, terms_days: terms, due_date: !blank(data.due_date) ? data.due_date : addDays(invoiceDate, terms),
    currency: data.currency || 'USD', profit_share: data.profit_share === '' || data.profit_share == null ? (kind === 'DN' ? 0 : null) : Number(data.profit_share),
    agent_ref: data.agent_ref || null, customer_ref: data.customer_ref || null, memo: data.memo || null, total,
  };
  return db.tx(() => {
    if (id) {
      const cols = Object.keys(row);
      db.run(`UPDATE invoices SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, ...Object.values(row), id);
      if (kind === 'AP' && data.number) db.run('UPDATE invoices SET number = ? WHERE id = ?', data.number, id);
      db.run('UPDATE invoices SET document_id = NULL WHERE id = ?', id); // re-issue the PDF on next send
      db.run('DELETE FROM invoice_lines WHERE invoice_id = ?', id);
    } else {
      const number = kind === 'AR' ? `INV-${company.nextNumber('INV', db)}`
        : kind === 'DN' ? `DCN-${company.nextNumber('DCN', db)}`
          : (data.number || `AP-${Date.now().toString(36).toUpperCase()}`);
      const cols = ['number', 'prepared_by', ...Object.keys(row)];
      id = Number(db.run(`INSERT INTO invoices (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, number, userId, ...Object.values(row)).lastInsertRowid);
    }
    for (const l of lines) {
      db.run(`INSERT INTO invoice_lines (invoice_id, mh, bl_no, description, unit, rate, qty, amount, pc, side)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, l.mh, l.bl_no, l.description, l.unit, l.rate, l.qty, l.amount, l.pc, l.side);
    }
    refreshStatus(id, db);
    if (row.company_id && (kind === 'AP' || kind === 'DN')) applyUnapplied(row.company_id, { db });
    return id;
  });
}

function getInvoice(id, db = store.db) {
  const inv = db.get(`SELECT i.*, c.name AS company_name, c.emails AS company_emails, c.billing_emails, c.short_name AS company_short_name, s.ref_no, s.hbl_no, s.mbl_no
    FROM invoices i LEFT JOIN companies c ON c.id = i.company_id LEFT JOIN shipments s ON s.id = i.shipment_id WHERE i.id = ?`, id);
  if (!inv) return null;
  inv.lines = db.all('SELECT * FROM invoice_lines WHERE invoice_id = ? ORDER BY id', id);
  inv.balance = round(Math.abs(inv.total) - inv.paid_amount);
  return inv;
}

function listInvoices({ db = store.db, shipmentId, companyId, kind, open } = {}) {
  const where = ['1=1']; const p = [];
  if (shipmentId) { where.push('i.shipment_id = ?'); p.push(shipmentId); }
  if (companyId) { where.push('i.company_id = ?'); p.push(companyId); }
  if (kind) { where.push('i.kind = ?'); p.push(kind); }
  if (open) where.push("i.status = 'OPEN'");
  return db.all(`SELECT i.*, c.name AS company_name, s.ref_no, s.hbl_no, s.mbl_no, s.eta, s.agent_ref AS ship_agent_ref,
      ROUND(ABS(i.total) - i.paid_amount, 2) AS balance
    FROM invoices i LEFT JOIN companies c ON c.id = i.company_id LEFT JOIN shipments s ON s.id = i.shipment_id
    WHERE ${where.join(' AND ')} ORDER BY i.invoice_date DESC, i.id DESC`, ...p);
}

function refreshStatus(id, db = store.db) {
  const paid = round(db.get('SELECT COALESCE(SUM(amount), 0) AS t FROM payment_allocations WHERE invoice_id = ?', id).t);
  const inv = db.get('SELECT total, status FROM invoices WHERE id = ?', id);
  if (inv.status === 'VOID') { db.run('UPDATE invoices SET paid_amount = ? WHERE id = ?', paid, id); return; }
  const full = Math.abs(inv.total) > 0 && paid >= round(Math.abs(inv.total)) - 0.005;
  db.run(`UPDATE invoices SET paid_amount = ?, status = ?, paid_at = CASE WHEN ? THEN COALESCE(paid_at, date('now')) ELSE NULL END WHERE id = ?`,
    paid, full ? 'PAID' : 'OPEN', full ? 1 : 0, id);
  closeCheck(id, db);
}

/** Customer paid in full → the file closes and moves to Shipment history. */
function closeCheck(invoiceId, db) {
  const sid = db.get('SELECT shipment_id FROM invoices WHERE id = ?', invoiceId)?.shipment_id;
  if (sid) require('./shipments').refreshClosed(sid, { db });
}

function voidInvoice(id, db = store.db) {
  db.run("UPDATE invoices SET status = 'VOID' WHERE id = ?", id);
  closeCheck(id, db);
}

/** Which invoices a payment in this direction can settle. */
function settles(direction) {
  return direction === 'IN' ? "(i.kind = 'AR' OR (i.kind = 'DN' AND i.total > 0))" : "(i.kind = 'AP' OR (i.kind = 'DN' AND i.total < 0))";
}

/**
 * Record a payment. `allocations` [{invoice_id, amount}] — if omitted, the amount is applied to the company's
 * open items oldest due date first (e.g. one ACH from Unlockt covering many invoices). Returns { id, unapplied }.
 */
function recordPayment({ company_id, direction = 'IN', amount, paid_on, method, reference, memo, allocations }, { db = store.db, userId = null } = {}) {
  amount = round(amount);
  if (!(amount > 0)) throw Object.assign(new Error('Payment amount must be positive'), { status: 400, expose: true });
  return db.tx(() => {
    const id = Number(db.run(`INSERT INTO payments (company_id, direction, amount, paid_on, method, reference, memo, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, company_id || null, direction, amount, paid_on || today(), method || null, reference || null, memo || null, userId).lastInsertRowid);
    let left = amount;
    const allocs = allocations?.length ? allocations
      : db.all(`SELECT i.id AS invoice_id, ROUND(ABS(i.total) - i.paid_amount, 2) AS amount FROM invoices i
          WHERE i.company_id = ? AND i.status = 'OPEN' AND ${settles(direction)} ORDER BY i.due_date, i.id`, company_id);
    for (const a of allocs) {
      if (left <= 0) break;
      const inv = db.get('SELECT ROUND(ABS(total) - paid_amount, 2) AS bal FROM invoices WHERE id = ?', a.invoice_id);
      const amt = round(Math.min(left, Number(a.amount), inv.bal));
      if (amt <= 0) continue;
      db.run('INSERT INTO payment_allocations (payment_id, invoice_id, amount) VALUES (?, ?, ?)', id, a.invoice_id, amt);
      left = round(left - amt);
      refreshStatus(a.invoice_id, db);
    }
    return { id, unapplied: left };
  });
}

/**
 * Settle a set of agent items against each other (the NSC SOA "netting"): D/Ns they owe us minus AP / credit notes
 * we owe them. Items not selected are carried forward. Records one netting pair plus the net cash payment.
 */
function settleNetting({ company_id, invoice_ids, paid_on, reference, memo }, { db = store.db, userId = null } = {}) {
  const items = invoice_ids.map((id) => db.get('SELECT * FROM invoices WHERE id = ? AND company_id = ? AND status = \'OPEN\'', Number(id), company_id)).filter(Boolean);
  const bal = (i) => round(Math.abs(i.total) - i.paid_amount);
  const receivable = items.filter((i) => i.kind === 'DN' && i.total > 0);
  const payable = items.filter((i) => i.kind === 'AP' || (i.kind === 'DN' && i.total < 0));
  const recv = round(receivable.reduce((a, i) => a + bal(i), 0));
  const pay = round(payable.reduce((a, i) => a + bal(i), 0));
  const offset = Math.min(recv, pay);
  const net = round(recv - pay); // > 0 agent pays us; < 0 we pay agent
  return db.tx(() => {
    if (offset > 0) {
      // Offsetting entries: an IN and an OUT "NETTING" payment of the same amount.
      recordPayment({ company_id, direction: 'IN', amount: offset, paid_on, method: 'NETTING', reference, memo, allocations: receivable.map((i) => ({ invoice_id: i.id, amount: bal(i) })) }, { db, userId });
      recordPayment({ company_id, direction: 'OUT', amount: offset, paid_on, method: 'NETTING', reference, memo, allocations: payable.map((i) => ({ invoice_id: i.id, amount: bal(i) })) }, { db, userId });
    }
    if (net !== 0) {
      const dir = net > 0 ? 'IN' : 'OUT';
      const rest = (net > 0 ? receivable : payable).map((i) => {
        const cur = db.get('SELECT ROUND(ABS(total) - paid_amount, 2) AS b FROM invoices WHERE id = ?', i.id).b;
        return { invoice_id: i.id, amount: cur };
      }).filter((a) => a.amount > 0);
      recordPayment({ company_id, direction: dir, amount: Math.abs(net), paid_on, method: 'WIRE', reference, memo, allocations: rest }, { db, userId });
    }
    return { receivable: recv, payable: pay, net };
  });
}

const allocated = (paymentId, db) => round(db.get('SELECT COALESCE(SUM(amount), 0) AS t FROM payment_allocations WHERE payment_id = ?', paymentId).t);

/** Payments (non-netting) with money not yet applied to any item — e.g. a wire to NSC larger than the current bills. */
function unappliedPayments(companyId, db = store.db) {
  return db.all("SELECT * FROM payments WHERE company_id = ? AND method <> 'NETTING' ORDER BY paid_on, id", companyId)
    .map((p) => ({ ...p, unapplied: round(p.amount - allocated(p.id, db)) })).filter((p) => p.unapplied > 0.004);
}

/** Apply on-account money to open items (oldest due first). Runs after new agent invoices / D/Ns are booked. */
function applyUnapplied(companyId, { db = store.db } = {}) {
  let applied = 0;
  db.tx(() => {
    for (const p of unappliedPayments(companyId, db)) {
      let left = p.unapplied;
      const open = db.all(`SELECT i.id, ROUND(ABS(i.total) - i.paid_amount, 2) AS bal FROM invoices i
        WHERE i.company_id = ? AND i.status = 'OPEN' AND ${settles(p.direction)} ORDER BY i.due_date, i.id`, companyId);
      for (const i of open) {
        if (left <= 0) break;
        const amt = round(Math.min(left, i.bal));
        if (amt <= 0) continue;
        db.run('INSERT INTO payment_allocations (payment_id, invoice_id, amount) VALUES (?, ?, ?)', p.id, i.id, amt);
        refreshStatus(i.id, db);
        left = round(left - amt); applied = round(applied + amt);
      }
    }
  });
  return applied;
}

/**
 * Pay (or receive) on account whenever cash is available — the current practice with NSC.
 * netFirst: offset all open D/Ns against what we owe before applying the cash. Any excess stays on account.
 */
function payOnAccount({ company_id, direction = 'OUT', amount, paid_on, method = 'WIRE', reference, memo, netFirst = true }, { db = store.db, userId = null } = {}) {
  return db.tx(() => {
    let netting = null;
    if (netFirst) {
      const open = db.all("SELECT id FROM invoices WHERE company_id = ? AND status = 'OPEN' AND kind IN ('DN', 'AP')", company_id).map((r) => r.id);
      const recv = db.get("SELECT COALESCE(SUM(ABS(total) - paid_amount), 0) AS t FROM invoices WHERE company_id = ? AND status = 'OPEN' AND kind = 'DN' AND total > 0", company_id).t;
      const pay = db.get("SELECT COALESCE(SUM(ABS(total) - paid_amount), 0) AS t FROM invoices WHERE company_id = ? AND status = 'OPEN' AND (kind = 'AP' OR (kind = 'DN' AND total < 0))", company_id).t;
      const offset = round(Math.min(recv, pay));
      if (offset > 0) {
        const alloc = (dir) => db.all(`SELECT i.id AS invoice_id, ROUND(ABS(i.total) - i.paid_amount, 2) AS amount FROM invoices i
          WHERE i.id IN (${open.join(',')}) AND ${settles(dir)} ORDER BY i.due_date, i.id`);
        recordPayment({ company_id, direction: 'IN', amount: offset, paid_on, method: 'NETTING', reference, memo, allocations: alloc('IN') }, { db, userId });
        recordPayment({ company_id, direction: 'OUT', amount: offset, paid_on, method: 'NETTING', reference, memo, allocations: alloc('OUT') }, { db, userId });
        netting = offset;
      }
    }
    const r = recordPayment({ company_id, direction, amount, paid_on, method, reference, memo }, { db, userId });
    return { ...r, netting };
  });
}

/** Agent statement of account: every open or recent item with signed amounts (+ due to us, − due to agent). */
function agentStatement(companyId, { db = store.db, includePaid = false } = {}) {
  const rows = db.all(`SELECT i.*, s.ref_no, s.hbl_no, s.mbl_no, s.eta, s.etd, s.agent_ref AS ship_agent_ref, s.sub_bl_no
    FROM invoices i LEFT JOIN shipments s ON s.id = i.shipment_id
    WHERE i.company_id = ? AND i.kind IN ('DN', 'AP') AND i.status <> 'VOID' ${includePaid ? '' : "AND i.status = 'OPEN'"}
    ORDER BY i.invoice_date, i.id`, companyId);
  let running = 0;
  const items = rows.map((i) => {
    const signed = i.kind === 'AP' ? -i.total : i.total;          // + due to us
    const open = round(Math.sign(signed) * (Math.abs(signed) - i.paid_amount));
    running = round(running + open);
    return { ...i, signed: round(signed), open, running };
  });
  const dueToUs = round(items.filter((i) => i.open > 0).reduce((a, i) => a + i.open, 0));
  const dueToAgent = round(-items.filter((i) => i.open < 0).reduce((a, i) => a + i.open, 0));
  // Money on account: our unapplied payments reduce what we owe; the agent's reduce what they owe us.
  const onAccount = unappliedPayments(companyId, db);
  const paidOnAccount = round(onAccount.filter((p) => p.direction === 'OUT').reduce((a, p) => a + p.unapplied, 0));
  const receivedOnAccount = round(onAccount.filter((p) => p.direction === 'IN').reduce((a, p) => a + p.unapplied, 0));
  // Monthly view (by document month); the former rule was "last month's balance paid by the 15th of the next month".
  const months = new Map();
  for (const i of items.filter((x) => x.status === 'OPEN')) {
    const m = String(i.invoice_date).slice(0, 7);
    if (!months.has(m)) {
      const [y, mo] = m.split('-').map(Number);
      const guide = `${mo === 12 ? y + 1 : y}-${String(mo === 12 ? 1 : mo + 1).padStart(2, '0')}-15`;
      months.set(m, { month: m, dueToUs: 0, dueToAgent: 0, net: 0, count: 0, guideline: guide });
    }
    const g = months.get(m);
    if (i.open > 0) g.dueToUs = round(g.dueToUs + i.open); else g.dueToAgent = round(g.dueToAgent - i.open);
    g.net = round(g.dueToUs - g.dueToAgent); g.count++;
  }
  return {
    items, dueToUs, dueToAgent, paidOnAccount, receivedOnAccount, onAccount,
    months: [...months.values()].sort((a, b) => a.month.localeCompare(b.month)),
    net: round(dueToUs - dueToAgent + paidOnAccount - receivedOnAccount),
  };
}

/** AR aging by customer: current / 1-30 / 31-60 / 61-90 / 90+ days past due. */
function arAging({ db = store.db, asOf = today() } = {}) {
  const rows = db.all(`SELECT i.*, c.name AS company_name, s.ref_no, s.hbl_no, ROUND(i.total - i.paid_amount, 2) AS balance
    FROM invoices i LEFT JOIN companies c ON c.id = i.company_id LEFT JOIN shipments s ON s.id = i.shipment_id
    WHERE i.kind = 'AR' AND i.status = 'OPEN' ORDER BY c.name, i.due_date`);
  const by = new Map();
  for (const r of rows) {
    const days = Math.floor((Date.parse(asOf) - Date.parse(r.due_date || r.invoice_date)) / 86400000);
    r.days_past_due = days;
    const bucket = days <= 0 ? 'current' : days <= 30 ? 'd30' : days <= 60 ? 'd60' : days <= 90 ? 'd90' : 'd90p';
    const key = r.company_id || 0;
    if (!by.has(key)) by.set(key, { company_id: r.company_id, company_name: r.company_name || '(no customer)', current: 0, d30: 0, d60: 0, d90: 0, d90p: 0, total: 0, invoices: [] });
    const g = by.get(key);
    g[bucket] = round(g[bucket] + r.balance); g.total = round(g.total + r.balance); g.invoices.push(r);
  }
  return [...by.values()].sort((a, b) => b.total - a.total);
}

/**
 * Revenue / cost / profit for a shipment, line by line: AR lines and D/N debit lines are revenue (money due to us),
 * AP lines and D/N credit lines (profit share / charges owed to the agent) are cost.
 */
function shipmentLines(shipmentId, db = store.db) {
  return db.all(`SELECT l.*, i.id AS invoice_id, i.kind, i.number, i.status, i.invoice_date, i.due_date, i.sent_at, i.total AS invoice_total,
      i.paid_amount, i.company_id, c.name AS company_name
    FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id LEFT JOIN companies c ON c.id = i.company_id
    WHERE i.shipment_id = ? AND i.status <> 'VOID' ORDER BY CASE i.kind WHEN 'AR' THEN 0 WHEN 'DN' THEN 1 ELSE 2 END, i.id, l.id`, shipmentId)
    .map((l) => {
      const cost = l.kind === 'AP' || (l.kind === 'DN' && l.side === 'CREDIT');
      return { ...l, revenue: cost ? 0 : l.amount, cost: cost ? l.amount : 0 };
    });
}

function shipmentProfit(shipmentId, db = store.db) {
  const lines = shipmentLines(shipmentId, db);
  const revenue = round(lines.reduce((a, l) => a + l.revenue, 0));
  const cost = round(lines.reduce((a, l) => a + l.cost, 0));
  return { revenue, cost, profit: round(revenue - cost), margin: revenue ? Math.round(((revenue - cost) / revenue) * 1000) / 10 : null };
}

/** Profit & loss per file for a period (by ETA, else created date), with totals. */
function profitReport({ db = store.db, from, to, customerId, stage } = {}) {
  const where = ['1=1']; const p = [];
  if (from) { where.push('COALESCE(s.eta, date(s.created_at)) >= ?'); p.push(from); }
  if (to) { where.push('COALESCE(s.eta, date(s.created_at)) <= ?'); p.push(to); }
  if (customerId) { where.push('s.customer_id = ?'); p.push(customerId); }
  if (stage === 'closed') where.push('s.closed_at IS NOT NULL');
  if (stage === 'open') where.push('s.closed_at IS NULL');
  const rows = db.all(`SELECT s.id, s.ref_no, s.mode, s.status, s.eta, s.shipper_name, s.hbl_no, s.mbl_no, s.closed_at, c.name AS customer_name,
      (SELECT k.container_no FROM containers k WHERE k.shipment_id = s.id ORDER BY k.id LIMIT 1) AS first_ctn,
      (SELECT COUNT(*) FROM containers k WHERE k.shipment_id = s.id) AS ctn_count
    FROM shipments s LEFT JOIN companies c ON c.id = s.customer_id WHERE ${where.join(' AND ')}
      AND EXISTS (SELECT 1 FROM invoices i WHERE i.shipment_id = s.id AND i.status <> 'VOID')
    ORDER BY COALESCE(s.eta, s.created_at) DESC`, ...p).map((r) => ({ ...r, ...shipmentProfit(r.id, db) }));
  const total = { revenue: round(rows.reduce((a, r) => a + r.revenue, 0)), cost: round(rows.reduce((a, r) => a + r.cost, 0)) };
  total.profit = round(total.revenue - total.cost);
  total.margin = total.revenue ? Math.round((total.profit / total.revenue) * 1000) / 10 : null;
  return { rows, total };
}

/** Open items with a party, both ways, with their lines — for the checkbox settlement screen. */
function openItems(companyId, db = store.db) {
  const items = db.all(`SELECT i.*, s.ref_no, s.hbl_no, s.mbl_no, s.shipper_name, s.mode,
      (SELECT k.container_no FROM containers k WHERE k.shipment_id = s.id ORDER BY k.id LIMIT 1) AS first_ctn,
      (SELECT COUNT(*) FROM containers k WHERE k.shipment_id = s.id) AS ctn_count,
      ROUND(ABS(i.total) - i.paid_amount, 2) AS balance
    FROM invoices i LEFT JOIN shipments s ON s.id = i.shipment_id
    WHERE i.company_id = ? AND i.status = 'OPEN' ORDER BY i.due_date, i.invoice_date, i.id`, companyId);
  for (const i of items) i.lines = db.all('SELECT * FROM invoice_lines WHERE invoice_id = ? ORDER BY id', i.id);
  const receivable = items.filter((i) => i.kind === 'AR' || (i.kind === 'DN' && i.total > 0));
  const payable = items.filter((i) => i.kind === 'AP' || (i.kind === 'DN' && i.total < 0));
  const sum = (a) => round(a.reduce((x, i) => x + i.balance, 0));
  return { receivable, payable, dueToUs: sum(receivable), dueToThem: sum(payable) };
}

/**
 * Settle the checked items. One side only → one payment allocated to exactly those items (amounts may be partial).
 * Both sides checked → netting, then the difference as one payment.
 */
function settleSelected({ company_id, items, paid_on, method, reference, memo }, { db = store.db, userId = null } = {}) {
  const picked = items.map((x) => ({ inv: db.get("SELECT * FROM invoices WHERE id = ? AND company_id = ? AND status = 'OPEN'", Number(x.invoice_id), company_id), amount: x.amount }))
    .filter((x) => x.inv);
  if (!picked.length) throw Object.assign(new Error('Select at least one open item'), { status: 400, expose: true });
  const isIn = (i) => i.kind === 'AR' || (i.kind === 'DN' && i.total > 0);
  const ins = picked.filter((x) => isIn(x.inv));
  const outs = picked.filter((x) => !isIn(x.inv));
  if (ins.length && outs.length) {
    const r = settleNetting({ company_id, invoice_ids: picked.map((x) => x.inv.id), paid_on, reference, memo }, { db, userId });
    return { direction: r.net >= 0 ? 'IN' : 'OUT', amount: Math.abs(r.net), netted: Math.min(r.receivable, r.payable) };
  }
  const direction = ins.length ? 'IN' : 'OUT';
  const allocations = picked.map((x) => {
    const bal = round(Math.abs(x.inv.total) - x.inv.paid_amount);
    const amt = x.amount === '' || x.amount == null ? bal : Math.min(bal, round(String(x.amount).replace(/,/g, '')));
    return { invoice_id: x.inv.id, amount: amt };
  }).filter((a) => a.amount > 0);
  const amount = round(allocations.reduce((a, x) => a + x.amount, 0));
  recordPayment({ company_id, direction, amount, paid_on, method, reference, memo, allocations }, { db, userId });
  return { direction, amount, netted: 0 };
}

module.exports = {
  CHARGE_CODES, saveInvoice, getInvoice, listInvoices, voidInvoice, recordPayment, settleNetting,
  agentStatement, arAging, shipmentProfit, refreshStatus, addDays, payOnAccount, applyUnapplied, unappliedPayments,
  shipmentLines, profitReport, openItems, settleSelected,
};
