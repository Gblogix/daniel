/**
 * Work lists (GoFreight style): My Containers (one row per container, 12 stages) and the quick edits / bulk actions
 * used on the House B/L list — inline note, colour label, flag, change OP, block, send A/N.
 */
const express = require('express');
const auth = require('../auth');
const store = require('../db');
const S = require('../shipments');
const ST = require('../stages');

const router = express.Router();
const flash = (req, type, msg) => { req.session.flash = { type, msg }; };
const LABELS = { urgent: 'Urgent', important: 'Important', traffic: 'Traffic', document: 'Document' };
const arr = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);

function containerRows(user, q = {}) {
  const files = S.list(user, { stage: 'open' }).filter((s) => !S.isMisc(s) && s.mode !== 'TRUCK');
  const rows = [];
  for (const s of files) {
    if (q.op && String(s.owner_id) !== String(q.op)) continue;
    if (q.from && (s.eta || '') < q.from) continue;
    if (q.to && (s.eta || '9999') > q.to) continue;
    const units = s.mode === 'FCL' && s.containers.length ? s.containers : [null];
    for (const c of units) {
      const st = ST.stages(s, c || {});
      const fl = ST.flags(s, c || {});
      if (st.list[st.list.length - 1].done) continue; // complete → off the working list
      rows.push({ s, c, st, fl, type: s.mode === 'FCL' ? 'fcl' : 'others' });
    }
  }
  const tabs = { all: rows.length, overdue: rows.filter((r) => r.fl.overdue).length, pickup: rows.filter((r) => r.fl.toPickUp).length };
  const type = q.type === 'others' ? 'others' : 'fcl';
  let list = rows.filter((r) => r.type === type);
  if (q.tab === 'overdue') list = list.filter((r) => r.fl.overdue);
  if (q.tab === 'pickup') list = list.filter((r) => r.fl.toPickUp);
  if (q.stage) list = list.filter((r) => r.st.current === q.stage);
  list.sort((a, b) => String(a.s.eta || '9999').localeCompare(String(b.s.eta || '9999')));
  return { list, tabs, counts: { fcl: rows.filter((r) => r.type === 'fcl').length, others: rows.filter((r) => r.type === 'others').length }, type };
}

router.get('/containers', auth.requireInternal, (req, res) => {
  const q = { tab: ['overdue', 'pickup'].includes(req.query.tab) ? req.query.tab : 'all', type: req.query.type, from: req.query.from || '', to: req.query.to || '', op: req.query.op || '', stage: req.query.stage || '' };
  const r = containerRows(req.user, q);
  const staff = store.db.all("SELECT id, name FROM users WHERE role IN ('admin', 'staff') AND active = 1 ORDER BY name");
  res.render('worklists/containers', { title: 'My containers', ...r, q, staff, LABELS });
});

router.get('/containers.xlsx', auth.requireInternal, async (req, res) => {
  const ExcelJS = require('exceljs');
  const { list } = containerRows(req.user, { ...req.query });
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('Containers');
  ws.addRow(['File', 'Customer', 'Container', 'Size', 'MB/L', 'HB/L', 'ETA', 'LFD', 'Stage', 'Next', 'Remarks', 'Internal remarks', 'Last tracking update']).font = { bold: true };
  for (const r of list) ws.addRow([r.s.ref_no, r.s.customer_name || '', r.c?.container_no || '', r.c?.size_type || '', r.s.mbl_no || '', r.s.hbl_no || '', r.s.eta || '', r.c?.pickup_lfd || r.s.last_free_day || '',
    `${r.st.current} (${r.st.n}/${r.st.total})`, r.st.next || '', r.c?.remark || '', r.c ? r.c.internal_note || '' : r.s.internal_note || '', r.s.tracking_checked_at || '']);
  ws.columns.forEach((c) => { c.width = 18; });
  res.attachment('my-containers.xlsx');
  res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(Buffer.from(await wb.xlsx.writeBuffer()));
});

/** Inline edits from the lists (JSON). */
router.post('/quick/shipments/:id', auth.requirePerm('shipments_edit'), (req, res) => {
  const id = Number(req.params.id); const b = req.body;
  if ('internal_note' in b) store.db.run('UPDATE shipments SET internal_note = ? WHERE id = ?', String(b.internal_note || '').slice(0, 300) || null, id);
  if ('color_label' in b) store.db.run('UPDATE shipments SET color_label = ? WHERE id = ?', LABELS[b.color_label] ? b.color_label : null, id);
  if ('flagged' in b) store.db.run('UPDATE shipments SET flagged = ? WHERE id = ?', b.flagged ? 1 : 0, id);
  // OP / Sales from the file's header bar (only staff accounts).
  for (const k of ['owner_id', 'sales_id']) {
    if (!(k in b)) continue;
    const uid = Number(b[k]) || null;
    if (uid && !store.db.get("SELECT 1 FROM users WHERE id = ? AND role IN ('admin', 'staff') AND active = 1", uid)) return res.status(400).json({ error: 'Unknown user' });
    S.update(id, { [k]: uid || '' });
  }
  res.json({ ok: true });
});
router.post('/quick/containers/:id', auth.requirePerm('shipments_edit'), (req, res) => {
  const id = Number(req.params.id); const b = req.body;
  for (const k of ['remark', 'internal_note']) if (k in b) store.db.run(`UPDATE containers SET ${k} = ? WHERE id = ?`, String(b[k] || '').slice(0, 300) || null, id);
  if ('color_label' in b) store.db.run('UPDATE containers SET color_label = ? WHERE id = ?', LABELS[b.color_label] ? b.color_label : null, id);
  res.json({ ok: true });
});

/** Bulk actions on the checked files of a list. */
router.post('/bulk/shipments', auth.requirePerm('shipments_edit'), async (req, res) => {
  const ids = arr(req.body.ids).map(Number).filter(Boolean);
  const back = typeof req.body.back === 'string' && /^\/(?!\/)/.test(req.body.back) ? req.body.back : '/shipments';
  if (!ids.length) { flash(req, 'err', 'Tick the files first'); return res.redirect(back); }
  const FT = require('../fileTools');
  const a = req.body.action;
  if (a === 'owner') {
    const owner = Number(req.body.owner_id) || null;
    for (const id of ids) S.update(id, { owner_id: owner });
    flash(req, 'ok', `OP changed on ${ids.length} file(s)`);
  } else if (a === 'block' || a === 'unblock') {
    for (const id of ids) FT.block(id, a === 'block', { reason: req.body.reason, userId: req.user.id });
    flash(req, 'ok', `${ids.length} file(s) ${a === 'block' ? 'blocked' : 'unblocked'}`);
  } else if (a === 'send-an') {
    if (!auth.can(req.user, 'send_notices')) { flash(req, 'err', 'No permission to send notices'); return res.redirect(back); }
    const notify = require('../notify');
    let sent = 0;
    for (const id of ids) if (await notify.sendBrokerPacket(id, { userId: req.user.id })) sent += 1;
    flash(req, sent === ids.length ? 'ok' : 'err', `A/N sent for ${sent} of ${ids.length} file(s)${sent < ids.length ? ' — the others have no customs broker email' : ''}`);
  } else if (a === 'label') {
    for (const id of ids) store.db.run('UPDATE shipments SET color_label = ? WHERE id = ?', LABELS[req.body.color_label] ? req.body.color_label : null, id);
    flash(req, 'ok', `Label set on ${ids.length} file(s)`);
  } else flash(req, 'err', 'Pick an action');
  res.redirect(back);
});

module.exports = router;
module.exports.containerRows = containerRows;
module.exports.LABELS = LABELS;
