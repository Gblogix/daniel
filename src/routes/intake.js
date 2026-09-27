/**
 * Document intake: overseas agents upload B/L, P/L, C/I, ISF through the portal instead of email.
 * Fields are extracted automatically; staff review, match to a shipment, and apply — which triggers
 * the automatic A/N / document notices.
 */
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const multer = require('multer');
const config = require('../config');
const store = require('../db');
const auth = require('../auth');
const S = require('../shipments');
const notify = require('../notify');
const { extractFile, mergeExtractions } = require('../extract');

const router = express.Router();
const SLOTS = ['MBL', 'HBL', 'PL', 'CI', 'ISF', 'AWB', 'OTHER'];
const ALLOWED = /\.(pdf|xlsx|csv|txt|jpe?g|png)$/i;
const upload = multer({
  dest: path.join(config.uploadDir, 'intake'),
  limits: { fileSize: 25 * 1024 * 1024, files: 20 },
  fileFilter: (req, file, cb) => cb(null, ALLOWED.test(file.originalname)),
});
const uploadFields = upload.fields(SLOTS.map((name) => ({ name, maxCount: 5 })));
const canUpload = auth.requireRole('agent', 'admin', 'staff');

router.get('/portal', canUpload, (req, res) => {
  const mine = req.user.role === 'agent'
    ? store.db.all('SELECT i.*, s.ref_no FROM intakes i LEFT JOIN shipments s ON s.id = i.shipment_id WHERE i.agent_id = ? OR i.uploaded_by = ? ORDER BY i.id DESC LIMIT 50', req.user.company_id, req.user.id)
    : store.db.all('SELECT i.*, s.ref_no FROM intakes i LEFT JOIN shipments s ON s.id = i.shipment_id WHERE i.uploaded_by = ? ORDER BY i.id DESC LIMIT 50', req.user.id);
  for (const i of mine) i.docs = store.db.all('SELECT id, doc_type, filename FROM documents WHERE intake_id = ?', i.id);
  const agents = store.db.all("SELECT id, name FROM companies WHERE type = 'agent' ORDER BY name");
  res.render('portal', { title: 'Document upload', mine, slots: SLOTS, agents });
});

router.post('/portal/upload', canUpload, uploadFields, auth.checkCsrf, async (req, res) => {
  const files = SLOTS.flatMap((slot) => (req.files?.[slot] || []).map((f) => ({ ...f, slot })));
  if (!files.length) {
    req.session.flash = { type: 'err', msg: 'Please attach at least one PDF, Excel, CSV or text file.' };
    return res.redirect('/portal');
  }
  const agentId = req.user.role === 'agent' ? req.user.company_id : Number(req.body.agent_id) || null;
  const intakeId = await processUpload(files, { userId: req.user.id, agentId, note: req.body.note });
  req.session.flash = { type: 'ok', msg: `Thank you — ${files.length} document(s) received (intake #${intakeId}). Our team has been notified.` };
  res.redirect(auth.INTERNAL.includes(req.user.role) ? `/intakes/${intakeId}` : '/portal');
});

async function processUpload(files, { userId, agentId, note, db = store.db }) {
  const res = db.run('INSERT INTO intakes (uploaded_by, agent_id, note) VALUES (?, ?, ?)', userId, agentId, note || null);
  const intakeId = Number(res.lastInsertRowid);
  const perDoc = [];
  for (const f of files) {
    const buffer = fs.readFileSync(f.path);
    const parts = await extractFile({ buffer, filename: f.originalname, mime: f.mimetype, docTypeHint: f.slot === 'OTHER' ? 'AUTO' : f.slot });
    for (const ex of parts) {
      // A merged PDF becomes one document row per detected document (same file, page range in the name).
      const name = parts.length > 1 && ex.pages ? `${f.originalname} [p.${ex.pages.join(',')}]` : f.originalname;
      perDoc.push({ filename: name, ...ex });
      db.run(`INSERT INTO documents (intake_id, doc_type, filename, stored_path, mime, size, extracted_json, uploaded_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, intakeId, ex.doc_type, name, f.path, f.mimetype, f.size, JSON.stringify(ex), userId);
    }
  }
  const draft = mergeExtractions(perDoc);
  const method = perDoc.some((d) => d.method === 'ai') ? 'ai' : perDoc.some((d) => d.method === 'ocr') ? 'ocr' : 'rules';
  const match = findMatch(draft, db);
  db.run('UPDATE intakes SET extracted_json = ?, extraction_method = ?, shipment_id = ? WHERE id = ?',
    JSON.stringify({ draft, perDoc }), method, match?.id ?? null, intakeId);
  const agent = agentId ? db.get('SELECT name FROM companies WHERE id = ?', agentId) : null;
  await notify.queueEmail({
    kind: 'INTAKE', to: [config.company.email],
    subject: `[Docs received] ${agent?.name || 'Agent'} — MBL# ${draft.mbl_no || '-'} / HBL# ${draft.hbl_no || '-'} / CTN# ${draft.containers.map((c) => c.container_no).join(', ') || '-'} / ETA ${draft.eta || 'TBA'}`,
    html: `<p>New documents uploaded (${perDoc.map((d) => d.doc_type).join(', ')}).</p><p><a href="${config.baseUrl}/intakes/${intakeId}">Review intake #${intakeId}</a></p>`,
  }, { db });
  return intakeId;
}

function findMatch(draft, db = store.db) {
  // NSC house numbers can sit in either HBL or SUB B/L depending on which document arrived first.
  for (const no of [draft.hbl_no, draft.sub_bl_no].filter(Boolean)) {
    const s = db.get('SELECT id, ref_no FROM shipments WHERE hbl_no = ? OR sub_bl_no = ? OR agent_ref = ?', no, no, no);
    if (s) return s;
  }
  if (draft.mbl_no) { const s = db.get('SELECT id, ref_no FROM shipments WHERE mbl_no = ? ORDER BY id DESC', draft.mbl_no); if (s) return s; }
  for (const c of draft.containers || []) {
    const s = db.get(`SELECT s.id, s.ref_no FROM shipments s JOIN containers k ON k.shipment_id = s.id
      WHERE k.container_no = ? AND s.status <> 'DELIVERED' ORDER BY s.id DESC`, c.container_no);
    if (s) return s;
  }
  return null;
}

// ---------- staff review ----------
router.get('/intakes', auth.requireInternal, (req, res) => {
  const status = req.query.status || 'PENDING';
  const rows = store.db.all(`SELECT i.*, a.name AS agent_name, u.name AS uploader, s.ref_no FROM intakes i
    LEFT JOIN companies a ON a.id = i.agent_id LEFT JOIN users u ON u.id = i.uploaded_by LEFT JOIN shipments s ON s.id = i.shipment_id
    WHERE i.status = ? ORDER BY i.id DESC LIMIT 200`, status);
  for (const r of rows) {
    r.draft = JSON.parse(r.extracted_json || '{}').draft || {};
    r.docs = store.db.all('SELECT id, doc_type, filename FROM documents WHERE intake_id = ?', r.id);
  }
  res.render('intakes/list', { title: 'Document intake', rows, status });
});

router.get('/intakes/:id', auth.requireInternal, (req, res) => {
  const db = store.db;
  const intake = db.get('SELECT i.*, a.name AS agent_name FROM intakes i LEFT JOIN companies a ON a.id = i.agent_id WHERE i.id = ?', Number(req.params.id));
  if (!intake) return res.status(404).render('error', { title: 'Not found', message: 'Intake not found.' });
  const { draft = {}, perDoc = [] } = JSON.parse(intake.extracted_json || '{}');
  const docs = db.all('SELECT * FROM documents WHERE intake_id = ?', intake.id);
  const target = intake.shipment_id ? S.find(intake.shipment_id, null) : null;
  // Pre-fill: existing shipment values, overridden by what the documents say.
  const s = { mode: draft.mode || 'FCL', status: 'BOOKED', customs_status: 'PENDING', ...(target || {}), agent_id: target?.agent_id || intake.agent_id };
  for (const [k, v] of Object.entries(draft)) if (S.EDITABLE_FIELDS.includes(k) && v != null && v !== '') s[k] = v;
  if (draft.freight_location && !s.cfs_location) s.cfs_location = draft.freight_location;
  if (draft.telex_release) s.telex_release = 1;
  if (draft.mode === 'AIR' && draft.mbl_no && !draft.hbl_no) s.direct_shipment = 1;
  const sources = { ...(draft.sources || {}), ...(draft.sources?.freight_location ? { cfs_location: draft.sources.freight_location } : {}) };
  s.containers = draft.containers?.length ? draft.containers : target?.containers || [];
  s.items = draft.items?.length ? draft.items : target?.items || [];
  if (!target && draft.consignee_name) {
    const guess = db.get("SELECT id FROM companies WHERE type = 'customer' AND ? LIKE '%' || name || '%'", draft.consignee_name.toUpperCase().replace(/[^A-Z0-9 ]/g, ''));
    if (guess) s.customer_id = guess.id;
  }
  const lists = {
    customers: db.all("SELECT id, name FROM companies WHERE type = 'customer' ORDER BY name"),
    agents: db.all("SELECT id, name FROM companies WHERE type = 'agent' ORDER BY name"),
    brokers: db.all("SELECT id, name FROM companies WHERE type = 'broker' ORDER BY name"),
    truckers: db.all("SELECT id, name FROM companies WHERE type = 'trucker' ORDER BY name"),
    deliveries: db.all("SELECT id, name FROM companies WHERE type = 'delivery' ORDER BY name"),
  };
  const openShipments = db.all("SELECT id, ref_no, mbl_no, hbl_no FROM shipments WHERE status <> 'DELIVERED' ORDER BY id DESC LIMIT 200");
  res.render('intakes/review', { title: `Intake #${intake.id}`, intake, draft, perDoc, docs, target, s, sources, openShipments, ...lists });
});

router.post('/intakes/:id/apply', auth.requirePerm('intake'), async (req, res) => {
  const db = store.db;
  const intake = db.get("SELECT * FROM intakes WHERE id = ? AND status = 'PENDING'", Number(req.params.id));
  if (!intake) return res.status(404).render('error', { title: 'Not found', message: 'Intake not found or already processed.' });
  const targetId = req.body.target === 'new' ? null : Number(req.body.target) || null;
  let id;
  require('./shipments').stripAccounting(req);
  if (targetId) {
    S.update(targetId, req.body);
    id = targetId;
  } else {
    id = S.create(req.body, { userId: req.user.id });
  }
  S.saveLines(id, req.body);
  db.run('UPDATE documents SET shipment_id = ? WHERE intake_id = ?', id, intake.id);
  db.run("UPDATE intakes SET status = 'APPLIED', shipment_id = ?, reviewed_at = datetime('now'), reviewed_by = ? WHERE id = ?", id, req.user.id, intake.id);
  if (req.body.send_notices) await notify.onDocumentsApplied(id, { userId: req.user.id });
  else S.addEvent(id, 'DOCS_RECEIVED', 'Shipping documents received from origin agent', { userId: req.user.id });
  req.session.flash = { type: 'ok', msg: `Documents applied to shipment${req.body.send_notices ? ' — notices sent' : ''}` };
  res.redirect(`/shipments/${id}`);
});

router.post('/intakes/:id/reject', auth.requirePerm('intake'), (req, res) => {
  store.db.run("UPDATE intakes SET status = 'REJECTED', note = COALESCE(note, '') || ?, reviewed_at = datetime('now'), reviewed_by = ? WHERE id = ?",
    req.body.reason ? `\nRejected: ${req.body.reason}` : '', req.user.id, Number(req.params.id));
  req.session.flash = { type: 'ok', msg: 'Intake rejected' };
  res.redirect('/intakes');
});

module.exports = router;
module.exports.processUpload = processUpload;
module.exports.findMatch = findMatch;
