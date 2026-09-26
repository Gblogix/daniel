const express = require('express');
const auth = require('../auth');
const S = require('../shipments');

const router = express.Router();

/** Visual tracking board: one card per shipment with the day-by-day ETD→ETA bar. */
router.get('/track', auth.requireLogin, (req, res) => {
  const filter = req.query.filter || 'active';
  let rows = S.list(req.user, { q: req.query.q || '', active: filter === 'active' });
  if (filter === 'delivered') rows = rows.filter((s) => s.status === 'DELIVERED');
  const cards = rows.map((s) => ({ s, tr: S.tracking(s) }));
  const counts = {
    sailing: cards.filter((c) => ['sailing', 'delayed'].includes(c.tr.phase)).length,
    arrived: cards.filter((c) => c.tr.phase === 'arrived' && c.s.status !== 'DELIVERED').length,
    waiting: cards.filter((c) => ['waiting', 'unscheduled'].includes(c.tr.phase)).length,
  };
  res.render('customer/track', { title: 'Shipment tracking', cards, counts, filter, q: req.query.q || '' });
});

module.exports = router;
