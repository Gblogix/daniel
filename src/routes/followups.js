const express = require('express');
const store = require('../db');
const auth = require('../auth');
const S = require('../shipments');
const F = require('../followups');

const router = express.Router();
const safeBack = (v) => (typeof v === 'string' && /^\/(?!\/)/.test(v) ? v : null);

router.get('/followups', auth.requireInternal, (req, res) => {
  const scope = req.query.scope === 'all' ? 'all' : 'mine';
  const area = ['ops', 'acct'].includes(req.query.area) ? req.query.area : '';
  const items = F.forUser(req.user, { mine: scope === 'mine', area, includeHidden: req.query.hidden === '1' });
  const T = new Date().toISOString().slice(0, 10);
  const groups = [
    ['Overdue & critical', items.filter((i) => !i.hidden && (i.severity === 'critical' || i.due < T))],
    ['Today', items.filter((i) => !i.hidden && i.severity !== 'critical' && i.due === T)],
    ['Coming up', items.filter((i) => !i.hidden && i.severity !== 'critical' && i.due > T)],
    ['Snoozed / done', items.filter((i) => i.hidden)],
  ];
  res.render('followups', { title: 'Follow-ups', groups, scope, area, counts: F.counts(items.filter((i) => !i.hidden)), showHidden: req.query.hidden === '1' });
});

/** Bell in the workspace top bar. */
router.get('/followups/count.json', auth.requireInternal, (req, res) => {
  res.json(F.counts(F.forUser(req.user, { mine: true })));
});

router.post('/followups/snooze', auth.requireInternal, (req, res) => {
  F.snooze(String(req.body.key), Math.min(30, Math.max(1, Number(req.body.days) || 1)), { userId: req.user.id });
  res.redirect(safeBack(req.body.back) || '/followups');
});
router.post('/followups/done', auth.requireInternal, (req, res) => {
  F.done(String(req.body.key), { userId: req.user.id });
  res.redirect(safeBack(req.body.back) || '/followups');
});
router.post('/followups/reopen', auth.requireInternal, (req, res) => {
  F.reopen(String(req.body.key));
  res.redirect(safeBack(req.body.back) || '/followups');
});

/** Global search (top bar): files by container / B/L / shipper / customer / file no., invoices, parties. */
router.get('/search.json', auth.requireInternal, (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json([]);
  const out = S.list(req.user, { q }).slice(0, 8).map((s) => ({
    type: 'File', label: S.fileName(s), sub: [s.ref_no, s.customer_name, S.statusLabel(s.status), s.closed_at ? 'closed' : ''].filter(Boolean).join(' · '), href: `/shipments/${s.id}`,
  }));
  if (auth.canAccounting(req.user)) {
    for (const i of store.db.all("SELECT i.id, i.number, i.kind, i.total, c.name AS company_name FROM invoices i LEFT JOIN companies c ON c.id = i.company_id WHERE i.number LIKE ? ORDER BY i.id DESC LIMIT 5", `%${q}%`)) {
      out.push({ type: i.kind === 'AP' ? 'Vendor bill' : i.kind === 'DN' ? 'D/N' : 'Invoice', label: i.number, sub: `${i.company_name || ''} · USD ${Math.abs(i.total).toFixed(2)}`, href: `/invoices/${i.id}` });
    }
  }
  for (const c of store.db.all('SELECT id, name, type FROM companies WHERE name LIKE ? OR short_name LIKE ? ORDER BY name LIMIT 5', `%${q}%`, `%${q}%`)) {
    out.push({ type: 'Party', label: c.name, sub: c.type, href: auth.canAccounting(req.user) ? `/billing/parties/${c.id}` : `/companies/${c.id}` });
  }
  res.json(out);
});

module.exports = router;
