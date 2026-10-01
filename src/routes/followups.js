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
/**
 * Names for the Shipper / Consignee / Notify fields with their address: from Parties and from earlier files (the
 * address last used for that name). Parties of the fitting type first.
 */
router.get('/parties/lookup.json', auth.requireInternal, (req, res) => {
  const db = store.db;
  const P = require('../extract/party');
  const role = ['shipper', 'consignee', 'notify'].includes(req.query.role) ? req.query.role : 'consignee';
  const q = String(req.query.q || '').trim();
  const n = P.norm(q);
  if (n.length < 2) return res.json([]);
  const prefer = { shipper: ['shipper', 'agent'], consignee: ['customer', 'importer'], notify: ['customer', 'importer', 'broker'] }[role];
  const out = [];
  const seen = new Set();
  const push = (r) => { const k = P.norm(r.name); if (!k || seen.has(k)) return; seen.add(k); out.push(r); };
  const like = `%${q.replace(/[%_]/g, '').split(/\s+/)[0]}%`;
  const parties = db.all('SELECT id, name, short_name, type, address, country FROM companies WHERE name LIKE ? OR short_name LIKE ? LIMIT 50', like, like)
    .filter((c) => P.norm(c.name).includes(n) || P.norm(c.short_name).includes(n))
    .sort((a, b) => (prefer.includes(b.type) - prefer.includes(a.type)) || a.name.localeCompare(b.name));
  for (const c of parties) push({ name: c.name, address: c.address || '', company_id: c.id, type: c.type, source: 'party' });
  const col = { shipper: ['shipper_name', 'shipper_address'], consignee: ['consignee_name', 'consignee_address'], notify: ['notify_party', 'notify_address'] }[role];
  const used = db.all(`SELECT ${col[0]} AS name, ${col[1]} AS address, MAX(id) AS last FROM shipments WHERE ${col[0]} LIKE ? AND ${col[0]} <> ''
    GROUP BY UPPER(${col[0]}) ORDER BY last DESC LIMIT 30`, like).filter((r) => P.norm(r.name).includes(n));
  for (const r of used) {
    // The address used most recently for this name (an earlier file may have it when the latest one does not).
    const addr = r.address || db.get(`SELECT ${col[1]} AS a FROM shipments WHERE UPPER(${col[0]}) = UPPER(?) AND ${col[1]} <> '' ORDER BY id DESC LIMIT 1`, r.name)?.a || '';
    const party = P.findParty(r.name, { db });
    const partyAddr = party ? db.get('SELECT address FROM companies WHERE id = ?', party.id)?.address : null;
    push({ name: r.name, address: addr || partyAddr || '', company_id: party?.id || null, type: party?.type || null, source: 'file' });
  }
  res.json(out.slice(0, 10));
});

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
