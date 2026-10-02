const express = require('express');
const auth = require('../auth');
const S = require('../shipments');

const router = express.Router();

/** Visual tracking board: one card per shipment with the day-by-day ETD→ETA bar. */
router.get('/track', auth.requireLogin, (req, res) => {
  const internal = auth.INTERNAL.includes(req.user.role);
  const filter = ['active', 'delivered', 'all', ...(internal ? ['history'] : [])].includes(req.query.filter) ? req.query.filter : 'active';
  // Staff: Delivered = billing still open, History = closed (customer paid). Customers see every delivered shipment.
  const stage = { active: 'active', delivered: internal ? 'delivered' : null, history: 'closed', all: null }[filter];
  const sort = ['asc', 'desc'].includes(req.query.sort) ? req.query.sort : '';
  let rows = S.list(req.user, { q: req.query.q || '', stage, sort });
  if (filter === 'delivered' && !internal) rows = rows.filter((s) => s.status === 'DELIVERED');
  // Portal dashboard: Ocean / Air tab, phase counts (click one to list it), arrivals this week.
  const P = require('../portal');
  const m = ['ocean', 'air'].includes(req.query.m) ? req.query.m : '';
  const all = S.list(req.user, { stage: internal ? 'open' : null });
  const inMode = all.filter((s) => s.mode !== 'OTHER' && (!m || (m === 'air' ? s.mode === 'AIR' : s.mode !== 'AIR')));
  const wk = Math.max(-26, Math.min(26, Number(req.query.wk) || 0));
  const phase = P.PHASES.find((p) => p.key === req.query.phase) || null;
  const portal = { m, wk, phase, phases: P.phases(inMode), week: P.week(inMode, wk),
    phaseList: phase ? inMode.filter((s) => P.phaseOf(s) === phase.key).map((s) => ({ s, st: require('../stages').stages(s, s.containers[0] || {}) })) : null };
  if (m) rows = rows.filter((s) => (m === 'air' ? s.mode === 'AIR' : s.mode !== 'AIR'));
  // Invoices tab (customers): invoices we sent them.
  const invoices = req.user.role === 'customer' && req.query.tab === 'invoice'
    ? require('../db').db.all(`SELECT i.id, i.number, i.invoice_date, i.due_date, i.total, i.paid_amount, i.status, s.ref_no, s.hbl_no FROM invoices i LEFT JOIN shipments s ON s.id = i.shipment_id
        WHERE i.company_id = ? AND i.kind = 'AR' AND i.sent_at IS NOT NULL AND i.status <> 'VOID' ORDER BY i.invoice_date DESC LIMIT 200`, req.user.company_id) : null;
  const cards = rows.map((s) => ({ s, tr: S.tracking(s) }));
  const counts = {
    sailing: cards.filter((c) => ['sailing', 'delayed'].includes(c.tr.phase)).length,
    arrived: cards.filter((c) => c.tr.phase === 'arrived' && c.s.status !== 'DELIVERED').length,
    waiting: cards.filter((c) => ['waiting', 'unscheduled'].includes(c.tr.phase)).length,
  };
  res.render('customer/track', { title: 'Shipment tracking', cards, counts, filter, sort, q: req.query.q || '', portal, invoices, tab: invoices ? 'invoice' : 'shipments' });
});

/** A customer opens one of their invoices (the issued PDF). */
router.get('/portal/invoices/:id', auth.requireLogin, (req, res) => {
  const db = require('../db').db;
  const i = db.get("SELECT * FROM invoices WHERE id = ? AND kind = 'AR' AND sent_at IS NOT NULL", Number(req.params.id));
  const mine = i && (auth.INTERNAL.includes(req.user.role) || (req.user.role === 'customer' && i.company_id === req.user.company_id));
  const d = mine && i.document_id ? db.get('SELECT * FROM documents WHERE id = ?', i.document_id) : null;
  if (!d || !d.stored_path || !require('fs').existsSync(d.stored_path)) return res.status(404).render('error', { title: 'Not found', message: 'Invoice PDF not available — please contact us.' });
  res.type('application/pdf');
  res.set('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(d.filename)}`);
  require('fs').createReadStream(d.stored_path).pipe(res);
});

/** Customer asks for a delivery date / time window — lands on the PIC's follow-ups and in their inbox. */
router.post('/shipments/:id/delivery-request', auth.requireLogin, async (req, res) => {
  const store = require('../db');
  const s = S.find(Number(req.params.id), req.user);
  if (!s || !(req.user.role === 'customer' || auth.INTERNAL.includes(req.user.role))) return res.status(404).render('error', { title: 'Not found', message: 'Shipment not found.' });
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.body.date || '') ? req.body.date : null;
  if (!date) { req.session.flash = { type: 'err', msg: 'Please pick a date' }; return res.redirect(`/shipments/${s.id}#request`); }
  const time = String(req.body.time || '').slice(0, 40);
  const note = String(req.body.note || '').slice(0, 500);
  store.db.run(`UPDATE shipments SET delivery_request_date = ?, delivery_request_time = ?, delivery_request_note = ?, delivery_request_at = datetime('now'),
    delivery_request_by = ?, delivery_request_done = 0 WHERE id = ?`, date, time || null, note || null, req.user.id, s.id);
  S.addEvent(s.id, 'DELIVERY_REQUEST', `Delivery requested for ${date}${time ? ` ${time}` : ''} by ${req.user.name}`, { userId: req.user.id });
  const pic = s.owner_id ? store.db.get('SELECT email, name FROM users WHERE id = ?', s.owner_id) : null;
  const config = require('../config');
  const { esc } = require('../docs/templates');
  await require('../notify').queueEmail({
    shipmentId: s.id, kind: 'CUSTOMER_REQUEST', to: [pic?.email || config.company.email],
    subject: `[Delivery request] ${S.fileName(s)} — ${date}${time ? ` ${time}` : ''} (${s.customer_name || req.user.name})`,
    html: `<p>${esc(req.user.name)} (${esc(s.customer_name || '')}) requested delivery for <b>${esc(date)} ${esc(time)}</b>.</p>
      ${note ? `<p>Note: “${esc(note)}”</p>` : ''}<p>File: <a href="${config.baseUrl}/shipments/${s.id}#delivery">${esc(S.fileName(s))} (${esc(s.ref_no)})</a> · MBL ${esc(s.mbl_no || '')} · HBL ${esc(s.hbl_no || '')}</p>`,
  });
  req.session.flash = { type: 'ok', msg: 'Thank you — your delivery request was sent to our team. We will confirm the appointment.' };
  res.redirect(`/shipments/${s.id}`);
});

/** Customer's shipment list as Excel (what they used to keep in Smartsheet). */
router.get('/track.xlsx', auth.requireLogin, async (req, res) => {
  const ExcelJS = require('exceljs');
  const rows = S.list(req.user, { q: req.query.q || '', sort: req.query.sort === 'desc' ? 'desc' : 'asc' });
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Shipments');
  ws.addRow(['Shipment', 'Ref.', 'Shipper', 'Mode', 'Containers', 'MBL / MAWB', 'HBL / HAWB', 'ETD', 'ETA', 'Status', 'Where / next', 'Customs', 'Delivery date', 'Time', 'Deliver to', 'Packages', 'KG', 'CBM', 'Contents']).font = { bold: true };
  for (const s of rows) {
    ws.addRow([S.fileName(s), s.ref_no, s.shipper_name || '', s.mode, s.containers.map((c) => `${c.container_no}${c.size_type ? ` ${c.size_type}` : ''}`).join(', '), s.mbl_no || '', s.hbl_no || '',
      s.atd || s.etd || '', s.ata || s.eta || '', S.statusLabel(s.status), S.customerStep(s).text, s.customs_status, s.delivery_date || '', s.delivery_time || '', s.delivery_address || '',
      s.packages ? `${s.packages} ${s.package_unit || ''}` : '', s.weight_kg || '', s.cbm || '', s.items.map((i) => i.description).join('; ')]);
  }
  ws.columns.forEach((c, i) => { c.width = [34, 11, 26, 7, 24, 18, 16, 11, 11, 16, 44, 10, 12, 8, 36, 12, 10, 8, 50][i] || 12; });
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  res.set('Content-Disposition', `attachment; filename="Shipments_${new Date().toISOString().slice(0, 10)}.xlsx"`);
  res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(Buffer.from(await wb.xlsx.writeBuffer()));
});

module.exports = router;
