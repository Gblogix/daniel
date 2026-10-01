const express = require('express');
const store = require('../db');
const auth = require('../auth');
const S = require('../shipments');
const M = require('../masters');

const router = express.Router();
const flash = (req, type, msg) => { req.session.flash = { type, msg }; };
const agents = () => store.db.all("SELECT id, name FROM companies WHERE type = 'agent' ORDER BY name");

router.get('/masters', auth.requireInternal, (req, res) => {
  const sort = req.query.sort === 'desc' ? 'desc' : 'asc';
  res.render('masters/list', { title: 'Master B/L list', rows: M.list({ q: String(req.query.q || '').trim(), sort }), q: req.query.q || '', sort });
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

module.exports = router;
