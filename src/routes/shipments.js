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
const upload = multer({ dest: path.join(config.uploadDir, 'shipments'), limits: { fileSize: 25 * 1024 * 1024, files: 10 } });

const companies = (type) => store.db.all('SELECT id, name FROM companies WHERE type = ? ORDER BY name', type);
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
  const acct = auth.canAccounting(req.user);
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
    unpaid: auth.canAccounting(req.user) ? db.get("SELECT COUNT(*) AS n FROM invoices WHERE kind = 'AR' AND status = 'OPEN'").n : null,
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
  res.render('dashboard', { title: 'Dashboard', kpi, active, events, lfdWatch, followups: mineItems, fcount: F.counts(mineItems) });
});

// ---------- list ----------
const STAGES = { open: 'All open', active: 'Active (before delivery)', delivered: 'Delivered — billing open', all: 'All' };
router.get('/shipments', auth.requireLogin, (req, res) => {
  if (req.user.role === 'customer') return res.redirect('/track');
  const { q = '', status = '', mode = '' } = req.query;
  const internal = auth.INTERNAL.includes(req.user.role);
  const stage = internal && STAGES[req.query.stage] ? req.query.stage : internal ? 'open' : 'all';
  const mine = internal && req.query.mine === '1';
  let rows = S.list(req.user, { q, status, mode, stage: stage === 'all' ? null : stage, owner: mine ? req.user.id : null });
  // Accounting follow-up filters on delivered files.
  const bill = auth.canAccounting(req.user) ? req.query.bill || '' : '';
  if (bill) {
    rows = rows.filter((s) => (S.billingState(s)?.code || '') === bill || (bill === 'unpaid' && ['unsent', 'awaiting', 'overdue'].includes(S.billingState(s)?.code))
      || (['no_cost', 'to_book'].includes(bill) && S.costState(s)?.code === bill));
  }
  res.render('shipments/list', { title: 'Shipments', rows, q, status, mode, stage, STAGES, bill, history: false, mine });
});

/** Shipment history: closed files (customer paid), kept for look-up later. */
router.get('/history', auth.requireInternal, (req, res) => {
  const { q = '', mode = '' } = req.query;
  const rows = S.list(req.user, { q, mode, stage: 'closed' });
  const A = require('../accounting');
  if (auth.canAccounting(req.user)) for (const r of rows) r.pl = A.shipmentProfit(r.id);
  res.render('shipments/list', { title: 'Shipment history', rows, q, status: '', mode, stage: 'closed', STAGES, bill: '', history: true, mine: false });
});

router.get('/shipments/new', auth.requirePerm('shipments_edit'), (req, res) => {
  res.render('shipments/form', { title: 'New shipment', s: { mode: 'FCL', status: 'BOOKED', customs_status: 'PENDING', containers: [], items: [] }, ...partyLists() });
});

/** Non-accounting staff cannot set prices / invoice / paid fields. */
function stripAccounting(req) {
  if (!auth.canAccounting(req.user)) for (const f of auth.ACCOUNTING_FIELDS) delete req.body[f];
  return req.body;
}

router.post('/shipments', auth.requirePerm('shipments_edit'), (req, res) => {
  const id = S.create(stripAccounting(req), { userId: req.user.id });
  S.saveLines(id, req.body);
  flash(req, 'ok', 'Shipment created');
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
  const acctParties = internal && acct ? db.all('SELECT id, name, type FROM companies ORDER BY type, name') : [];
  const trackEvents = db.all("SELECT * FROM tracking_events WHERE shipment_id = ? AND classifier IN ('ACT', '') ORDER BY event_time DESC LIMIT 30", s.id);
  const view = internal ? 'shipments/detail' : 'customer/detail';
  const nextActions = internal ? require('../followups').forUser(req.user, { shipmentId: s.id }) : [];
  res.render(view, { title: S.fileName(s), s, nextActions, tr: S.tracking(s), docs, events, emails, trackEvents, invoices, profit, plLines, acctParties, outgoing, vendorPending, autoSend: db.setting('auto_send_reviewed') === '1',
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
  if (req.body.accept_delivery_request) {
    const cur = store.db.get('SELECT delivery_request_date, delivery_request_time FROM shipments WHERE id = ?', id);
    if (cur?.delivery_request_date) req.body.delivery_date = cur.delivery_request_date;
    if (cur?.delivery_request_time) req.body.delivery_time = cur.delivery_request_time;
    store.db.run('UPDATE shipments SET delivery_request_done = 1 WHERE id = ?', id);
  }
  const changes = S.update(id, stripAccounting(req));
  S.saveLines(id, req.body);
  await notify.onShipmentChanged(id, changes, { userId: req.user.id });
  flash(req, 'ok', changes.length ? `Saved (${changes.length} field${changes.length > 1 ? 's' : ''} changed)` : 'Saved');
  res.redirect(`/shipments/${id}`);
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
  const data = { kind, shipment_id: id, company_id: req.body.company_id, number: req.body.number, invoice_date: req.body.invoice_date, terms_days: req.body.terms_days, memo: req.body.memo, lines };
  if (kind === 'AR') Object.assign(data, { ship_to: s.consignee_name || '', customer_ref: s.customer_ref || '' });
  if (kind === 'DN') Object.assign(data, { agent_ref: s.agent_ref || s.sub_bl_no || s.hbl_no || '', profit_share: 0, lines: lines.map((l) => ({ ...l, mh: 'H', bl_no: s.hbl_no, pc: 'C',
    side: Number(String(l.amount ?? '').replace(/,/g, '')) < 0 ? 'CREDIT' : 'DEBIT', amount: l.amount === '' || l.amount == null ? l.amount : Math.abs(Number(String(l.amount).replace(/,/g, ''))) })) });
  try {
    const invId = A.saveInvoice(data, { userId: req.user.id });
    const inv = A.getInvoice(invId);
    flash(req, 'ok', `${inv.number} saved — ${inv.lines.length} line(s), USD ${inv.total.toLocaleString('en-US', { minimumFractionDigits: 2 })}`);
  } catch (e) {
    flash(req, 'err', /UNIQUE/.test(e.message) ? 'That invoice number already exists' : e.message);
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
  store.db.run('DELETE FROM shipments WHERE id = ?', Number(req.params.id));
  flash(req, 'ok', 'Shipment deleted');
  res.redirect('/shipments');
});

// ---------- actions: generate & send notices ----------
const ACTIONS = {
  'send-an': (id, u) => notify.sendBrokerPacket(id, { userId: u.id }).then(() => 'Arrival notice & documents sent to customs broker'),
  'send-do': (id, u) => notify.sendDeliveryOrder(id, { userId: u.id }).then(() => 'Delivery order sent to trucker'),
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

// ---------- documents ----------
router.post('/shipments/:id/documents', auth.requirePerm('shipments_edit'), upload.array('files', 10), auth.checkCsrf, async (req, res) => {
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
  for (const f of files) {
    let stored = f.path;
    if (!stored) {
      stored = path.join(config.uploadDir, 'shipments', `${crypto.randomBytes(12).toString('hex')}${path.extname(f.filename).toLowerCase()}`);
      fs.writeFileSync(stored, f.buffer);
    }
    store.db.run(`INSERT INTO documents (shipment_id, doc_type, filename, stored_path, mime, size, customer_visible, uploaded_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, id, req.body.doc_type || 'OTHER', f.filename, stored, f.mime, f.buffer.length,
    req.body.customer_visible ? 1 : 0, req.user.id);
  }
  flash(req, 'ok', `${files.length} file(s) uploaded`);
  res.redirect(`/shipments/${id}#docs`);
});

router.post('/documents/:id/visibility', auth.requirePerm('shipments_edit'), (req, res) => {
  const d = store.db.get('SELECT * FROM documents WHERE id = ?', Number(req.params.id));
  if (!d) return res.status(404).end();
  store.db.run('UPDATE documents SET customer_visible = ? WHERE id = ?', d.customer_visible ? 0 : 1, d.id);
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
