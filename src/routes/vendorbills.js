const fs = require('node:fs');
const express = require('express');
const multer = require('multer');
const store = require('../db');
const auth = require('../auth');
const S = require('../shipments');
const A = require('../accounting');
const V = require('../vendorbills');
const { expandMailFiles } = require('../extract/mailfile');
const { vendorForSender } = require('../mailin');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 20 } });
const flash = (req, type, msg) => { req.session.flash = { type, msg }; };
const arr = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
const safeBack = (v) => (typeof v === 'string' && /^\/(?!\/)/.test(v) ? v : null);

/** Operations staff may drop a vendor invoice on a file; accounting books it. */
function canUpload(req, res, next) {
  if (!req.user) return res.redirect('/login');
  if (auth.canAccounting(req.user) || auth.can(req.user, 'shipments_edit')) return next();
  return res.status(403).render('error', { title: 'Forbidden', message: 'You cannot upload vendor invoices.' });
}

router.get('/vendor-bills', auth.requireAccounting, (req, res) => {
  const openFiles = store.db.all("SELECT s.id, s.ref_no FROM shipments s WHERE s.closed_at IS NULL ORDER BY s.id DESC LIMIT 300");
  res.render('billing/vendor-bills', { title: 'Vendor invoices', rows: V.pending(), openFiles: openFiles.map((s) => S.find(s.id, null)) });
});

router.post('/vendor-bills/upload', canUpload, upload.array('files', 20), auth.checkCsrf, async (req, res) => {
  const back = safeBack(req.body.back) || '/vendor-bills';
  // A dragged Outlook email (.msg / .eml) is replaced by its PDF / image attachments.
  const { files, mails } = await expandMailFiles((req.files || []).map((f) => ({ buffer: f.buffer, filename: f.originalname, mime: f.mimetype })),
    { accept: ['.pdf', '.jpg', '.jpeg', '.png'] });
  if (!files.length) {
    flash(req, 'err', mails[0]?.error ? `${mails[0].subject}: could not open this email file — save the invoice PDF and drag that instead`
      : mails.length ? `No PDF / image invoice attached to the email "${mails[0].subject}" — drag the attachment itself` : 'Attach the vendor invoice (PDF, JPG or PNG)');
    return res.redirect(back);
  }
  const ids = [];
  for (const f of files) {
    const sender = f.mail?.from && !req.body.company_id ? vendorForSender(f.mail.from) : null;
    ids.push(await V.receive({ buffer: f.buffer, filename: f.filename, mime: f.mime, shipmentId: Number(req.body.shipment_id) || null,
      companyId: Number(req.body.company_id) || sender?.id || null, userId: req.user.id }));
  }
  if (!auth.canAccounting(req.user)) {
    flash(req, 'ok', `${ids.length} vendor invoice(s) sent to accounting to book — thank you`);
    return res.redirect(back);
  }
  if (ids.length === 1) return res.redirect(`/vendor-bills/${ids[0]}`);
  flash(req, 'ok', `${ids.length} vendor invoices read — review and book each one`);
  res.redirect('/vendor-bills');
});

router.get('/vendor-bills/:id', auth.requireAccounting, (req, res) => {
  const d = V.get(Number(req.params.id));
  if (!d) return res.status(404).render('error', { title: 'Not found', message: 'Vendor invoice not found.' });
  if (d.invoice_id) return res.redirect(`/invoices/${d.invoice_id}`);
  const ex = d.ex || {};
  const matched = (ex.shipments || []).map((id) => S.find(id, null)).filter(Boolean);
  const current = d.shipment_id ? S.find(d.shipment_id, null) : null;
  const recent = store.db.all('SELECT id FROM shipments WHERE closed_at IS NULL ORDER BY id DESC LIMIT 200').map((r) => S.find(r.id, null));
  const seen = new Set();
  const files = [current, ...matched, ...recent].filter((s) => s && !seen.has(s.id) && seen.add(s.id));
  const parties = store.db.all('SELECT id, name, type, terms_days FROM companies ORDER BY name');
  const nextId = V.pending().find((x) => x.id !== d.id)?.id || null;
  res.render('billing/vendor-bill', { title: `Book vendor invoice — ${d.filename}`, d, ex, files, matchedIds: matched.map((s) => s.id), parties, codes: A.CHARGE_CODES, nextId });
});

router.post('/vendor-bills/:id', auth.requireAccounting, (req, res) => {
  const d = V.get(Number(req.params.id));
  if (!d) return res.status(404).end();
  const b = req.body;
  const lines = arr(b.l_desc).map((desc, i) => ({ description: desc, qty: arr(b.l_qty)[i], rate: arr(b.l_rate)[i], amount: arr(b.l_amount)[i] }))
    .filter((l) => String(l.description || '').trim());
  if (!b.company_id || !String(b.number || '').trim() || !lines.length) {
    flash(req, 'err', 'Vendor, invoice number and at least one line are required');
    return res.redirect(`/vendor-bills/${d.id}`);
  }
  let id;
  try {
    id = V.book(d.id, { shipment_id: Number(b.shipment_id) || null, company_id: b.company_id, number: String(b.number).trim(), invoice_date: b.invoice_date,
      terms_days: b.terms_days, due_date: b.due_date, memo: b.memo, lines }, { userId: req.user.id });
  } catch (e) {
    flash(req, 'err', /UNIQUE/.test(e.message) ? `Invoice number ${b.number} is already used — add a suffix (e.g. ${b.number}-2) if it is really a different bill` : e.message);
    return res.redirect(`/vendor-bills/${d.id}`);
  }
  const inv = A.getInvoice(id);
  flash(req, 'ok', `Vendor bill ${inv.number} booked — USD ${inv.total.toLocaleString('en-US', { minimumFractionDigits: 2 })}${inv.shipment_id ? ` on ${S.fileName(S.find(inv.shipment_id, null))}` : ''}`);
  if (b.next === '1') {
    const nxt = V.pending()[0];
    if (nxt) return res.redirect(`/vendor-bills/${nxt.id}`);
    return res.redirect('/vendor-bills');
  }
  res.redirect(inv.shipment_id ? `/shipments/${inv.shipment_id}#accounting` : `/invoices/${id}`);
});

router.post('/vendor-bills/:id/reread', auth.requireAccounting, async (req, res) => {
  const d = V.get(Number(req.params.id));
  if (!d) return res.status(404).end();
  const buffer = fs.readFileSync(d.stored_path);
  const ex = await V.extract({ buffer, filename: d.filename, mime: d.mime });
  store.db.run('UPDATE documents SET extracted_json = ?, company_id = COALESCE(company_id, ?) WHERE id = ?', JSON.stringify(ex), ex.vendor?.id || null, d.id);
  flash(req, 'ok', 'Read again');
  res.redirect(`/vendor-bills/${d.id}`);
});

router.post('/vendor-bills/:id/discard', auth.requireAccounting, (req, res) => {
  V.discard(Number(req.params.id));
  flash(req, 'ok', 'Removed from the vendor invoice queue (kept as a document)');
  res.redirect('/vendor-bills');
});

module.exports = router;
