const express = require('express');
const store = require('../db');
const auth = require('../auth');
const S = require('../shipments');
const M = require('../masters');

const router = express.Router();
const flash = (req, type, msg) => { req.session.flash = { type, msg }; };
const agents = () => store.db.all(`SELECT id, name FROM companies WHERE ${require('../partyTypes').sql('agent')} ORDER BY name`);

router.get('/masters', auth.requireInternal, (req, res) => {
  const sort = req.query.sort === 'desc' ? 'desc' : 'asc';
  const mode = ['AIR', 'OCEAN'].includes(req.query.mode) ? req.query.mode : '';
  res.render('masters/list', { title: mode === 'AIR' ? 'MAWB list' : mode === 'OCEAN' ? 'Master B/L list (ocean)' : 'Master B/L list', rows: M.list({ q: String(req.query.q || '').trim(), sort, mode }), q: req.query.q || '', sort, mode });
});

router.get('/masters/new', auth.requirePerm('shipments_edit'), (req, res) => {
  const mode = ['FCL', 'LCL', 'AIR'].includes(req.query.mode) ? req.query.mode : 'FCL';
  res.render('masters/form', { title: mode === 'AIR' ? 'New master (MAWB)' : 'New master (MB/L)', m: { mode, houses: [], containers: [] }, agents: agents(), missing: [] });
});

router.post('/masters', auth.requirePerm('shipments_edit'), (req, res) => {
  if (!String(req.body.mbl_no || '').trim()) { flash(req, 'err', 'Enter the MB/L (MAWB) number'); return res.redirect(`/masters/new?mode=${encodeURIComponent(req.body.mode || 'FCL')}`); }
  const existing = M.findByMbl(req.body.mbl_no);
  if (existing) { flash(req, 'ok', `MB/L ${existing.mbl_no} already exists — opened it`); return res.redirect(`/masters/${existing.id}`); }
  const id = M.create(req.body);
  flash(req, 'ok', 'Master created — now add its house B/Ls below');
  res.redirect(`/masters/${id}`);
});

router.get('/masters/:id', auth.requireInternal, (req, res) => {
  const m = M.get(Number(req.params.id));
  if (!m) return res.status(404).render('error', { title: 'Not found', message: 'Master not found.' });
  // Invoices live on the house files; the master shows their total P/L to accounting users.
  let profits = null;
  if (auth.canAccounting(req.user) && m.houses.length) {
    const A = require('../accounting');
    profits = m.houses.map((h) => A.shipmentProfit(h.id)).reduce((a, p) => ({ revenue: a.revenue + p.revenue, cost: a.cost + p.cost, profit: a.profit + p.profit }), { revenue: 0, cost: 0, profit: 0 });
  }
  // House cards beside the master: open A/R and A/P per house (accounting users).
  if (auth.canAccounting(req.user)) {
    for (const h of m.houses) {
      const b = store.db.get(`SELECT ROUND(SUM(CASE WHEN kind IN ('AR', 'DN') AND total > 0 THEN ABS(total) - paid_amount ELSE 0 END), 2) AS ar,
        ROUND(SUM(CASE WHEN kind = 'AP' OR (kind = 'DN' AND total < 0) THEN ABS(total) - paid_amount ELSE 0 END), 2) AS ap
        FROM invoices WHERE shipment_id = ? AND status = 'OPEN'`, h.id);
      h.ar_open = b.ar || 0; h.ap_open = b.ap || 0;
    }
  }
  res.render('masters/form', { title: m.mbl_no || m.ref_no, m, profits, agents: agents(), missing: M.missing(m) });
});

router.post('/masters/:id', auth.requirePerm('shipments_edit'), async (req, res) => {
  const id = Number(req.params.id);
  const other = req.body.mbl_no && M.findByMbl(req.body.mbl_no);
  if (other && other.id !== id) { flash(req, 'err', `MB/L ${other.mbl_no} is already master ${other.ref_no}`); return res.redirect(`/masters/${id}`); }
  const r = M.update(id, req.body);
  const notify = require('../notify');
  for (const h of r.houses) if (h.changes.length) await notify.onShipmentChanged(h.id, h.changes, { userId: req.user.id });
  const touched = r.houses.filter((h) => h.changes.length).length;
  flash(req, 'ok', `Master saved${touched ? ` — ${touched} house file(s) updated` : ''}`);
  res.redirect(`/masters/${id}`);
});

// Drop the MB/L / MAWB (PDF, image or the Outlook email) on the master: kept on the master, read, and its empty
// fields filled in (carrier, vessel / flight, dates, ports, containers); the carrier leg then goes to the houses.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('../config');
const masterUpload = require('multer')({ storage: require('multer').memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 10 } });
router.post('/masters/:id/documents', auth.requirePerm('shipments_edit'), masterUpload.array('files', 10), auth.checkCsrf, async (req, res) => {
  const id = Number(req.params.id);
  const m = store.db.get('SELECT * FROM masters WHERE id = ?', id);
  if (!m) return res.status(404).end();
  const { files } = await require('../extract/mailfile').expandMailFiles((req.files || []).map((f) => ({ buffer: f.buffer, filename: f.originalname, mime: f.mimetype })));
  if (!files.length) { flash(req, 'err', 'Choose the MB/L / MAWB file first'); return res.redirect(`/masters/${id}`); }
  const X = require('../extract/index');
  const parts = []; let houses = 0;
  fs.mkdirSync(path.join(config.uploadDir, 'masters'), { recursive: true });
  for (const f of files) {
    const got = await X.extractFile({ buffer: f.buffer, filename: f.filename, mime: f.mime, docTypeHint: m.mode === 'AIR' ? 'AWB' : 'MBL' }).catch(() => []);
    const master = got.filter((p) => p.doc_type === 'MBL' || (p.doc_type === 'AWB' && p.doc_role !== 'house'));
    houses += got.filter((p) => p.doc_type === 'HBL' || (p.doc_type === 'AWB' && p.doc_role === 'house')).length;
    parts.push(...master);
    const stored = path.join(config.uploadDir, 'masters', `${crypto.randomBytes(12).toString('hex')}${path.extname(f.filename).toLowerCase()}`);
    fs.writeFileSync(stored, f.buffer);
    store.db.run('INSERT INTO documents (master_id, doc_type, filename, stored_path, mime, size, customer_visible, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, 0, ?)',
      id, master[0]?.doc_type || (m.mode === 'AIR' ? 'AWB' : 'MBL'), f.filename, stored, f.mime, f.buffer.length, req.user.id);
  }
  const msg = [`${files.length} document(s) saved on the master`];
  if (parts.length) {
    const d = X.mergeExtractions(parts);
    const read = { mbl_no: d.mawb_no || d.mbl_no, carrier: d.carrier, scac: d.scac, vessel: d.vessel, voyage: d.voyage, flight_no: d.flight_no, etd: d.etd, eta: d.eta,
      pol: d.pol, pod: d.pod, place_of_delivery: d.place_of_delivery, service_term: d.service_term, containers: (d.containers || []).map((c) => c.container_no).join(',') || null };
    const key = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (m.mbl_no && read.mbl_no && key(read.mbl_no) !== key(m.mbl_no)) msg.push(`⚠ the document says ${read.mbl_no}, this master is ${m.mbl_no} — check it is the right master (nothing was filled in)`);
    else {
      const fill = Object.fromEntries(Object.entries(read).filter(([k, v]) => v != null && v !== '' && (m[k] == null || m[k] === '')));
      const r = Object.keys(fill).length ? M.update(id, fill) : { changed: [], houses: [] };
      const notify = require('../notify');
      for (const h of r.houses) if (h.changes.length) await notify.onShipmentChanged(h.id, h.changes, { userId: req.user.id });
      msg.push(r.changed.length ? `filled in: ${r.changed.join(', ')}` : 'nothing new to fill in');
      const touched = r.houses.filter((h) => h.changes.length).length;
      if (touched) msg.push(`${touched} house file(s) updated`);
    }
  }
  if (houses) msg.push(`${houses} house B/L page(s) found — to create house files from them use Upload documents`);
  flash(req, 'ok', msg.join(' · '));
  res.redirect(`/masters/${id}`);
});

module.exports = router;
