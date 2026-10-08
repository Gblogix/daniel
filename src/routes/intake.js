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
const PT = require('../partyTypes');
const auth = require('../auth');
const S = require('../shipments');
const Party = require('../extract/party');
const notify = require('../notify');
const { extractFile, mergeExtractions } = require('../extract');

const router = express.Router();
// CIPL: commercial invoice + packing list in one file (Excel tabs or PDF pages) — split and typed automatically.
// MAWB / HAWB: air waybills by role (AWB = older form field, read either way).
const SLOTS = ['MBL', 'HBL', 'MAWB', 'HAWB', 'PL', 'CI', 'CIPL', 'ISF', 'AWB', 'OTHER'];
const ALLOWED = /\.(pdf|xlsx|csv|txt|jpe?g|png)$/i;
const upload = multer({
  dest: path.join(config.uploadDir, 'intake'),
  limits: { fileSize: 25 * 1024 * 1024, files: 60 },
  fileFilter: (req, file, cb) => cb(null, ALLOWED.test(file.originalname)),
});
// Several files per line: a consolidated box has one C/I + P/L per invoice (Target, Walmart, Nordstrom…).
const uploadFields = upload.fields(SLOTS.map((name) => ({ name, maxCount: 20 })));
const canUpload = auth.requireRole('agent', 'admin', 'staff');

router.get('/portal', canUpload, (req, res) => {
  const mine = req.user.role === 'agent'
    ? store.db.all('SELECT i.*, s.ref_no FROM intakes i LEFT JOIN shipments s ON s.id = i.shipment_id WHERE i.agent_id = ? OR i.uploaded_by = ? ORDER BY i.id DESC LIMIT 50', req.user.company_id, req.user.id)
    : store.db.all('SELECT i.*, s.ref_no FROM intakes i LEFT JOIN shipments s ON s.id = i.shipment_id WHERE i.uploaded_by = ? ORDER BY i.id DESC LIMIT 50', req.user.id);
  for (const i of mine) i.docs = store.db.all('SELECT id, doc_type, filename FROM documents WHERE intake_id = ?', i.id);
  const agents = store.db.all(`SELECT id, name FROM companies WHERE ${PT.sql('agent')} ORDER BY name`);
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
    const hint = f.slot === 'OTHER' || f.slot === 'CIPL' ? 'AUTO' : ['MAWB', 'HAWB'].includes(f.slot) ? 'AWB' : f.slot;
    const parts = await extractFile({ buffer, filename: f.originalname, mime: f.mimetype, docTypeHint: hint });
    for (const ex of parts) {
      // Put on the MAWB / HAWB line: the user said which one it is.
      if (f.slot === 'MAWB' && ex.doc_type === 'AWB') {
        ex.doc_role = 'master';
        ex.mawb_no = ex.mawb_no || ex.mbl_no || ex.hbl_no || null; ex.mbl_no = ex.mawb_no;
        ex.hbl_no = null; ex.hawb_no = null;
      }
      if (f.slot === 'HAWB' && ex.doc_type === 'AWB') {
        ex.doc_role = 'house';
        ex.hawb_no = ex.hawb_no || (ex.hbl_no && ex.hbl_no !== ex.mbl_no ? ex.hbl_no : null) || ex.hbl_no || null; ex.hbl_no = ex.hawb_no;
      }
      // A merged PDF becomes one document row per detected document (same file, page range in the name).
      const name = parts.length > 1 && ex.sheet ? `${f.originalname} [${ex.sheet}]` : parts.length > 1 && ex.pages ? `${f.originalname} [p.${ex.pages.join(',')}]` : f.originalname;
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
  // Ongoing = waiting for review; Done = applied or rejected (older names PENDING / APPLIED / REJECTED still work).
  const tab = req.query.status === 'APPLIED' || req.query.status === 'REJECTED' || req.query.tab === 'done' ? 'done' : 'ongoing';
  const rows = store.db.all(`SELECT i.*, a.name AS agent_name, u.name AS uploader, s.ref_no, s.hbl_no AS s_hbl FROM intakes i
    LEFT JOIN companies a ON a.id = i.agent_id LEFT JOIN users u ON u.id = i.uploaded_by LEFT JOIN shipments s ON s.id = i.shipment_id
    WHERE ${tab === 'done' ? "i.status IN ('APPLIED', 'REJECTED')" : "i.status = 'PENDING'"} ORDER BY i.id DESC LIMIT 200`);
  for (const r of rows) {
    r.draft = JSON.parse(r.extracted_json || '{}').draft || {};
    r.docs = store.db.all('SELECT id, doc_type, filename, mime FROM documents WHERE intake_id = ?', r.id);
  }
  const counts = store.db.get("SELECT SUM(status = 'PENDING') AS ongoing, SUM(status IN ('APPLIED', 'REJECTED')) AS done FROM intakes");
  res.render('intakes/list', { title: 'Document hub', rows, tab, status: tab === 'done' ? 'APPLIED' : 'PENDING', counts });
});

router.get('/intakes/:id', auth.requireInternal, (req, res) => {
  const db = store.db;
  const intake = db.get('SELECT i.*, a.name AS agent_name FROM intakes i LEFT JOIN companies a ON a.id = i.agent_id WHERE i.id = ?', Number(req.params.id));
  if (!intake) return res.status(404).render('error', { title: 'Not found', message: 'Intake not found.' });
  const { draft = {}, perDoc = [] } = JSON.parse(intake.extracted_json || '{}');
  const docs = db.all('SELECT * FROM documents WHERE intake_id = ?', intake.id);
  // Master-only upload, or several house B/Ls: master first, a house file per HB/L.
  const plan = intake.status === 'PENDING' ? require('../intakePlan').plan(docs) : { kind: 'single' };
  if (plan.kind !== 'single') {
    const customers = db.all(`SELECT id, name FROM companies WHERE ${PT.sql(['customer', 'importer'])} ORDER BY name`);
    for (const h of plan.houses) {
      const name = /^TO\s+(THE\s+)?ORDER/i.test(h.draft.consignee_name || '') ? h.draft.notify_party : h.draft.consignee_name;
      h.customer_id = name ? Party.findParty(name, { types: ['customer', 'importer'] })?.id || null : null;
      h.existing = db.get('SELECT id, ref_no FROM shipments WHERE hbl_no = ? OR sub_bl_no = ? OR agent_ref = ?', h.hbl, h.hbl, h.hbl) || null;
    }
    const existingMaster = plan.master.mbl_no ? require('../masters').findByMbl(plan.master.mbl_no) : null;
    return res.render('intakes/plan', { title: `Intake #${intake.id}`, intake, plan, docs, customers, existingMaster, agents: db.all(`SELECT id, name FROM companies WHERE ${PT.sql('agent')} ORDER BY name`) });
  }
  const target = intake.shipment_id ? S.find(intake.shipment_id, null) : null;
  // Pre-fill: existing shipment values, overridden by what the documents say.
  const s = { mode: draft.mode || 'FCL', status: 'BOOKED', customs_status: 'PENDING', ...(target || {}), agent_id: target?.agent_id || intake.agent_id };
  for (const [k, v] of Object.entries(draft)) if (S.EDITABLE_FIELDS.includes(k) && v != null && v !== '') s[k] = v;
  if (draft.freight_location && !s.cfs_location) s.cfs_location = draft.freight_location;
  if (draft.telex_release) s.telex_release = 1;
  if (draft.mode === 'AIR' && draft.mbl_no && !draft.hbl_no) s.direct_shipment = 1;
  const sources = { ...(draft.sources || {}), ...(draft.sources?.freight_location ? { cfs_location: draft.sources.freight_location } : {}) };
  s.containers = draft.containers?.length ? draft.containers : target?.containers || [];
  // New P/L lines replace the file's lines of the same invoice; lines of other invoices already on the file stay.
  s.items = S.mergeItems(target?.items || [], draft.items || []);
  // Customer = the consignee on the B/L (the notify party when consigned "to order"); not on Parties yet → offer to add it.
  let newCustomer = null;
  if (!s.customer_id) {
    const toOrder = /^TO\s+(THE\s+)?ORDER/i.test(draft.consignee_name || '');
    const name = toOrder ? draft.notify_party : draft.consignee_name;
    if (name && !/^SAME\s+AS/i.test(name)) {
      const hit = Party.findParty(name, { types: ['customer', 'importer'] });
      if (hit) s.customer_id = hit.id;
      else if (!Party.findParty(name)) {
        newCustomer = { name, address: toOrder ? draft.notify_address : draft.consignee_address, email: draft.consignee_contact?.email, phone: draft.consignee_contact?.phone };
      }
    }
  }
  const lists = {
    customers: db.all(`SELECT id, name FROM companies WHERE ${PT.sql('customer')} ORDER BY name`),
    agents: db.all(`SELECT id, name FROM companies WHERE ${PT.sql('agent')} ORDER BY name`),
    brokers: db.all(`SELECT id, name FROM companies WHERE ${PT.sql('broker')} ORDER BY name`),
    truckers: db.all(`SELECT id, name FROM companies WHERE ${PT.sql('trucker')} ORDER BY name`),
    deliveries: db.all(`SELECT id, name FROM companies WHERE ${PT.sql('delivery')} ORDER BY name`),
  };
  const openShipments = db.all("SELECT id, ref_no, mbl_no, hbl_no FROM shipments WHERE status <> 'DELIVERED' ORDER BY id DESC LIMIT 200");
  res.render('intakes/review', { title: `Intake #${intake.id}`, intake, draft, perDoc, docs, target, s, sources, openShipments, newCustomer, ...lists });
});

router.post('/intakes/:id/apply', auth.requirePerm('intake'), async (req, res) => {
  const db = store.db;
  const intake = db.get("SELECT * FROM intakes WHERE id = ? AND status = 'PENDING'", Number(req.params.id));
  if (!intake) return res.status(404).render('error', { title: 'Not found', message: 'Intake not found or already processed.' });
  if (req.body.plan === 'master' || req.body.plan === 'multi') return applyPlan(req, res, intake);
  return applySingle(req, res, intake);
});

/** One file from the upload: create it, or update the chosen one with the form (in-entry or side-by-side review). */
async function applySingle(req, res, intake) {
  const db = store.db;
  const targetId = req.body.target === 'new' ? null : Number(req.body.target) || null;
  if (targetId) require('../locks').assertUnlocked(targetId);
  let id;
  require('./shipments').stripAccounting(req);
  const added = Party.fromForm(req.body, 'customer_id');
  if (targetId) {
    S.update(targetId, req.body);
    id = targetId;
  } else {
    id = S.create(req.body, { userId: req.user.id });
  }
  S.saveLines(id, req.body);
  db.run('UPDATE documents SET shipment_id = ? WHERE intake_id = ?', id, intake.id);
  // The carrier's MB/L / MAWB belongs to the master (still listed on the house page).
  const mid = db.get('SELECT master_id FROM shipments WHERE id = ?', id)?.master_id;
  if (mid) {
    const P = require('../intakePlan');
    for (const d of db.all('SELECT * FROM documents WHERE intake_id = ?', intake.id)) {
      if (P.isMasterDoc({ ...JSON.parse(d.extracted_json || '{}'), doc_type: d.doc_type })) db.run('UPDATE documents SET shipment_id = NULL, master_id = ? WHERE id = ?', mid, d.id);
    }
  }
  // Remember the invoices the B/L names, so a missing P/L stays on the file's follow-ups until it arrives.
  const refs = JSON.parse(intake.extracted_json || '{}').draft?.invoice_refs || [];
  if (refs.length) {
    const cur = (db.get('SELECT bl_invoices FROM shipments WHERE id = ?', id)?.bl_invoices || '').split(',').filter(Boolean);
    db.run('UPDATE shipments SET bl_invoices = ? WHERE id = ?', [...new Set([...cur, ...refs])].join(','), id);
  }
  db.run("UPDATE intakes SET status = 'APPLIED', shipment_id = ?, reviewed_at = datetime('now'), reviewed_by = ? WHERE id = ?", id, req.user.id, intake.id);
  require('../tracking').refreshSoon(id, { userId: req.user.id });
  if (req.body.send_notices) await notify.onDocumentsApplied(id, { userId: req.user.id });
  else S.addEvent(id, 'DOCS_RECEIVED', 'Shipping documents received from origin agent', { userId: req.user.id });
  req.session.flash = { type: 'ok', msg: `Documents ${targetId ? `applied to ${db.get('SELECT ref_no FROM shipments WHERE id = ?', id).ref_no}` : 'saved as a new file'}${req.body.send_notices ? ' — notices sent' : ''}${added ? ` · ${added} added to Parties as a new customer` : ''}` };
  res.redirect(`/shipments/${id}`);
}

// ---------- side-by-side review: the document on the left, field by field on the right ----------
const SIDE_STEPS = [
  { key: 'master', title: 'Audit MB/L · carrier leg', fields: [['mode', 'Mode'], ['mbl_no', 'MB/L · MAWB no.'], ['carrier', 'Carrier / airline'], ['scac', 'SCAC'],
    ['vessel', 'Vessel'], ['voyage', 'Voyage'], ['flight_no', 'Flight'], ['etd', 'ETD'], ['eta', 'ETA'], ['pol', 'Port of loading'], ['pod', 'Port of discharge'],
    ['place_of_delivery', 'Place of delivery'], ['service_term', 'Service term'], ['containers', 'Containers']] },
  { key: 'house', title: 'Audit HB/L · parties & cargo', fields: [['hbl_no', 'HB/L · HAWB no.'], ['sub_bl_no', 'Sub B/L'], ['agent_ref', 'Agent filing no.'], ['ams_bl_no', 'AMS B/L'],
    ['customer_id', 'Customer (CNEE)'], ['shipper_name', 'Shipper'], ['shipper_address', 'Shipper address'], ['consignee_name', 'Consignee'], ['consignee_address', 'Consignee address'],
    ['notify_party', 'Notify party'], ['packages', 'Packages'], ['package_unit', 'Package unit'], ['weight_kg', 'Weight (KG)'], ['cbm', 'CBM'], ['chargeable_weight', 'Chargeable weight'],
    ['commodity', 'Commodity'], ['ci_invoice_no', 'Invoice no.'], ['items', 'Cargo lines (P/L)']] },
  { key: 'docs', title: 'Documents', fields: [] },
];

function sideRows(draft, target, customers) {
  const name = (id) => customers.find((c) => String(c.id) === String(id))?.name || '';
  const show = (k, v, s) => {
    if (k === 'containers') return (v || []).map((c) => c.container_no).join(', ');
    if (k === 'items') return (v || []).length ? `${v.length} line(s)${s ? '' : ''}` : '';
    if (k === 'customer_id') return name(v);
    return v == null ? '' : String(v);
  };
  return SIDE_STEPS.map((st) => ({ ...st, rows: st.fields.map(([k, label]) => {
    const cur = target ? (k === 'items' ? target.items : target[k]) : null;
    const ext = draft[k];
    const curT = show(k, cur); const extT = show(k, ext);
    const differs = extT !== '' && extT.toUpperCase().replace(/\s+/g, ' ') !== curT.toUpperCase().replace(/\s+/g, ' ');
    return { k, label, cur: curT, ext: extT, value: k === 'customer_id' ? (ext || cur || '') : (extT || curT), differs, list: ['containers', 'items'].includes(k) };
  }) }));
}

router.get('/intakes/:id/side', auth.requireInternal, (req, res) => {
  const db = store.db;
  const intake = db.get('SELECT i.*, a.name AS agent_name FROM intakes i LEFT JOIN companies a ON a.id = i.agent_id WHERE i.id = ?', Number(req.params.id));
  if (!intake) return res.status(404).render('error', { title: 'Not found', message: 'Intake not found.' });
  const docs = db.all('SELECT * FROM documents WHERE intake_id = ?', intake.id);
  if (intake.status === 'PENDING' && require('../intakePlan').plan(docs).kind !== 'single') return res.redirect(`/intakes/${intake.id}`);
  const { draft = {} } = JSON.parse(intake.extracted_json || '{}');
  const customers = db.all(`SELECT id, name FROM companies WHERE ${PT.sql(['customer', 'importer'])} ORDER BY name`);
  // Customer read from the B/L (consignee, or notify when "to order").
  if (!draft.customer_id) {
    const nm = /^TO\s+(THE\s+)?ORDER/i.test(draft.consignee_name || '') ? draft.notify_party : draft.consignee_name;
    const hit = nm ? Party.findParty(nm, { types: ['customer', 'importer'] }) : null;
    if (hit) draft.customer_id = hit.id;
  }
  const mode = req.query.target === 'new' ? 'new' : req.query.target ? 'update' : intake.shipment_id ? 'update' : 'new';
  const targetId = mode === 'update' ? Number(req.query.target) || intake.shipment_id : null;
  const target = targetId ? S.find(targetId, null) : null;
  const openShipments = db.all("SELECT id, ref_no, mbl_no, hbl_no FROM shipments WHERE closed_at IS NULL AND mode <> 'OTHER' ORDER BY id DESC LIMIT 300");
  const docId = Number(req.query.doc) || docs.find((d) => d.mime === 'application/pdf')?.id || docs[0]?.id;
  res.render('intakes/side', { title: `Review #${intake.id}`, intake, docs, docId, draft, target, mode: target ? 'update' : 'new', openShipments, customers,
    steps: sideRows(draft, target, customers), matched: intake.shipment_id });
});

router.post('/intakes/:id/side', auth.requirePerm('intake'), async (req, res) => {
  const db = store.db;
  const intake = db.get("SELECT * FROM intakes WHERE id = ? AND status = 'PENDING'", Number(req.params.id));
  if (!intake) return res.status(404).render('error', { title: 'Not found', message: 'Intake not found or already processed.' });
  const { draft = {} } = JSON.parse(intake.extracted_json || '{}');
  const b = req.body;
  const isNew = b.target === 'new';
  if (!isNew) require('../locks').assertUnlocked(Number(b.target));
  const P = require('../intakePlan');
  const full = P.bodyFromDraft(draft);
  const body = isNew ? { ...full, agent_id: intake.agent_id || '' } : {};
  for (const st of SIDE_STEPS) {
    for (const [k] of st.fields) {
      const use = isNew || b[`use_${k}`];
      if (!use) continue;
      if (k === 'containers') { for (const c of Object.keys(full).filter((x) => x.startsWith('ctn_'))) body[c] = full[c]; continue; }
      if (k === 'items') {
        const cur = isNew ? [] : S.find(Number(b.target), null)?.items || [];
        const merged = S.mergeItems(cur, draft.items || []);
        const col = (x) => merged.map((i) => i[x] ?? '');
        Object.assign(body, { item_buyer: col('buyer'), item_inv: col('invoice_no'), item_po: col('po_no'), item_desc: col('description'), item_hs: col('hs_code'), item_qty: col('quantity'),
          item_unit: col('unit'), item_pkgs: col('packages'), item_kg: col('weight_kg'), item_cbm: col('cbm'), item_price: col('unit_price'), item_amount: col('amount') });
        continue;
      }
      if (`u_${k}` in b) body[k] = b[`u_${k}`];
    }
  }
  body.target = isNew ? 'new' : String(Number(b.target) || '');
  if (!isNew && !Number(b.target)) { req.session.flash = { type: 'err', msg: 'Pick the file to update' }; return res.redirect(`/intakes/${intake.id}/side`); }
  if (b.send_notices) body.send_notices = '1';
  req.body = body;
  return applySingle(req, res, intake);
});

/** "How was the reading?" — 👎 uploads are kept for improving the reader. */
router.post('/intakes/:id/feedback', auth.requireInternal, (req, res) => {
  store.db.run('UPDATE intakes SET feedback = ?, feedback_note = ? WHERE id = ?', req.body.good === '1' ? 1 : 0, String(req.body.note || '').slice(0, 500) || null, Number(req.params.id));
  if (req.get('accept')?.includes('json')) return res.json({ ok: true });
  res.redirect(req.get('referer') || `/intakes/${req.params.id}/side`);
});

/** Apply a master-only or multi-house upload: master (created / filled), then one house file per HB/L. */
async function applyPlan(req, res, intake) {
  const db = store.db;
  const P = require('../intakePlan');
  const M = require('../masters');
  const docs = db.all('SELECT * FROM documents WHERE intake_id = ?', intake.id);
  const plan = P.plan(docs);
  const b = req.body;
  const masterFields = ['mbl_no', 'carrier', 'vessel', 'voyage', 'flight_no', 'etd', 'eta', 'pol', 'pod', 'place_of_delivery'];
  const mdraft = { ...plan.master, mode: b.mode || plan.master.mode };
  for (const k of masterFields) if (k in b) mdraft[k] = String(b[k]).trim() || null;
  const mid = M.fromDraft(mdraft);
  if (b.agent_id || intake.agent_id) db.run('UPDATE masters SET agent_id = COALESCE(agent_id, ?) WHERE id = ?', Number(b.agent_id || intake.agent_id) || null, mid);
  for (const id of plan.masterDocs) db.run('UPDATE documents SET master_id = ? WHERE id = ?', mid, id);
  const made = [];
  if (plan.kind === 'multi') {
    plan.houses.forEach((h, i) => {
      const body = { ...P.bodyFromDraft(h.draft), mode: mdraft.mode, master_id: mid, hbl_no: String(b[`hbl_${i}`] || h.hbl).trim(), agent_id: intake.agent_id || null };
      for (const k of masterFields) if (mdraft[k]) body[k] = mdraft[k];
      if (b[`customer_${i}`]) body.customer_id = b[`customer_${i}`];
      const existing = db.get('SELECT id FROM shipments WHERE hbl_no = ? OR sub_bl_no = ? OR agent_ref = ?', body.hbl_no, body.hbl_no, body.hbl_no);
      let id;
      if (existing) { S.update(existing.id, body); id = existing.id; } else id = S.create(body, { userId: req.user.id });
      const cur = S.find(id, null);
      if (body.item_desc) {
        const merged = S.mergeItems(cur.items, h.draft.items || []);
        const col = (k) => merged.map((x) => x[k] ?? '');
        Object.assign(body, { item_buyer: col('buyer'), item_inv: col('invoice_no'), item_po: col('po_no'), item_desc: col('description'), item_hs: col('hs_code'), item_qty: col('quantity'),
          item_unit: col('unit'), item_pkgs: col('packages'), item_kg: col('weight_kg'), item_cbm: col('cbm'), item_price: col('unit_price'), item_amount: col('amount') });
      }
      S.saveLines(id, body);
      const mine = [...h.docIds, ...plan.unassigned.filter((d) => Number(b[`doc_${d}`]) === i)];
      for (const d of mine) db.run('UPDATE documents SET shipment_id = ? WHERE id = ?', id, d);
      const refs = h.draft.invoice_refs || [];
      if (refs.length) db.run('UPDATE shipments SET bl_invoices = ? WHERE id = ?', refs.join(','), id);
      S.addEvent(id, 'DOCS_RECEIVED', 'Shipping documents received from origin agent', { userId: req.user.id });
      require('../tracking').refreshSoon(id, { userId: req.user.id });
      made.push(S.find(id, null));
    });
    for (const d of plan.unassigned.filter((x) => b[`doc_${x}`] === 'master')) db.run('UPDATE documents SET master_id = ? WHERE id = ?', mid, d);
  }
  db.run("UPDATE intakes SET status = 'APPLIED', master_id = ?, shipment_id = ?, reviewed_at = datetime('now'), reviewed_by = ? WHERE id = ?", mid, made[0]?.id || null, req.user.id, intake.id);
  const m = M.get(mid);
  req.session.flash = { type: 'ok', msg: plan.kind === 'master' ? `Master ${m.mbl_no || m.ref_no} saved — add its house B/Ls (or upload them; they join it by MB/L or container)`
    : `Master ${m.mbl_no || m.ref_no} with ${made.length} house B/Ls: ${made.map((s) => s.hbl_no).join(', ')}` };
  res.redirect(`/masters/${mid}`);
}

/**
 * Delete intakes from the list (one, or the checked ones). Documents that were never applied to a file are removed
 * with their stored files; documents already on a file stay there. An Outlook email that was imported is not read again.
 */
function deleteIntakes(ids, db = store.db) {
  let n = 0;
  const files = [];
  db.tx(() => {
    for (const id of ids) {
      if (!db.get('SELECT id FROM intakes WHERE id = ?', id)) continue;
      const loose = db.all('SELECT id, stored_path FROM documents WHERE intake_id = ? AND shipment_id IS NULL', id);
      for (const d of loose) {
        db.run('DELETE FROM documents WHERE id = ?', d.id);
        // Several documents can share one stored file (a merged PDF): remove it only when nothing points to it.
        if (d.stored_path && !db.get('SELECT 1 FROM documents WHERE stored_path = ?', d.stored_path)) files.push(d.stored_path);
      }
      db.run('UPDATE documents SET intake_id = NULL WHERE intake_id = ?', id);
      db.run('UPDATE mail_imports SET intake_id = NULL WHERE intake_id = ?', id);
      db.run('DELETE FROM intakes WHERE id = ?', id);
      n++;
    }
  });
  for (const f of [...new Set(files)]) { try { fs.unlinkSync(f); } catch { /* already gone */ } }
  return n;
}

router.post('/intakes/delete', auth.requirePerm('intake'), (req, res) => {
  const arr = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
  const ids = (req.body.one ? [req.body.one] : arr(req.body.ids)).map(Number).filter(Boolean);
  if (!ids.length) { req.session.flash = { type: 'err', msg: 'Tick the uploads to delete first' }; return res.redirect(req.get('referer') || '/intakes'); }
  const n = deleteIntakes(ids);
  req.session.flash = { type: 'ok', msg: `${n} upload${n === 1 ? '' : 's'} deleted` };
  res.redirect(`/intakes?status=${encodeURIComponent(req.body.status || 'PENDING')}`);
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
module.exports.deleteIntakes = deleteIntakes;
