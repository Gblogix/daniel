const express = require('express');
const store = require('../db');
const auth = require('../auth');
const S = require('../shipments');
const F = require('../followups');

const router = express.Router();
const safeBack = (v) => (typeof v === 'string' && /^\/(?!\/)/.test(v) ? v : null);

router.get('/followups', auth.requireInternal, (req, res) => {
  const op = Number(req.query.op) || null;
  const scope = op ? 'op' : req.query.scope === 'all' ? 'all' : 'mine';
  const area = ['ops', 'acct'].includes(req.query.area) ? req.query.area : '';
  const view = ['summary', 'details'].includes(req.query.view) ? req.query.view : 'list';
  const items = F.forUser(req.user, { mine: scope === 'mine', owner: op, area, includeHidden: req.query.hidden === '1' });
  const staff = store.db.all("SELECT id, name FROM users WHERE role IN ('admin', 'staff') AND active = 1 ORDER BY name");
  if (view !== 'list') {
    return res.render('followups-team', { title: 'To-do list', view, op, staff, scope, area,
      summary: view === 'summary' ? F.teamSummary(req.user) : null, groups: view === 'details' ? F.byTask(items.filter((i) => !i.hidden)) : null });
  }
  const T = new Date().toISOString().slice(0, 10);
  const groups = [
    ['Overdue & critical', items.filter((i) => !i.hidden && (i.severity === 'critical' || i.due < T))],
    ['Today', items.filter((i) => !i.hidden && i.severity !== 'critical' && i.due === T)],
    ['Coming up', items.filter((i) => !i.hidden && i.severity !== 'critical' && i.due > T)],
    ['Snoozed / done', items.filter((i) => i.hidden)],
  ];
  res.render('followups', { title: 'Follow-ups', groups, scope, area, counts: F.counts(items.filter((i) => !i.hidden)), showHidden: req.query.hidden === '1' });
});

// ---------- Action Center tasks ----------
router.post('/tasks', auth.requireInternal, (req, res) => {
  const title = String(req.body.title || '').trim().slice(0, 200);
  if (title) {
    store.db.run('INSERT INTO tasks (title, shipment_id, assignee_id, due_date, note, created_by) VALUES (?, ?, ?, ?, ?, ?)', title, Number(req.body.shipment_id) || null,
      Number(req.body.assignee_id) || req.user.id, /^\d{4}-\d{2}-\d{2}$/.test(req.body.due_date || '') ? req.body.due_date : null, String(req.body.note || '').trim().slice(0, 500) || null, req.user.id);
  }
  res.redirect(safeBack(req.body.back) || '/dashboard#action-center');
});
router.post('/tasks/:id/:op', auth.requireInternal, (req, res) => {
  const id = Number(req.params.id);
  if (req.params.op === 'done') store.db.run("UPDATE tasks SET status = 'DONE', done_at = datetime('now') WHERE id = ?", id);
  if (req.params.op === 'remind') store.db.run('UPDATE tasks SET remind_at = ? WHERE id = ?', new Date(Date.now() + (Number(req.body.days) || 1) * 86400000).toISOString(), id);
  if (req.params.op === 'reopen') store.db.run("UPDATE tasks SET status = 'OPEN', done_at = NULL, remind_at = NULL WHERE id = ?", id);
  res.redirect(safeBack(req.body.back) || '/dashboard#action-center');
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
  // Names that start with what was typed (or have a word starting with it) before names that only contain it
  // ("national" → NATIONAL SHIPPING before …INTERNATIONAL TRADE).
  const rank = (r) => { const k = P.norm(r.name); return k.startsWith(n) ? 0 : ` ${k}`.includes(` ${n}`) ? 1 : 2; };
  out.sort((a, b) => rank(a) - rank(b));
  res.json(out.slice(0, 10));
});

// Type-ahead for text fields (values used on earlier files).
router.get('/suggest.json', auth.requireInternal, (req, res) => {
  res.json(require('../suggest').suggest(String(req.query.f || ''), String(req.query.q || '').slice(0, 80)));
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
