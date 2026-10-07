const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const multer = require('multer');
const config = require('../config');
const store = require('../db');
const auth = require('../auth');
const S = require('../shipments');
const notify = require('../notify');
const { expandMailFiles } = require('../extract/mailfile');

const router = express.Router();
const upload = multer({ dest: path.join(config.uploadDir, 'shipments'), limits: { fileSize: 25 * 1024 * 1024, files: 20 } });

const companies = (type) => store.db.all(`SELECT id, name FROM companies WHERE ${require('../partyTypes').sql(type)} ORDER BY name`);
const partyLists = () => ({
  customers: companies('customer'), agents: companies('agent'), brokers: companies('broker'),
  truckers: companies('trucker'), deliveries: companies('delivery'),
  staffUsers: store.db.all("SELECT id, name FROM users WHERE role IN ('admin', 'staff') AND active = 1 ORDER BY name"),
});
const safeBack = (v) => (typeof v === 'string' && /^\/(?!\/)/.test(v) ? v : null);
const flash = (req, type, msg) => { req.session.flash = { type, msg }; };

// ---------- internal dashboard ----------
router.get('/dashboard', auth.requireInternal, (req, res) => {
  const db = store.db;
  const active = S.list(req.user, { active: true });
  const in7 = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  // Profit / billing summary on the dashboard: admins only (accounting staff use the accounting pages).
  const acct = req.user.role === 'admin';
  const delivered = acct ? S.list(req.user, { stage: 'delivered' }).map((s) => S.billingState(s)) : [];
  const kpi = {
    active: active.length,
    notInvoiced: acct ? delivered.filter((b) => b?.code === 'not_invoiced').length : null,
    awaiting: acct ? delivered.filter((b) => ['unsent', 'awaiting', 'overdue'].includes(b?.code)).length : null,
    noCost: acct ? S.list(req.user, { stage: 'delivered' }).filter((s) => S.costState(s)?.code === 'no_cost').length : null,
    vendorToBook: acct ? db.get("SELECT COUNT(*) AS n FROM documents WHERE doc_type = 'VINV' AND invoice_id IS NULL").n : null,
    arriving: active.filter((s) => s.eta && s.eta >= today && s.eta <= in7).length,
    intakes: db.get("SELECT COUNT(*) AS n FROM intakes WHERE status = 'PENDING'").n,
    exam: active.filter((s) => s.customs_status === 'EXAM' || s.customs_status === 'HOLD').length,
    unpaid: acct ? db.get("SELECT COUNT(*) AS n FROM invoices WHERE kind = 'AR' AND status = 'OPEN'").n : null,
    failedEmails: db.get("SELECT COUNT(*) AS n FROM emails WHERE status = 'FAILED'").n,
  };
  const events = db.all(`SELECT e.*, s.ref_no, s.shipper_name, s.hbl_no, s.mbl_no,
      (SELECT k.container_no FROM containers k WHERE k.shipment_id = s.id ORDER BY k.id LIMIT 1) AS first_ctn,
      (SELECT COUNT(*) FROM containers k WHERE k.shipment_id = s.id) AS ctn_count
    FROM events e JOIN shipments s ON s.id = e.shipment_id ORDER BY e.id DESC LIMIT 15`);
  // LFD watch: not yet picked up, sorted by days left.
  const lfdWatch = active.map((s) => ({ s, lfd: S.lfdInfo(s), next: S.checklist(s).find((x) => x.next) }))
    .filter((x) => x.lfd && x.lfd.days <= 5).sort((a, b) => a.lfd.days - b.lfd.days);
  kpi.lfd = lfdWatch.filter((x) => x.lfd.days <= 1).length;
  const F = require('../followups');
  const mineItems = F.forUser(req.user, { mine: true });
  // Management numbers: admins only.
  const mgmt = acct ? require('../insights').dashboard(req.query) : null;
  // Action Center: my tasks (and ones I gave others), the latest emails read into the system; team to-do summary.
  const tasks = db.all(`SELECT t.*, s.ref_no, s.hbl_no, u.name AS assignee FROM tasks t LEFT JOIN shipments s ON s.id = t.shipment_id LEFT JOIN users u ON u.id = t.assignee_id
    WHERE t.status = 'OPEN' AND (t.assignee_id = ? OR t.created_by = ?) ORDER BY COALESCE(t.due_date, '9999'), t.id LIMIT 30`, req.user.id, req.user.id);
  const mails = db.all(`SELECT m.*, i.status AS intake_status, i.shipment_id FROM mail_imports m LEFT JOIN intakes i ON i.id = m.intake_id ORDER BY m.created_at DESC LIMIT 8`);
  const staffUsers = db.all("SELECT id, name FROM users WHERE role IN ('admin', 'staff') AND active = 1 ORDER BY name");
  res.render('dashboard', { title: 'Dashboard', kpi, active, events, lfdWatch, followups: mineItems, fcount: F.counts(mineItems), mgmt,
    tasks, mails, staffUsers, team: F.teamSummary(req.user) });
});

/** Customers with no file for 60+ days (sales follow-up); "ignore" hides one-off customers. */
router.get('/insights/lost', auth.requireRole('admin'), (req, res) => {
  const I = require('../insights');
  const p = I.period(req.query);
  const view = ['all', 'ignored'].includes(req.query.view) ? req.query.view : 'active';
  res.render('insights/lost', { title: 'Lost customers', p, view, rows: I.lostCustomers(p.to, { view }), days: I.LOST_DAYS, q: req.query });
});
router.post('/insights/lost/:id', auth.requireRole('admin'), (req, res) => {
  store.db.run('UPDATE companies SET lost_ignored = ? WHERE id = ?', req.body.ignore === '1' ? 1 : 0, Number(req.params.id));
  if (req.get('accept')?.includes('json')) return res.json({ ok: true });
  res.redirect(req.get('referer') || '/insights/lost');
});

/** Files that lost money in the period, by house B/L or by master B/L. */
router.get('/insights/negative', auth.requireRole('admin'), (req, res) => {
  const I = require('../insights');
  const p = I.period(req.query);
  const by = req.query.by === 'mbl' ? 'mbl' : 'hbl';
  const status = ['ignored', 'all'].includes(req.query.status) ? req.query.status : 'notice';
  res.render('insights/negative', { title: 'Negative profit files', p, by, status, neg: I.negative(p, { by, status }), q: req.query });
});
router.post('/shipments/:id/profit-note', auth.requireRole('admin'), (req, res) => {
  const ids = String(req.body.ids || req.params.id).split(',').map(Number).filter(Boolean);
  for (const id of ids) {
    if ('remark' in req.body) store.db.run('UPDATE shipments SET profit_remark = ? WHERE id = ?', String(req.body.remark || '').slice(0, 300) || null, id);
    if ('ignore' in req.body) store.db.run('UPDATE shipments SET profit_ignore = ? WHERE id = ?', req.body.ignore === '1' ? 1 : 0, id);
  }
  if (req.get('accept')?.includes('json')) return res.json({ ok: true });
  res.redirect(req.get('referer') || '/insights/negative');
});

// ---------- list ----------
const STAGES = { open: 'All open', active: 'Active (before delivery)', delivered: 'Delivered — billing open', all: 'All' };
router.get('/shipments', auth.requireLogin, (req, res) => {
  if (req.user.role === 'customer') return res.redirect('/track');
  const { q = '', status = '', mode = '' } = req.query;
  const internal = auth.INTERNAL.includes(req.user.role);
  const stage = internal && STAGES[req.query.stage] ? req.query.stage : internal ? 'open' : 'all';
  const mine = internal && req.query.mine === '1';
  const sort = ['asc', 'desc'].includes(req.query.sort) ? req.query.sort : '';
  const noCustomer = req.query.nocust === '1';
  let rows = S.list(req.user, { q, status, mode, stage: stage === 'all' ? null : stage, owner: mine ? req.user.id : null, sort, noCustomer });
  // Accounting follow-up filters on delivered files.
  const bill = auth.canAccounting(req.user) ? req.query.bill || '' : '';
  if (bill) {
    rows = rows.filter((s) => (S.billingState(s)?.code || '') === bill || (bill === 'unpaid' && ['unsent', 'awaiting', 'overdue'].includes(S.billingState(s)?.code))
      || (['no_cost', 'to_book'].includes(bill) && S.costState(s)?.code === bill));
  }
  const pickupCount = internal ? require('./worklists').containerRows(req.user, { tab: 'pickup', type: 'fcl' }).tabs.pickup : 0;
  res.locals.pickupCount = pickupCount;
  res.locals.journey = (s) => require('../stages').stages(s, s.containers?.[0] || {});
  res.locals.staffUsers = internal ? store.db.all("SELECT id, name FROM users WHERE role IN ('admin', 'staff') AND active = 1 ORDER BY name") : [];
  res.render('shipments/list', { title: { OCEAN: 'House B/L list · Ocean', AIR: 'HAWB list · Air', TRUCK: 'Truck files', OTHER: 'Other files' }[mode] || 'Shipments', rows, q, status, mode, stage, STAGES, bill, history: false, mine, sort });
});

/** Shipment history: closed files (customer paid), kept for look-up later. */
router.get('/history', auth.requireInternal, (req, res) => {
  const { q = '', mode = '' } = req.query;
  const sort = req.query.sort === 'asc' ? 'asc' : 'desc';
  const rows = S.list(req.user, { q, mode, stage: 'closed', sort });
  const A = require('../accounting');
  if (auth.canAccounting(req.user)) for (const r of rows) r.pl = A.shipmentProfit(r.id);
  res.render('shipments/list', { title: 'Shipment history', rows, q, status: '', mode, stage: 'closed', STAGES, bill: '', history: true, mine: false, sort });
});

/** Form helper: what past files suggest for the fields still empty (carrier, pick-up location, delivery). */
router.get('/shipments/autofill.json', auth.requireInternal, (req, res) => {
  const q = req.query;
  const keys = ['id', 'mode', 'mbl_no', 'carrier', 'scac', 'pod', 'agent_id', 'customer_id', 'consignee_name', 'ctn', ...require('../autofill').PICKUP, ...require('../autofill').DELIVERY];
  const s = Object.fromEntries(keys.map((k) => [k, typeof q[k] === 'string' ? q[k].trim().slice(0, 300) : '']));
  s.id = Number(s.id) || 0;
  s.containers = s.ctn ? [{ container_no: s.ctn.toUpperCase() }] : [];
  res.json(require('../autofill').suggest(s));
});

router.get('/shipments/new', auth.requirePerm('shipments_edit'), (req, res) => {
  let mode = S.MODES[req.query.mode] ? req.query.mode : 'FCL';
  const s = { mode, status: 'BOOKED', customs_status: 'PENDING', containers: [], items: [] };
  // "+ Add house B/L" on a master: the carrier leg comes from the master.
  const m = req.query.master ? require('../masters').get(Number(req.query.master)) : null;
  if (m) {
    mode = m.mode; Object.assign(s, { mode, master_id: m.id, agent_id: m.agent_id });
    for (const k of require('../masters').SHARED) if (m[k]) s[k] = m[k];
  }
  res.render('shipments/form', { title: mode === 'OTHER' ? 'New other file' : m ? `New house B/L under ${m.mbl_no || m.ref_no}` : 'New shipment', s, master: m, ...partyLists() });
});

/** Non-accounting staff cannot set prices / invoice / paid fields. */
function stripAccounting(req) {
  if (!auth.canAccounting(req.user)) for (const f of auth.ACCOUNTING_FIELDS) delete req.body[f];
  return req.body;
}

router.post('/shipments', auth.requirePerm('shipments_edit'), (req, res) => {
  require('../extract/party').fromForm(req.body, 'customer_id');
  const id = S.create(stripAccounting(req), { userId: req.user.id });
  S.saveLines(id, req.body);
  const tracking = req.body.mode !== 'OTHER' && require('../tracking').refreshSoon(id, { userId: req.user.id });
  flash(req, 'ok', req.body.mode === 'OTHER' ? 'Other file created — add its invoices / vendor bills below' : `Shipment created${tracking ? ' — ETD / ETA are being fetched from tracking' : ''}`);
  res.redirect(`/shipments/${id}`);
});

// ---------- detail ----------
router.get('/shipments/:id', auth.requireLogin, (req, res) => {
  const s = S.find(Number(req.params.id), req.user);
  if (!s) return res.status(404).render('error', { title: 'Not found', message: 'Shipment not found.' });
  // Staff can preview exactly what the customer sees with ?view=customer.
  const internal = auth.INTERNAL.includes(req.user.role) && req.query.view !== 'customer';
  const viewer = internal || !auth.INTERNAL.includes(req.user.role) ? req.user : { role: 'customer' };
  const db = store.db;
  const hideAcct = auth.canAccounting(req.user) ? '' : `AND doc_type NOT IN (${auth.ACCOUNTING_DOCS.map((t) => `'${t}'`).join(',')})`;
  const docs = db.all(`SELECT * FROM documents WHERE shipment_id = ? ${hideAcct} ${internal ? '' : docFilter(viewer)} ORDER BY id DESC`, s.id);
  // The master's MB/L belongs to every house (staff only).
  if (internal && s.master_id) docs.push(...db.all('SELECT *, 1 AS from_master FROM documents WHERE master_id = ? AND shipment_id IS NULL ORDER BY id DESC', s.master_id));
  // Same file uploaded twice ("x.pdf" / "x (3).pdf", same size): the newer copy is marked as a duplicate.
  const seenDoc = new Map();
  for (const d of [...docs].reverse()) {
    const key = `${d.doc_type}|${String(d.filename).toLowerCase().replace(/\s*\(\d+\)(?=\.[a-z0-9]+|\s*\[|$)/g, '').replace(/\s+/g, ' ')}|${d.size || ''}`;
    if (seenDoc.has(key)) d.duplicate_of = seenDoc.get(key); else seenDoc.set(key, d.id);
  }
  const events = db.all(`SELECT * FROM events WHERE shipment_id = ? ${internal ? '' : 'AND customer_visible = 1'} ORDER BY id DESC`, s.id);
  const emails = internal ? db.all(`SELECT id, kind, to_addr, subject, status, created_at FROM emails WHERE shipment_id = ?
    ${auth.canAccounting(req.user) ? '' : `AND kind NOT IN (${auth.ACCOUNTING_EMAILS.map((k) => `'${k}'`).join(',')})`} ORDER BY id DESC`, s.id) : [];
  const A = require('../accounting');
  const acct = auth.canAccounting(req.user);
  const invoices = internal && acct ? A.listInvoices({ shipmentId: s.id }) : [];
  const profit = internal && acct ? A.shipmentProfit(s.id) : null;
  const plLines = internal && acct ? A.shipmentLines(s.id) : [];
  // Review & send: AR to the customer, D/N or C/N to the agent — with the address each one goes to.
  const outgoing = invoices.filter((i) => i.kind !== 'AP' && i.status !== 'VOID').map((i) => {
    const c = db.get('SELECT emails, billing_emails FROM companies WHERE id = ?', i.company_id) || {};
    return { ...i, to: require('../invoicing').emailsOf(c) };
  });
  const vendorPending = internal && acct ? require('../vendorbills').pending().filter((d) => d.shipment_id === s.id) : [];
  const acctParties = internal && acct ? db.all('SELECT id, name, type, types FROM companies ORDER BY type, name') : [];
  const trackEvents = db.all("SELECT * FROM tracking_events WHERE shipment_id = ? AND classifier IN ('ACT', '') ORDER BY event_time DESC LIMIT 30", s.id);
  const view = internal ? 'shipments/detail' : 'customer/detail';
  const nextActions = internal ? require('../followups').forUser(req.user, { shipmentId: s.id }) : [];
  // No customer on the file yet but the B/L names a consignee that is not on Parties → offer to add it.
  let newCustomer = null;
  if (internal && !s.customer_id && s.consignee_name && !/^(TO\s+(THE\s+)?ORDER|SAME\s+AS)/i.test(s.consignee_name)) {
    const P = require('../extract/party');
    if (!P.findParty(s.consignee_name)) newCustomer = { name: s.consignee_name, address: s.consignee_address };
  }
  const trackLink = internal ? require('../tracking/codes').trackUrl(s) : null;
  const FT = require('../fileTools');
  const tools = internal ? {
    memos: FT.memos(s.id), badges: FT.badges(s),
    masters: db.all(`SELECT id, ref_no, mbl_no, eta FROM masters WHERE ${s.mode === 'AIR' ? "mode = 'AIR'" : "mode <> 'AIR'"} AND id IS NOT ? ORDER BY id DESC LIMIT 150`, s.master_id || null),
    blockedBy: s.blocked_by ? db.get('SELECT name FROM users WHERE id = ?', s.blocked_by)?.name : null,
    lockedBy: s.locked_by ? db.get('SELECT name FROM users WHERE id = ?', s.locked_by)?.name : null,
    releasedBy: s.lock_released_by ? db.get('SELECT name FROM users WHERE id = ?', s.lock_released_by)?.name : null,
    credit: require('../credit').forShipment(s),
    tasks: db.all("SELECT t.*, u.name AS assignee FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id WHERE t.shipment_id = ? AND t.status = 'OPEN' ORDER BY t.due_date", s.id),
  } : {};
  const portalHide = internal ? null : require('../portal').hiddenFor(s.customer_id);
  res.render(view, { title: S.fileName(s), s, trackLink, tools, portalHide, newCustomer, nextActions, tr: S.tracking(s), docs, events, emails, trackEvents, invoices, profit, plLines, acctParties, outgoing, vendorPending, autoSend: db.setting('auto_send_reviewed') === '1',
    codes: A.CHARGE_CODES, billing: acct ? S.billingState(s) : null, trackingStatus: require('../tracking').status(), ...(internal ? partyLists() : {}) });
});

/** Which documents each external role may download. */
function docFilter(user) {
  if (user.role === 'customer') return 'AND customer_visible = 1';
  if (user.role === 'broker') return "AND doc_type IN ('AN','HBL','MBL','PL','CI','ISF','ATME','AWB')";
  if (user.role === 'trucker') return "AND doc_type IN ('DO','PL')";
  if (user.role === 'agent') return "AND source = 'upload'";
  return 'AND 0';
}

router.post('/shipments/:id', auth.requirePerm('shipments_edit'), async (req, res) => {
  const id = Number(req.params.id);
  if (store.db.get('SELECT blocked_at FROM shipments WHERE id = ?', id)?.blocked_at) {
    flash(req, 'err', 'This file is blocked — unblock it from Tools first');
    return res.redirect(`/shipments/${id}`);
  }
  require('../locks').assertUnlocked(id);
  const addedCustomer = require('../extract/party').fromForm(req.body, 'customer_id');
  if (req.body.accept_delivery_request) {
    const cur = store.db.get('SELECT delivery_request_date, delivery_request_time FROM shipments WHERE id = ?', id);
    if (cur?.delivery_request_date) req.body.delivery_date = cur.delivery_request_date;
    if (cur?.delivery_request_time) req.body.delivery_time = cur.delivery_request_time;
    store.db.run('UPDATE shipments SET delivery_request_done = 1 WHERE id = ?', id);
  }
  const changes = S.update(id, stripAccounting(req));
  S.saveLines(id, req.body);
  await notify.onShipmentChanged(id, changes, { userId: req.user.id });
  // New / changed B/L, or still no ETA: ask the tracking source now instead of waiting for the next round.
  const cur = store.db.get('SELECT eta, tracking_checked_at FROM shipments WHERE id = ?', id);
  if (changes.some((c) => c.field === 'mbl_no') || !cur?.eta || !cur?.tracking_checked_at) require('../tracking').refreshSoon(id, { userId: req.user.id });
  const miss = S.missingRequired(S.find(id, null));
  flash(req, 'ok', `${changes.length ? `Saved (${changes.length} field${changes.length > 1 ? 's' : ''} changed)` : 'Saved'}${addedCustomer ? ` · ${addedCustomer} added to Parties as a new customer` : ''}${miss.length ? ` · still required: ${miss.join(', ')}` : ''}`);
  res.redirect(`/shipments/${id}`);
});

// ---------- Tools: copy / move / block, memo log ----------
router.post('/shipments/:id/copy', auth.requirePerm('shipments_edit'), (req, res) => {
  const nid = require('../fileTools').copy(Number(req.params.id), { userId: req.user.id });
  flash(req, 'ok', `Copy created (${store.db.get('SELECT ref_no FROM shipments WHERE id = ?', nid).ref_no}) — parties and lane copied; add the B/L, containers and dates`);
  res.redirect(`/shipments/${nid}#edit`);
});
router.post('/shipments/:id/move', auth.requirePerm('shipments_edit'), (req, res) => {
  const id = Number(req.params.id);
  require('../locks').assertUnlocked(id);
  try {
    require('../fileTools').move(id, Number(req.body.master_id), { userId: req.user.id });
    flash(req, 'ok', 'Moved to the other master — carrier leg updated from it');
  } catch (e) { flash(req, 'err', e.message); }
  res.redirect(`/shipments/${id}`);
});
router.post('/shipments/:id/block', auth.requirePerm('shipments_edit'), (req, res) => {
  const id = Number(req.params.id);
  require('../fileTools').block(id, req.body.on === '1', { reason: req.body.reason, userId: req.user.id });
  flash(req, 'ok', req.body.on === '1' ? 'File blocked — nobody can change it until it is unblocked' : 'File unblocked');
  res.redirect(`/shipments/${id}`);
});
router.post('/shipments/:id/memos', auth.requireInternal, (req, res) => {
  require('../fileTools').addMemo(Number(req.params.id), req.body, { userId: req.user.id });
  res.redirect(`/shipments/${req.params.id}#memos`);
});
// Credit hold: an admin lets this one file's cargo go (or takes that back).
router.post('/shipments/:id/credit-release', auth.requireRole('admin'), (req, res) => {
  const id = Number(req.params.id);
  const on = req.body.on === '1';
  store.db.run('UPDATE shipments SET credit_released_at = ?, credit_released_by = ? WHERE id = ?', on ? new Date().toISOString() : null, on ? req.user.id : null, id);
  S.addEvent(id, 'CREDIT_RELEASE', on ? `Released despite credit hold by ${req.user.name}` : 'Credit release withdrawn', { userId: req.user.id, customerVisible: false });
  flash(req, 'ok', on ? 'This file may be released (D/O) despite the credit hold' : 'Credit hold applies to this file again');
  res.redirect(`/shipments/${id}`);
});

// Accounting lock: only an admin locks or unlocks by hand; unlocking needs a reason (kept in the file history).
router.post('/shipments/:id/lock', auth.requireRole('admin'), (req, res) => {
  const id = Number(req.params.id);
  const L = require('../locks');
  if (req.body.on === '1') { L.lock(id, { userId: req.user.id }); flash(req, 'ok', 'File locked — nobody can change it or its invoices until an admin unlocks it'); }
  else {
    try { L.unlock(id, { userId: req.user.id, reason: req.body.reason }); flash(req, 'ok', 'File unlocked — lock it again when you are done (it will not lock itself again)'); }
    catch (e) { flash(req, 'err', e.message); }
  }
  res.redirect(`/shipments/${id}`);
});

router.post('/memos/:id/delete', auth.requireInternal, (req, res) => {
  const m = store.db.get('SELECT * FROM shipment_memos WHERE id = ?', Number(req.params.id));
  if (m && (m.user_id === req.user.id || req.user.role === 'admin')) store.db.run('DELETE FROM shipment_memos WHERE id = ?', m.id);
  res.redirect(m ? `/shipments/${m.shipment_id}#memos` : '/shipments');
});

// ---------- accounting inside the file ----------
/** Quick entry from the shipment page: one invoice / vendor bill with its lines, booked to this file. */
router.post('/shipments/:id/accounting', auth.requireAccounting, (req, res) => {
  const id = Number(req.params.id);
  const s = S.find(id, null);
  if (!s) return res.status(404).end();
  const A = require('../accounting');
  const arr = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
  const lines = arr(req.body.l_desc).map((d, i) => ({ description: d, rate: arr(req.body.l_rate)[i], qty: arr(req.body.l_qty)[i], amount: arr(req.body.l_amount)[i] }))
    .filter((l) => String(l.description || '').trim() && [l.amount, l.rate].some((v) => String(v ?? '').trim() !== ''));
  if (!lines.length) { flash(req, 'err', 'Add at least one line with a description and amount'); return res.redirect(`/shipments/${id}#accounting`); }
  const kind = ['AR', 'DN', 'AP'].includes(req.body.kind) ? req.body.kind : 'AR';
  if (kind === 'AP' && !String(req.body.number || '').trim()) { flash(req, 'err', 'Enter the vendor invoice number'); return res.redirect(`/shipments/${id}#accounting`); }
  const data = { kind, allow_duplicate: req.body.allow_duplicate === '1', shipment_id: id, company_id: req.body.company_id, number: req.body.number, invoice_date: req.body.invoice_date, terms_days: req.body.terms_days, memo: req.body.memo, lines };
  if (kind === 'AR') Object.assign(data, { ship_to: s.consignee_name || '', customer_ref: s.customer_ref || '' });
  if (kind === 'DN') Object.assign(data, { agent_ref: s.agent_ref || s.sub_bl_no || s.hbl_no || '', profit_share: 0, lines: lines.map((l) => ({ ...l, mh: 'H', bl_no: s.hbl_no, pc: 'C',
    side: Number(String(l.amount ?? '').replace(/,/g, '')) < 0 ? 'CREDIT' : 'DEBIT', amount: l.amount === '' || l.amount == null ? l.amount : Math.abs(Number(String(l.amount).replace(/,/g, ''))) })) });
  try {
    const invId = A.saveInvoice(data, { userId: req.user.id });
    const inv = A.getInvoice(invId);
    flash(req, 'ok', `${inv.number} saved — ${inv.lines.length} line(s), USD ${inv.total.toLocaleString('en-US', { minimumFractionDigits: 2 })}`);
  } catch (e) {
    flash(req, 'err', e.code === 'DUPLICATE' ? require('./billing').dupMessage(e) : e.message);
  }
  res.redirect(`/shipments/${id}#accounting`);
});

router.post('/shipments/:id/close', auth.requireAccounting, (req, res) => {
  const id = Number(req.params.id);
  S.setClosed(id, req.body.closed === '1', { userId: req.user.id });
  flash(req, 'ok', req.body.closed === '1' ? 'File closed — moved to Shipment history' : 'File reopened');
  res.redirect(`/shipments/${id}`);
});

router.post('/shipments/:id/delete', auth.requirePerm('delete'), (req, res) => {
  require('../locks').assertUnlocked(Number(req.params.id));
  store.db.run('DELETE FROM shipments WHERE id = ?', Number(req.params.id));
  flash(req, 'ok', 'Shipment deleted');
  res.redirect('/shipments');
});

// ---------- actions: generate & send notices ----------
const ACTIONS = {
  'send-an': (id, u) => notify.sendBrokerPacket(id, { userId: u.id }).then(() => 'Arrival notice & documents sent to customs broker'),
  'send-do': (id, u) => notify.sendDeliveryOrder(id, { userId: u.id }).then((r) => (r ? 'Delivery order sent to trucker' : 'D/O not sent — credit hold on the customer, or no trucker email (see History)')),
  'send-update': (id, u) => notify.sendCustomerUpdate(id, 'Shipment status update', { userId: u.id }).then(() => 'Status update sent to customer'),
};
router.post('/shipments/:id/actions/:action', auth.requirePerm('send_notices'), async (req, res) => {
  const id = Number(req.params.id);
  const fn = ACTIONS[req.params.action];
  if (!fn) return res.status(400).render('error', { title: 'Unknown action', message: 'Unknown action.' });
  flash(req, 'ok', await fn(id, req.user));
  res.redirect(safeBack(req.body.back) || `/shipments/${id}#emails`);
});

router.post('/shipments/:id/track', auth.requirePerm('shipments_edit'), async (req, res) => {
  const r = await require('../tracking').refreshShipment(Number(req.params.id), { userId: req.user.id });
  flash(req, r.ok ? 'ok' : 'err', r.ok ? `Tracking updated${r.changes.length ? ` — ${r.changes.map((c) => c.field).join(', ')} changed` : ' — no changes'}` : `Tracking: ${r.error}`);
  res.redirect(safeBack(req.body.back) || `/shipments/${req.params.id}#tracking`);
});

// Preview renders the document without saving it (saved copies are created when a notice is sent).
router.get('/shipments/:id/preview/:type', auth.requireInternal, (req, res) => {
  const type = req.params.type.toUpperCase();
  const { GENERATORS } = require('../docs/templates');
  const s = S.find(Number(req.params.id), null);
  if (!GENERATORS[type] || !s) return res.status(404).render('error', { title: 'Not found', message: 'Unknown document.' });
  res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:");
  res.type('html').send(GENERATORS[type](s, notify.docContext(s, { userId: req.user.id })));
});

// Issue (save) a document without emailing it — e.g. to download and send manually.
router.post('/shipments/:id/issue/:type', auth.requirePerm('send_notices'), async (req, res) => {
  const type = req.params.type.toUpperCase();
  if (!['AN', 'DO', 'ATME'].includes(type)) return res.status(400).render('error', { title: 'Unknown document', message: 'Unknown document type.' });
  const d = await notify.generateDocument(Number(req.params.id), type, { userId: req.user.id });
  flash(req, 'ok', `${d.filename} issued`);
  res.redirect(`/shipments/${req.params.id}#docs`);
});

// ---------- send window (review recipients, subject, attachments, text before sending) ----------
const addrList = (v) => [...new Set(String(v || '').split(/[,;\s]+/).map((e) => e.trim().toLowerCase()).filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)))];
router.get('/shipments/:id/email/:kind', auth.requirePerm('send_notices'), (req, res) => {
  const d = notify.composeDefaults(req.params.kind.toUpperCase(), Number(req.params.id));
  if (!d) return res.status(404).render('error', { title: 'Not found', message: 'Unknown email.' });
  res.render('shipments/compose', { title: `Send email · ${d.s.ref_no}`, d, me: req.user, mailbox: config.mailTransport === 'outlook' ? config.graph.mailbox : config.mailTransport === 'smtp' ? config.smtp.from : null });
});
router.post('/shipments/:id/email/:kind', auth.requirePerm('send_notices'), upload.array('files', 10), auth.checkCsrf, async (req, res) => {
  const id = Number(req.params.id);
  const kind = req.params.kind.toUpperCase();
  const b = req.body;
  const arr = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
  const me = req.user.email && b.include_me ? [req.user.email.toLowerCase()] : [];
  // Files added in the window go on the file too (so the paper trail is complete).
  const extraDocs = [];
  for (const f of req.files || []) {
    const r = store.db.run(`INSERT INTO documents (shipment_id, doc_type, filename, stored_path, mime, size, uploaded_by) VALUES (?, 'OTHER', ?, ?, ?, ?, ?)`,
      id, f.originalname, f.path, f.mimetype, f.size, req.user.id);
    extraDocs.push(store.db.get('SELECT * FROM documents WHERE id = ?', Number(r.lastInsertRowid)));
  }
  try {
    await notify.sendComposed({
      kind, shipmentId: id, to: addrList(b.to), cc: addrList([b.cc, ...me].join(',')), bcc: addrList(b.bcc), replyTo: addrList(b.reply_to),
      subject: String(b.subject || '').trim().slice(0, 300), html: String(b.html || ''), generate: arr(b.generate), docIds: arr(b.doc_ids).map(Number).filter(Boolean), extraDocs,
    }, { userId: req.user.id });
    flash(req, 'ok', `Email sent — a copy is on the file${config.mailTransport === 'outlook' ? ' and in Outlook Sent Items' : ''}`);
    res.redirect(`/shipments/${id}#emails`);
  } catch (e) {
    flash(req, 'err', e.message);
    res.redirect(`/shipments/${id}/email/${kind}`);
  }
});

// Document viewer with a toolbar (print, issue PDF, email) around the preview.
router.get('/shipments/:id/doc/:type', auth.requireInternal, (req, res) => {
  const type = req.params.type.toUpperCase();
  const s = S.find(Number(req.params.id), null);
  if (!['AN', 'DO', 'ATME'].includes(type) || !s) return res.status(404).render('error', { title: 'Not found', message: 'Unknown document.' });
  res.render('shipments/docview', { title: `${{ AN: 'Arrival notice', DO: 'Delivery order', ATME: 'ATME' }[type]} · ${s.ref_no}`, s, type });
});

// ---------- documents ----------
router.post('/shipments/:id/documents', auth.requirePerm('shipments_edit'), upload.array('files', 20), auth.checkCsrf, async (req, res) => {
  const id = Number(req.params.id);
  // A dragged Outlook email (.msg / .eml) is stored as its attachments.
  const { files } = await expandMailFiles((req.files || []).map((f) => ({ buffer: fs.readFileSync(f.path), filename: f.originalname, mime: f.mimetype, path: f.path })));
  for (const f of req.files || []) if (!files.some((x) => x.path === f.path)) fs.rmSync(f.path, { force: true });
  if (req.body.doc_type === 'VINV') {
    const V = require('../vendorbills');
    for (const f of files) {
      await V.receive({ buffer: f.buffer, filename: f.filename, mime: f.mime, shipmentId: id, userId: req.user.id });
      if (f.path) fs.rmSync(f.path, { force: true });
    }
    flash(req, 'ok', `${files.length} vendor invoice(s) read and sent to accounting to book`);
    return res.redirect(`/shipments/${id}#docs`);
  }
  // P/L, C/I or a combined C/I + P/L: read the cargo lines and add them to the file (same invoice replaced).
  const readLines = ['PL', 'CI', 'CIPL'].includes(req.body.doc_type);
  const parts = [];
  for (const f of files) {
    let stored = f.path;
    if (readLines) {
      const got = await require('../extract/index').extractFile({ buffer: f.buffer, filename: f.filename, mime: f.mime, docTypeHint: req.body.doc_type === 'CIPL' ? 'AUTO' : req.body.doc_type }).catch(() => []);
      parts.push(...got.map((p) => ({ ...p, doc_type: p.doc_type === 'OTHER' ? req.body.doc_type : p.doc_type })));
    }
    if (!stored) {
      stored = path.join(config.uploadDir, 'shipments', `${crypto.randomBytes(12).toString('hex')}${path.extname(f.filename).toLowerCase()}`);
      fs.writeFileSync(stored, f.buffer);
    }
    store.db.run(`INSERT INTO documents (shipment_id, doc_type, filename, stored_path, mime, size, customer_visible, uploaded_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, id, req.body.doc_type === 'CIPL' ? 'CI' : req.body.doc_type || 'OTHER', f.filename, stored, f.mime, f.buffer.length,
    req.body.customer_visible ? 1 : 0, req.user.id);
  }
  let added = '';
  if (parts.length) {
    const { items } = require('../extract/index').mergeExtractions(parts);
    if (items.length) {
      const cur = S.find(id, null).items;
      const merged = S.mergeItems(cur, items);
      const col = (k) => merged.map((i) => i[k] ?? '');
      S.saveLines(id, { item_buyer: col('buyer'), item_inv: col('invoice_no'), item_po: col('po_no'), item_desc: col('description'), item_hs: col('hs_code'),
        item_qty: col('quantity'), item_unit: col('unit'), item_pkgs: col('packages'), item_kg: col('weight_kg'), item_cbm: col('cbm'), item_price: col('unit_price'), item_amount: col('amount') });
      const invs = [...new Set(items.map((i) => i.invoice_no).filter(Boolean))];
      added = ` · ${items.length} P/L line(s) added${invs.length ? ` (${invs.join(', ')})` : ''}`;
    }
  }
  flash(req, 'ok', `${files.length} file(s) uploaded${added}`);
  res.redirect(`/shipments/${id}#docs`);
});

router.post('/documents/:id/visibility', auth.requirePerm('shipments_edit'), (req, res) => {
  const d = store.db.get('SELECT * FROM documents WHERE id = ?', Number(req.params.id));
  if (!d) return res.status(404).end();
  store.db.run('UPDATE documents SET customer_visible = ? WHERE id = ?', d.customer_visible ? 0 : 1, d.id);
  res.redirect(`/shipments/${d.shipment_id}#docs`);
});

/** Delete documents from a file (one, or the checked ones). The stored file goes when no other document uses it. */
router.post('/documents/delete', auth.requirePerm('shipments_edit'), (req, res) => {
  const db = store.db;
  const arr = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
  const ids = (req.body.one ? [req.body.one] : arr(req.body.doc_ids)).map(Number).filter(Boolean);
  const back = `/shipments/${Number(req.body.shipment_id) || ''}#docs`;
  if (!ids.length) { flash(req, 'err', 'Tick the documents to delete first'); return res.redirect(back); }
  const files = [];
  let n = 0;
  db.tx(() => {
    for (const id of ids) {
      const d = db.get('SELECT * FROM documents WHERE id = ? AND shipment_id = ?', id, Number(req.body.shipment_id));
      if (!d) continue;
      if (auth.ACCOUNTING_DOCS.includes(d.doc_type) && !auth.canAccounting(req.user)) continue;
      db.run('UPDATE invoices SET document_id = NULL WHERE document_id = ?', d.id);
      db.run('DELETE FROM documents WHERE id = ?', d.id);
      if (d.stored_path && !db.get('SELECT 1 FROM documents WHERE stored_path = ?', d.stored_path)) files.push(d.stored_path);
      n++;
    }
  });
  for (const f of [...new Set(files)]) { try { fs.unlinkSync(f); } catch { /* already gone */ } }
  if (n) S.addEvent(Number(req.body.shipment_id), 'DOCS_DELETED', `${n} document(s) deleted`, { userId: req.user.id, customerVisible: false });
  flash(req, 'ok', `${n} document${n === 1 ? '' : 's'} deleted`);
  res.redirect(back);
});

/** Correct a document's type (e.g. a C/I read as OTHER). */
router.post('/documents/:id/type', auth.requirePerm('shipments_edit'), (req, res) => {
  const d = store.db.get('SELECT * FROM documents WHERE id = ?', Number(req.params.id));
  if (!d) return res.status(404).end();
  const t = String(req.body.doc_type || '').toUpperCase();
  if (/^[A-Z]{2,6}$/.test(t) && !(auth.ACCOUNTING_DOCS.includes(t) && !auth.canAccounting(req.user))) store.db.run('UPDATE documents SET doc_type = ? WHERE id = ?', t, d.id);
  res.redirect(`/shipments/${d.shipment_id}#docs`);
});

router.get('/documents/:id', auth.requireLogin, (req, res) => {
  const d = store.db.get('SELECT * FROM documents WHERE id = ?', Number(req.params.id));
  if (!d) return res.status(404).render('error', { title: 'Not found', message: 'Document not found.' });
  const internal = auth.INTERNAL.includes(req.user.role);
  if (auth.ACCOUNTING_DOCS.includes(d.doc_type) && !auth.canAccounting(req.user)) {
    return res.status(403).render('error', { title: 'Forbidden', message: 'Accounting documents are limited to authorized staff.' });
  }
  if (!internal) {
    const s = d.shipment_id && S.find(d.shipment_id, req.user);
    const allowed = s && store.db.get(`SELECT 1 FROM documents WHERE id = ? ${docFilter(req.user)}`, d.id);
    const ownIntake = req.user.role === 'agent' && d.uploaded_by === req.user.id;
    if (!allowed && !ownIntake) return res.status(403).render('error', { title: 'Forbidden', message: 'You do not have access to this document.' });
  }
  if (!d.stored_path || !fs.existsSync(d.stored_path)) return res.status(404).render('error', { title: 'Missing file', message: 'The file is no longer available.' });
  const inline = /^(application\/pdf|image\/|text\/html)/.test(d.mime || '');
  if (d.mime !== 'application/pdf') res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:");
  res.set('X-Content-Type-Options', 'nosniff');
  res.type(d.mime || 'application/octet-stream');
  res.set('Content-Disposition', `${inline && req.query.download === undefined ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(d.filename)}`);
  fs.createReadStream(d.stored_path).pipe(res);
});

module.exports = router;
module.exports.stripAccounting = stripAccounting;
