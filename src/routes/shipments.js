const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const multer = require('multer');
const config = require('../config');
const store = require('../db');
const auth = require('../auth');
const S = require('../shipments');
const notify = require('../notify');

const router = express.Router();
const upload = multer({ dest: path.join(config.uploadDir, 'shipments'), limits: { fileSize: 25 * 1024 * 1024, files: 10 } });

const companies = (type) => store.db.all('SELECT id, name FROM companies WHERE type = ? ORDER BY name', type);
const partyLists = () => ({
  customers: companies('customer'), agents: companies('agent'), brokers: companies('broker'),
  truckers: companies('trucker'), deliveries: companies('delivery'),
});
const flash = (req, type, msg) => { req.session.flash = { type, msg }; };

// ---------- internal dashboard ----------
router.get('/dashboard', auth.requireInternal, (req, res) => {
  const db = store.db;
  const active = S.list(req.user, { active: true });
  const in7 = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  const kpi = {
    active: active.length,
    arriving: active.filter((s) => s.eta && s.eta >= today && s.eta <= in7).length,
    intakes: db.get("SELECT COUNT(*) AS n FROM intakes WHERE status = 'PENDING'").n,
    exam: active.filter((s) => s.customs_status === 'EXAM' || s.customs_status === 'HOLD').length,
    unpaid: db.get("SELECT COUNT(*) AS n FROM shipments WHERE paid = 0 AND invoice_amount > 0").n,
    failedEmails: db.get("SELECT COUNT(*) AS n FROM emails WHERE status = 'FAILED'").n,
  };
  const events = db.all(`SELECT e.*, s.ref_no FROM events e JOIN shipments s ON s.id = e.shipment_id ORDER BY e.id DESC LIMIT 15`);
  res.render('dashboard', { title: 'Dashboard', kpi, active, events });
});

// ---------- list ----------
router.get('/shipments', auth.requireLogin, (req, res) => {
  if (req.user.role === 'customer') return res.redirect('/track');
  const { q = '', status = '', mode = '' } = req.query;
  const rows = S.list(req.user, { q, status, mode });
  res.render('shipments/list', { title: 'Shipments', rows, q, status, mode });
});

router.get('/shipments/new', auth.requireInternal, (req, res) => {
  res.render('shipments/form', { title: 'New shipment', s: { mode: 'FCL', status: 'BOOKED', customs_status: 'PENDING', containers: [], items: [] }, ...partyLists() });
});

router.post('/shipments', auth.requireInternal, (req, res) => {
  const id = S.create(req.body, { userId: req.user.id });
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
  const docs = db.all(`SELECT * FROM documents WHERE shipment_id = ? ${internal ? '' : docFilter(viewer)} ORDER BY id DESC`, s.id);
  const events = db.all(`SELECT * FROM events WHERE shipment_id = ? ${internal ? '' : 'AND customer_visible = 1'} ORDER BY id DESC`, s.id);
  const emails = internal ? db.all('SELECT id, kind, to_addr, subject, status, created_at FROM emails WHERE shipment_id = ? ORDER BY id DESC', s.id) : [];
  const view = internal ? 'shipments/detail' : 'customer/detail';
  res.render(view, { title: s.ref_no, s, tr: S.tracking(s), docs, events, emails, ...(internal ? partyLists() : {}) });
});

/** Which documents each external role may download. */
function docFilter(user) {
  if (user.role === 'customer') return 'AND customer_visible = 1';
  if (user.role === 'broker') return "AND doc_type IN ('AN','HBL','MBL','PL','CI','ISF','ATME','AWB')";
  if (user.role === 'trucker') return "AND doc_type IN ('DO','PL')";
  if (user.role === 'agent') return "AND source = 'upload'";
  return 'AND 0';
}

router.post('/shipments/:id', auth.requireInternal, async (req, res) => {
  const id = Number(req.params.id);
  const changes = S.update(id, req.body);
  S.saveLines(id, req.body);
  await notify.onShipmentChanged(id, changes, { userId: req.user.id });
  flash(req, 'ok', changes.length ? `Saved (${changes.length} field${changes.length > 1 ? 's' : ''} changed)` : 'Saved');
  res.redirect(`/shipments/${id}`);
});

router.post('/shipments/:id/delete', auth.requireRole('admin'), (req, res) => {
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
router.post('/shipments/:id/actions/:action', auth.requireInternal, async (req, res) => {
  const id = Number(req.params.id);
  const fn = ACTIONS[req.params.action];
  if (!fn) return res.status(400).render('error', { title: 'Unknown action', message: 'Unknown action.' });
  flash(req, 'ok', await fn(id, req.user));
  res.redirect(`/shipments/${id}#emails`);
});

router.post('/shipments/:id/generate/:type', auth.requireInternal, (req, res) => {
  const type = req.params.type.toUpperCase();
  if (!['AN', 'DO', 'ATME'].includes(type)) return res.status(400).render('error', { title: 'Unknown document', message: 'Unknown document type.' });
  const d = notify.generateDocument(Number(req.params.id), type, { userId: req.user.id });
  res.redirect(`/documents/${d.id}`);
});

// ---------- documents ----------
router.post('/shipments/:id/documents', auth.requireInternal, upload.array('files', 10), auth.checkCsrf, (req, res) => {
  const id = Number(req.params.id);
  for (const f of req.files || []) {
    store.db.run(`INSERT INTO documents (shipment_id, doc_type, filename, stored_path, mime, size, customer_visible, uploaded_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, id, req.body.doc_type || 'OTHER', f.originalname, f.path, f.mimetype, f.size,
    req.body.customer_visible ? 1 : 0, req.user.id);
  }
  flash(req, 'ok', `${(req.files || []).length} file(s) uploaded`);
  res.redirect(`/shipments/${id}#docs`);
});

router.post('/documents/:id/visibility', auth.requireInternal, (req, res) => {
  const d = store.db.get('SELECT * FROM documents WHERE id = ?', Number(req.params.id));
  if (!d) return res.status(404).end();
  store.db.run('UPDATE documents SET customer_visible = ? WHERE id = ?', d.customer_visible ? 0 : 1, d.id);
  res.redirect(`/shipments/${d.shipment_id}#docs`);
});

router.get('/documents/:id', auth.requireLogin, (req, res) => {
  const d = store.db.get('SELECT * FROM documents WHERE id = ?', Number(req.params.id));
  if (!d) return res.status(404).render('error', { title: 'Not found', message: 'Document not found.' });
  const internal = auth.INTERNAL.includes(req.user.role);
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
