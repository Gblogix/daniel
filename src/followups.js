/**
 * Follow-up engine: nothing slips. Every open file is checked against the steps of the real import flow and the
 * money side, and each gap becomes an item with a severity, a due date, the person in charge and a one-click action.
 * Items are computed from the data (they disappear when the work is done); users can snooze or tick off an item.
 *
 * Item: { key, area: 'ops' | 'acct', severity: 'critical' | 'high' | 'normal', title, detail, due, shipment_id,
 *         owner_id, action: { label, href } | { label, post } }
 */
const store = require('./db');
const S = require('./shipments');

const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const d = (s) => (s ? Date.parse(`${String(s).slice(0, 10)}T00:00:00Z`) : null);
const md = (s) => (s ? `${Number(s.slice(5, 7))}/${Number(s.slice(8, 10))}` : '');
const SEV_RANK = { critical: 0, high: 1, normal: 2 };
// To-do groups (GoFreight "group by task"): follow-up code → task.
const TASKS = {
  lfd: 'LFD', empty: 'LFD', an: 'Arrival Notice', do: 'Cargo Release', credit: 'Cargo Release', customs: 'Customs Clearance', hold: 'Customs Clearance', isf: 'ISF',
  docs: 'Pre-Alert', plmissing: 'Pre-Alert', required: 'Pre-Alert', eta_missing: 'Pre-Alert', 'g:intakes': 'Pre-Alert',
  delivery_plan: 'Delivery', custreq: 'Delivery', pod: 'Delivery', eta_past: 'Tracking', tracking: 'Tracking', pic: 'Assign PIC',
  not_invoiced: 'Create Invoice', review: 'Invoice', send: 'Invoice', overdue: 'Invoice', no_cost: 'A/P', pay: 'A/P', 'g:vinv': 'A/P', 'g:failed': 'Email', task: 'Task',
};
const TASK_ORDER = ['Task', 'LFD', 'Cargo Release', 'Arrival Notice', 'Customs Clearance', 'ISF', 'Pre-Alert', 'Delivery', 'Tracking', 'Create Invoice', 'Invoice', 'A/P', 'Assign PIC', 'Email'];
function taskOf(key) {
  if (key.startsWith('g:')) return TASKS[key] || 'Other';
  const code = key.split(':')[1];
  return TASKS[code] || 'Other';
}

function todayMs(now) { return Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()); }

/** Operations follow-ups for one file. `docs` = Set of document types on file. */
function shipmentItems(s, { now = new Date(), docs = new Set() } = {}) {
  const T = todayMs(now);
  const days = (x) => (x == null ? null : Math.round((x - T) / DAY));
  const out = [];
  const add = (code, severity, title, detail, due, action, keyExtra = '') => out.push({
    key: `s${s.id}:${code}${keyExtra ? `:${keyExtra}` : ''}`, area: 'ops', severity, title, detail, due: due || iso(T), shipment_id: s.id,
    owner_id: s.owner_id || null, action, s,
  });
  const idx = S.STATUS_INDEX[s.status] ?? 0;
  const ocean = s.mode === 'FCL' || s.mode === 'LCL';
  const etd = d(s.atd || s.etd); const eta = d(s.ata || s.eta);
  const arrived = idx >= S.STATUS_INDEX.ARRIVED || (s.ata && d(s.ata) <= T);
  const delivered = s.status === 'DELIVERED';
  const file = `/shipments/${s.id}`;
  if (S.isMisc(s)) return out; // "Other" files hold invoices only — accounting follow-ups still apply

  if (!s.owner_id) add('pic', 'normal', 'Assign a person in charge', 'No PIC — nobody gets this file\'s heads-up', null, { label: 'Assign', href: `${file}#pic` });
  if (delivered) {
    // After delivery only the empty return is left on the ops side.
    const since = d(s.picked_up_at) || d(s.delivery_date);
    if (s.mode === 'FCL' && !s.empty_returned_at && since != null && days(since) <= -3) {
      add('empty', 'high', 'Empty container not returned', `Picked up ${md(iso(since))} — per diem is running; get the EIR from the trucker`, iso(since + 4 * DAY), { label: 'Open file', href: `${file}#pickup` });
    }
    return out;
  }
  if (s.delivery_request_at && !s.delivery_request_done) {
    add('custreq', 'high', 'Customer asked for a delivery date', `${s.delivery_request_date || ''} ${s.delivery_request_time || ''} ${s.delivery_request_note ? `— “${s.delivery_request_note}”` : ''}`.trim(),
      null, { label: 'Schedule delivery', href: `${file}#delivery` }, s.delivery_request_at);
  }
  if (ocean && !s.isf_filed && etd != null && days(etd) <= 3) {
    add('isf', days(etd) <= 1 ? 'critical' : 'high', 'ISF not filed', `ETD ${md(iso(etd))} — ISF is due 24h before loading`, iso(etd - DAY), { label: 'Open file', href: file });
  }
  // The B/L names invoices with no P/L lines on the file yet (consolidated box: one C/I + P/L per buyer).
  const have = new Set((s.items || []).map((i) => String(i.invoice_no || '').toUpperCase()).filter(Boolean));
  const missingPl = String(s.bl_invoices || '').split(',').filter((v) => v && !have.has(v.toUpperCase()));
  if (missingPl.length && (have.size || (s.items || []).length === 0)) {
    add('plmissing', eta != null && days(eta) <= 5 ? 'high' : 'normal', `P/L missing for invoice ${missingPl.join(', ')}`, 'Named on the B/L — ask the shipper / agent for the C/I + P/L', eta != null ? iso(eta - 5 * DAY) : null, { label: 'Open documents', href: `${file}#docs` }, missingPl.join(''));
  }
  if (etd != null && days(etd) < 0) {
    const need = s.mode === 'AIR' ? ['AWB'] : ['HBL', 'PL', 'CI'];
    const missing = need.filter((t) => !docs.has(t) && !(t === 'AWB' && (docs.has('HBL') || docs.has('MBL'))));
    if (missing.length) add('docs', days(etd) < -3 || (eta != null && days(eta) <= 5) ? 'high' : 'normal', `Documents missing: ${missing.join(', ')}`, 'Ask the agent to upload them (portal) or forward by email', iso(etd + 2 * DAY), { label: 'Open documents', href: `${file}#docs` }, missing.join(''));
  }
  if (!s.an_sent_at && eta != null && days(eta) <= 5) {
    add('an', days(eta) <= 1 ? 'critical' : 'high', 'Arrival notice not sent', `ETA ${md(iso(eta))} — broker needs A/N + HBL/PL/CI`, iso(eta - 3 * DAY),
      s.broker_id ? { label: 'Send A/N → broker', post: `${file}/actions/send-an` } : { label: 'Assign broker', href: file });
  }
  if (eta != null && days(eta) <= 3 && !s.delivery_date) {
    add('delivery_plan', days(eta) <= 0 ? 'high' : 'normal', 'Delivery date not set', 'Confirm the delivery date / time with the customer and the warehouse', iso(eta - DAY), { label: 'Set delivery', href: `${file}#delivery` });
  }
  if (!arrived && s.eta && d(s.eta) < T && !s.ata) {
    add('eta_past', 'normal', 'Past ETA — arrival not confirmed', `ETA was ${md(s.eta)}; check the carrier / tracking`, s.eta, { label: 'Refresh tracking', post: `${file}/track` });
  }
  if (s.customs_status === 'EXAM' || s.customs_status === 'HOLD' || s.holds) {
    add('hold', 'critical', `Hold: ${s.holds || s.customs_status}`, 'Chase the broker / terminal and tell the customer the expected release', null, { label: 'Status update → customer', post: `${file}/actions/send-update` }, s.holds || s.customs_status);
  } else if (arrived && s.customs_status !== 'RELEASED') {
    const since = d(s.ata) || eta || T;
    add('customs', days(since) <= -2 ? 'critical' : 'high', 'Customs not released', `Arrived ${md(iso(since))} — chase ${s.broker_name || 'the broker'} for 1C`, iso(since + DAY), { label: 'Open file', href: file });
  }
  // Credit hold on the bill-to party: no D/O until it is paid down or an admin releases this file.
  if (!s.do_sent_at && s.status !== 'DELIVERED' && (s.bill_to_id || s.customer_id)) {
    const cr = require('./credit').forShipment(s);
    if (cr?.blocksRelease) add('credit', 'critical', `Credit hold — ${cr.party}`, `D/O blocked: ${cr.reason}. Collect payment, or an admin releases this file.`, null, { label: 'Open file', href: file });
  }
  if (s.customs_status === 'RELEASED' && !s.do_sent_at) {
    add('do', 'high', 'D/O not sent', `Released — send the delivery order to ${s.trucker_name || 'the trucker'}`, null,
      s.trucker_id ? { label: 'Send D/O → trucker', post: `${file}/actions/send-do` } : { label: 'Assign trucker', href: file });
  }
  const lfd = S.lfdInfo(s, now);
  if (lfd && lfd.days <= 2) {
    add('lfd', lfd.days <= 0 ? 'critical' : 'high', lfd.days < 0 ? `LFD passed ${-lfd.days}d ago — storage running` : lfd.days === 0 ? 'LFD is TODAY' : `LFD in ${lfd.days} day(s)`,
      s.pickup_appt ? `Pick-up appointment ${String(s.pickup_appt).slice(0, 16)}` : 'No pick-up appointment yet — book with the trucker', lfd.date, { label: 'Open file', href: `${file}#pickup` }, lfd.date);
  }
  if (s.delivery_date && d(s.delivery_date) < T) {
    add('pod', 'high', 'Delivery date passed — confirm POD', `Scheduled ${md(s.delivery_date)}; mark delivered when the POD arrives`, s.delivery_date, { label: 'Open file', href: `${file}#pickup` }, s.delivery_date);
  }
  // OPUS-required fields still empty.
  const missing = S.missingRequired(s).filter((l) => !/ETA|Arrival/.test(l));
  if (missing.length && (s.mbl_no || s.hbl_no)) add('required', 'normal', `Required info missing: ${missing.join(', ')}`, 'Fill in from the B/L / AWB or ask the agent', null, { label: 'Open file', href: `${file}#pic` });
  // No ETA at all once the B/L is in: nobody can plan the A/N, customs or delivery.
  if (!s.eta && !s.ata && (s.mbl_no || s.hbl_no) && idx < S.STATUS_INDEX.ARRIVED) {
    add('eta_missing', etd != null && days(etd) <= 0 ? 'high' : 'normal', 'ETA unknown', 'Not on the documents and no tracking update yet — check the carrier site or ask the agent', null, { label: 'Open file', href: `${file}#pic` });
  }
  if (['error', 'failed'].includes(s.tracking_status)) add('tracking', 'normal', 'Tracking error', s.tracking_error || 'Carrier tracking failed', null, { label: 'Refresh tracking', post: `${file}/track` });
  return out;
}

/** Accounting follow-ups (admins + accounting staff). */
function accountingItems({ db = store.db, now = new Date(), rows } = {}) {
  const T = todayMs(now);
  const out = [];
  const add = (key, severity, title, detail, due, action, s = null) => out.push({ key, area: 'acct', severity, title, detail, due: due || iso(T), shipment_id: s?.id || null, owner_id: null, action, s });
  for (const s of rows) {
    if (s.status !== 'DELIVERED' || s.closed_at) continue;
    if (!s.bill_count) {
      const since = d(s.delivery_date) || d(s.updated_at);
      const late = since != null && (T - since) / DAY >= 3;
      add(`s${s.id}:not_invoiced`, late ? 'critical' : 'high', 'Delivered — not invoiced', `Bill ${s.customer_name || 'the customer'}${s.agent_name ? ` / D/N to ${s.agent_name}` : ''}`, null, { label: 'Invoice', href: `/shipments/${s.id}#accounting` }, s);
    }
    if (!s.cost_count && !s.vinv_pending) add(`s${s.id}:no_cost`, 'normal', 'No cost booked', 'Vendor bills (trucker, CFS, broker) not in yet — ask for them', null, { label: 'Upload vendor invoice', href: `/shipments/${s.id}#accounting` }, s);
  }
  const inv = db.all(`SELECT i.*, c.name AS company_name, s.id AS sid FROM invoices i LEFT JOIN companies c ON c.id = i.company_id LEFT JOIN shipments s ON s.id = i.shipment_id
    WHERE i.status = 'OPEN'`);
  const files = new Map(rows.map((s) => [s.id, s]));
  for (const i of inv) {
    const s = files.get(i.sid) || null;
    const due = d(i.due_date);
    const money = `USD ${Math.abs(i.total - Math.sign(i.total) * i.paid_amount).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
    if (i.kind === 'AP' || (i.kind === 'DN' && i.total < 0)) {
      if (due != null && due - T <= 3 * DAY) add(`i${i.id}:pay`, due < T ? 'high' : 'normal', due < T ? `Payable overdue — ${i.company_name}` : `Payable due ${md(i.due_date)} — ${i.company_name}`, `${i.number} · ${money}`, i.due_date, { label: 'Check & settle', href: `/billing/parties/${i.company_id}` }, s);
      continue;
    }
    if (!i.sent_at && !i.reviewed_at) add(`i${i.id}:review`, 'normal', `Review ${i.kind === 'AR' ? 'invoice' : 'D/N'} ${i.number}`, `${i.company_name} · ${money}`, null, { label: 'Review', href: i.sid ? `/shipments/${i.sid}#accounting` : `/invoices/${i.id}` }, s);
    else if (!i.sent_at) add(`i${i.id}:send`, 'high', `Send ${i.kind === 'AR' ? 'invoice' : 'D/N'} ${i.number}`, `Reviewed — not emailed to ${i.company_name} yet`, null, { label: 'Send', post: `/invoices/${i.id}/send` }, s);
    else if (due != null && due < T) {
      const late = Math.round((T - due) / DAY);
      add(`i${i.id}:overdue`, late > 30 ? 'critical' : 'high', `Overdue ${late}d — ${i.company_name}`, `${i.number} · ${money} · due ${md(i.due_date)}`, i.due_date, { label: 'Statement', href: `/billing/parties/${i.company_id}/statement` }, s);
    }
  }
  const vinv = db.get("SELECT COUNT(*) AS n, MIN(created_at) AS first FROM documents WHERE doc_type = 'VINV' AND invoice_id IS NULL");
  if (vinv.n) add('g:vinv', 'high', `${vinv.n} vendor invoice(s) to book`, 'Read automatically — check and book', null, { label: 'Book', href: '/vendor-bills' });
  return out;
}

function globalItems({ db = store.db } = {}) {
  const out = [];
  const intakes = db.get("SELECT COUNT(*) AS n FROM intakes WHERE status = 'PENDING'").n;
  if (intakes) out.push({ key: 'g:intakes', area: 'ops', severity: 'high', title: `${intakes} agent upload(s) to review`, detail: 'Documents extracted — confirm and apply to the file', due: iso(Date.now()), action: { label: 'Review', href: '/intakes' } });
  const failed = db.get("SELECT COUNT(*) AS n FROM emails WHERE status = 'FAILED'").n;
  if (failed) out.push({ key: 'g:failed', area: 'ops', severity: 'critical', title: `${failed} email(s) failed to send`, detail: 'Customers / brokers / truckers did not receive them — resend', due: iso(Date.now()), action: { label: 'Outbox', href: '/outbox' } });
  return out;
}

/**
 * All open follow-ups visible to `user`, snoozed / done ones removed, sorted by severity then due date.
 * mine: only files where the user is PIC (plus unassigned and global items for admins).
 */
function forUser(user, { db = store.db, now = new Date(), mine = false, owner = null, area = '', shipmentId = null, includeHidden = false } = {}) {
  const auth = require('./auth');
  const rows = shipmentId ? [S.list(user, { db }).find((x) => x.id === shipmentId)].filter(Boolean) : S.list(user, { db, stage: 'open' });
  const ids = rows.map((r) => r.id);
  const docs = new Map();
  if (ids.length) {
    for (const r of db.all(`SELECT shipment_id, doc_type FROM documents WHERE shipment_id IN (${ids.map(() => '?').join(',')})`, ...ids)) {
      if (!docs.has(r.shipment_id)) docs.set(r.shipment_id, new Set());
      docs.get(r.shipment_id).add(r.doc_type);
    }
  }
  let items = rows.flatMap((s) => shipmentItems(s, { now, docs: docs.get(s.id) || new Set() }));
  if (auth.canAccounting(user)) {
    const acct = accountingItems({ db, now, rows });
    items = items.concat(shipmentId ? acct.filter((i) => i.shipment_id === shipmentId) : acct);
  }
  if (!shipmentId) items = items.concat(globalItems({ db }));
  items = items.concat(taskItems({ db, shipmentId, now }));
  if (area) items = items.filter((i) => i.area === area);
  if (mine) items = items.filter((i) => i.owner_id === user.id || (i.area === 'acct' && auth.canAccounting(user)) || (!i.shipment_id && i.task !== 'Task') || (!i.owner_id && user.role === 'admin'));
  if (owner) items = items.filter((i) => i.owner_id === owner);
  for (const i of items) if (!i.task) i.task = taskOf(i.key);
  const state = new Map(db.all('SELECT * FROM followup_state').map((r) => [r.key, r]));
  const nowIso = now.toISOString();
  for (const i of items) {
    const st = state.get(i.key);
    i.hidden = st && (st.done_at || (st.snoozed_until && st.snoozed_until > nowIso)) ? (st.done_at ? 'done' : 'snoozed') : null;
  }
  if (!includeHidden) items = items.filter((i) => !i.hidden);
  // One-click actions only for what the user may do; otherwise the item links to the file.
  for (const i of items) {
    const p = i.action?.post || '';
    const need = /\/actions\//.test(p) ? 'send_notices' : /\/track$/.test(p) ? 'shipments_edit' : null;
    if (need && !auth.can(user, need)) i.action = { label: 'Open file', href: `/shipments/${i.shipment_id}` };
  }
  items.sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity] || String(a.due).localeCompare(String(b.due)));
  return items;
}

/** Action Center tasks as follow-ups (owner = assignee; "remind later" moves the reminder). */
function taskItems({ db = store.db, shipmentId = null, now = new Date() } = {}) {
  const nowIso = now.toISOString();
  const rows = db.all(`SELECT t.*, s.ref_no FROM tasks t LEFT JOIN shipments s ON s.id = t.shipment_id
    WHERE t.status = 'OPEN' ${shipmentId ? 'AND t.shipment_id = ?' : ''}`, ...(shipmentId ? [shipmentId] : []));
  return rows.filter((t) => !t.remind_at || t.remind_at <= nowIso).map((t) => {
    const s = t.shipment_id ? S.find(t.shipment_id, null, { db }) : null;
    return { key: `t${t.id}:task`, task: 'Task', taskId: t.id, area: 'ops', severity: t.due_date && t.due_date < iso(Date.now()) ? 'high' : 'normal', title: t.title,
      detail: t.note || (t.ref_no ? `File ${t.ref_no}` : 'Task'), due: t.due_date || iso(Date.now()), shipment_id: t.shipment_id, owner_id: t.assignee_id, s,
      action: t.shipment_id ? { label: 'Open file', href: `/shipments/${t.shipment_id}` } : null };
  });
}

/** Per person: alerts (critical + high) and warnings (normal) — the team to-do summary. */
function teamSummary(user, { db = store.db, now = new Date() } = {}) {
  const items = forUser(user, { db, now });
  const staff = db.all("SELECT id, name FROM users WHERE role IN ('admin', 'staff') AND active = 1 ORDER BY name");
  const rows = staff.map((u) => {
    const mine = items.filter((i) => i.owner_id === u.id);
    return { id: u.id, name: u.name, alerts: mine.filter((i) => i.severity !== 'normal').length, warnings: mine.filter((i) => i.severity === 'normal').length };
  });
  const none = items.filter((i) => !i.owner_id && i.shipment_id);
  if (none.length) rows.push({ id: 0, name: 'No PIC', alerts: none.filter((i) => i.severity !== 'normal').length, warnings: none.filter((i) => i.severity === 'normal').length });
  return rows.filter((r) => r.alerts || r.warnings);
}

/** Group items by task, in a fixed order. */
function byTask(items) {
  const g = new Map();
  for (const i of items) { const t = i.task || taskOf(i.key); if (!g.has(t)) g.set(t, []); g.get(t).push(i); }
  return [...g.entries()].sort((a, b) => (TASK_ORDER.indexOf(a[0]) + 1 || 99) - (TASK_ORDER.indexOf(b[0]) + 1 || 99)).map(([task, list]) => ({ task, list }));
}

function snooze(key, days = 1, { db = store.db, userId = null } = {}) {
  const t = /^t(\d+):task$/.exec(key);
  if (t) { db.run('UPDATE tasks SET remind_at = ? WHERE id = ?', new Date(Date.now() + days * DAY).toISOString(), Number(t[1])); return; }
  const until = new Date(Date.now() + days * DAY).toISOString();
  db.run('INSERT INTO followup_state (key, snoozed_until, user_id) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET snoozed_until = excluded.snoozed_until, done_at = NULL, user_id = excluded.user_id', key, until, userId);
}
function done(key, { db = store.db, userId = null } = {}) {
  const t = /^t(\d+):task$/.exec(key);
  if (t) { db.run("UPDATE tasks SET status = 'DONE', done_at = datetime('now') WHERE id = ?", Number(t[1])); return; }
  db.run("INSERT INTO followup_state (key, done_at, user_id) VALUES (?, datetime('now'), ?) ON CONFLICT(key) DO UPDATE SET done_at = datetime('now'), user_id = excluded.user_id", key, userId);
}
function reopen(key, { db = store.db } = {}) { db.run('DELETE FROM followup_state WHERE key = ?', key); }

function counts(items) {
  return { total: items.length, critical: items.filter((i) => i.severity === 'critical').length, high: items.filter((i) => i.severity === 'high').length };
}

module.exports = { taskItems, teamSummary, byTask, taskOf, TASKS, shipmentItems, accountingItems, globalItems, forUser, snooze, done, reopen, counts };
