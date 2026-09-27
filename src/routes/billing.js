const express = require('express');
const store = require('../db');
const auth = require('../auth');
const S = require('../shipments');
const A = require('../accounting');
const notify = require('../notify');
const company = require('../company');
const { INVOICE_GENERATORS, invoiceFileName, esc } = require('../docs/templates');

const router = express.Router();
const flash = (req, type, msg) => { req.session.flash = { type, msg }; };
const arr = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
const parties = () => store.db.all('SELECT id, name, type, terms_days FROM companies ORDER BY type, name');

// ---------- overview ----------
router.get('/billing', auth.requireAccounting, (req, res) => {
  const db = store.db;
  const aging = A.arAging();
  const agents = db.all("SELECT id, name FROM companies WHERE type = 'agent' ORDER BY name")
    .map((a) => ({ ...a, soa: A.agentStatement(a.id) })).filter((a) => a.soa.items.length);
  const payments = db.all(`SELECT p.*, c.name AS company_name, (SELECT COUNT(*) FROM payment_allocations x WHERE x.payment_id = p.id) AS n
    FROM payments p LEFT JOIN companies c ON c.id = p.company_id ORDER BY p.paid_on DESC, p.id DESC LIMIT 30`);
  const unsent = db.all(`SELECT i.*, c.name AS company_name, s.hbl_no FROM invoices i LEFT JOIN companies c ON c.id = i.company_id
    LEFT JOIN shipments s ON s.id = i.shipment_id WHERE i.kind IN ('AR','DN') AND i.sent_at IS NULL AND i.status = 'OPEN' ORDER BY c.name, i.number`);
  // Everyone we owe money to (vendor bills, agent credit notes), and everyone who owes us — for checkbox settlement.
  const open = db.all(`SELECT c.id, c.name, c.type,
      ROUND(SUM(CASE WHEN i.kind = 'AR' OR (i.kind = 'DN' AND i.total > 0) THEN ABS(i.total) - i.paid_amount ELSE 0 END), 2) AS due_to_us,
      ROUND(SUM(CASE WHEN i.kind = 'AP' OR (i.kind = 'DN' AND i.total < 0) THEN ABS(i.total) - i.paid_amount ELSE 0 END), 2) AS due_to_them,
      COUNT(*) AS n, MIN(i.due_date) AS oldest_due
    FROM invoices i JOIN companies c ON c.id = i.company_id WHERE i.status = 'OPEN' GROUP BY c.id ORDER BY c.name`);
  const vendors = open.filter((o) => o.due_to_them > 0);
  res.render('billing/index', { title: 'Billing', aging, agents, payments, unsent, vendors, parties: parties() });
});

// ---------- invoice editor ----------
router.get('/invoices/new', auth.requireAccounting, (req, res) => {
  const kind = ['AR', 'DN', 'AP'].includes(req.query.kind) ? req.query.kind : 'AR';
  const s = req.query.shipment ? S.find(Number(req.query.shipment), null) : null;
  const inv = { kind, shipment_id: s?.id || null, invoice_date: new Date().toISOString().slice(0, 10), currency: 'USD', lines: [] };
  if (s) {
    if (kind === 'AR') { inv.company_id = s.customer_id; inv.ship_to = s.consignee_name || ''; inv.customer_ref = s.customer_ref || ''; }
    if (kind === 'DN') { inv.company_id = s.agent_id; inv.agent_ref = s.agent_ref || s.sub_bl_no || s.hbl_no || ''; inv.profit_share = 0; }
    if (kind === 'AP') inv.company_id = s.trucker_id;
    // D/N = cost recovery: start from the AP costs already booked on the shipment.
    if (kind === 'DN' && req.query.from_ap) {
      inv.lines = store.db.all(`SELECT l.description, l.unit, l.rate, l.qty, l.amount FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id
        WHERE i.shipment_id = ? AND i.kind = 'AP' AND i.status <> 'VOID'`, s.id).map((l) => ({ ...l, mh: 'M', bl_no: s.hbl_no, pc: 'C', side: 'DEBIT' }));
    }
  }
  res.render('billing/invoice', { title: `New ${kind === 'AR' ? 'invoice' : kind === 'DN' ? 'debit note' : 'vendor bill'}`, inv, s, parties: parties(), codes: A.CHARGE_CODES });
});

router.get('/invoices/:id', auth.requireAccounting, (req, res) => {
  const inv = A.getInvoice(Number(req.params.id));
  if (!inv) return res.status(404).render('error', { title: 'Not found', message: 'Invoice not found.' });
  const s = inv.shipment_id ? S.find(inv.shipment_id, null) : null;
  const allocations = store.db.all(`SELECT a.amount, p.paid_on, p.method, p.reference, p.direction FROM payment_allocations a
    JOIN payments p ON p.id = a.payment_id WHERE a.invoice_id = ? ORDER BY p.paid_on`, inv.id);
  res.render('billing/invoice', { title: inv.number, inv, s, parties: parties(), codes: A.CHARGE_CODES, allocations });
});

function linesFromBody(b) {
  return arr(b.l_desc).map((d, i) => ({
    description: d, mh: arr(b.l_mh)[i], bl_no: arr(b.l_bl)[i], unit: arr(b.l_unit)[i], rate: arr(b.l_rate)[i], qty: arr(b.l_qty)[i],
    amount: arr(b.l_amount)[i], pc: arr(b.l_pc)[i], side: arr(b.l_side)[i],
  }));
}

router.post('/invoices', auth.requireAccounting, (req, res) => {
  const id = A.saveInvoice({ ...req.body, lines: linesFromBody(req.body) }, { userId: req.user.id });
  flash(req, 'ok', 'Saved');
  res.redirect(`/invoices/${id}`);
});
router.post('/invoices/:id', auth.requireAccounting, (req, res) => {
  const cur = A.getInvoice(Number(req.params.id));
  if (!cur) return res.status(404).end();
  A.saveInvoice({ ...req.body, kind: cur.kind, lines: linesFromBody(req.body) }, { userId: req.user.id, id: cur.id });
  flash(req, 'ok', 'Saved');
  res.redirect(`/invoices/${cur.id}`);
});
router.post('/invoices/:id/void', auth.requireAccounting, (req, res) => {
  A.voidInvoice(Number(req.params.id));
  flash(req, 'ok', 'Voided');
  res.redirect(`/invoices/${req.params.id}`);
});

function renderInvoice(inv, userId) {
  const s = inv.shipment_id ? S.find(inv.shipment_id, null) : null;
  const user = userId ? store.db.get('SELECT name FROM users WHERE id = ?', userId) : null;
  const prepared = inv.prepared_by ? store.db.get('SELECT name FROM users WHERE id = ?', inv.prepared_by) : null;
  return INVOICE_GENERATORS[inv.kind](inv, { company: company.get(), shipment: s, preparedBy: prepared?.name || user?.name || '' });
}

router.get('/invoices/:id/preview', auth.requireAccounting, (req, res) => {
  const inv = A.getInvoice(Number(req.params.id));
  if (!inv || !INVOICE_GENERATORS[inv.kind]) return res.status(404).render('error', { title: 'Not found', message: 'No printable document.' });
  res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:");
  res.type('html').send(renderInvoice(inv, req.user.id));
});

/** Issue the PDF (AR_INV12214_Unlockt.pdf / DC_DCN11664-NSC.pdf) and link it to the invoice. Reuses the current PDF unless `force`. */
async function issue(inv, userId, { force = false } = {}) {
  if (!force && inv.document_id) {
    const d = store.db.get('SELECT * FROM documents WHERE id = ?', inv.document_id);
    if (d) return d;
  }
  const html = renderInvoice(inv, userId);
  const d = await notify.storeGenerated(store.db, {
    shipmentId: inv.shipment_id, type: inv.kind, base: invoiceFileName(inv), html, visible: false, userId, refNo: inv.number,
  });
  store.db.run('UPDATE invoices SET document_id = ? WHERE id = ?', d.id, inv.id);
  return d;
}
router.post('/invoices/:id/issue', auth.requireAccounting, async (req, res) => {
  const inv = A.getInvoice(Number(req.params.id));
  const d = await issue(inv, req.user.id, { force: true });
  flash(req, 'ok', `${d.filename} issued`);
  res.redirect(`/invoices/${inv.id}`);
});

const billingTo = (inv) => (inv.billing_emails || inv.company_emails || '').split(/[,;\s]+/).filter((e) => /.+@.+\..+/.test(e));

/** Email one D/N to the agent, or one AR invoice to the customer. */
router.post('/invoices/:id/send', auth.requireAccounting, async (req, res) => {
  const inv = A.getInvoice(Number(req.params.id));
  const to = billingTo(inv);
  if (!to.length) { flash(req, 'err', `No billing email for ${inv.company_name} — add it on the Parties page`); return res.redirect(`/invoices/${inv.id}`); }
  if (inv.kind === 'AR') return sendArBatch(req, res, inv.company_id, [inv.id]);
  const d = await issue(inv, req.user.id);
  const refs = [...new Set([inv.agent_ref, inv.hbl_no, inv.mbl_no].filter(Boolean))].join(' // ');
  await notify.queueEmail({
    shipmentId: inv.shipment_id, kind: 'DEBIT_NOTE', to,
    subject: `[GLOBALBRIDGE/NSC] ${inv.total < 0 ? 'C/N' : 'D/N'} ${inv.number}${refs ? ` // ${refs}` : ''}`,
    html: `<p>Dear ${esc(inv.company_name)},</p><p>동 건 ${inv.total < 0 ? 'C/N' : 'D/N'} 전달 드립니다. / Please find attached our ${inv.total < 0 ? 'credit' : 'debit'} note <b>${esc(inv.number)}</b>
      (USD ${Math.abs(inv.total).toLocaleString('en-US', { minimumFractionDigits: 2 })}${inv.total < 0 ? ', due to you' : ''}).</p>`,
    documents: [d],
  });
  store.db.run("UPDATE invoices SET sent_at = datetime('now') WHERE id = ?", inv.id);
  flash(req, 'ok', `${inv.number} emailed to ${to.join(', ')}`);
  res.redirect(`/invoices/${inv.id}`);
});

/**
 * AR batch as the accounting team sends it: one email per customer, subject "Invoice - <Customer>", one line per
 * invoice "INV-12285 : <memo> // HBL# … // CTN# …", PDFs attached.
 */
async function sendArBatch(req, res, companyId, ids) {
  const invs = ids.map((id) => A.getInvoice(Number(id))).filter((i) => i && i.kind === 'AR' && i.company_id === Number(companyId));
  if (!invs.length) { flash(req, 'err', 'Nothing to send'); return res.redirect('/billing'); }
  const to = billingTo(invs[0]);
  if (!to.length) { flash(req, 'err', `No billing email for ${invs[0].company_name}`); return res.redirect('/billing'); }
  const docs = [];
  const lines = [];
  for (const inv of invs) {
    docs.push(await issue(inv, req.user.id));
    const s = inv.shipment_id ? S.find(inv.shipment_id, null) : null;
    const refs = [s?.ci_invoice_no && `CI# ${s.ci_invoice_no}`, s?.hbl_no && `HBL# ${s.hbl_no}`, s?.containers?.length && `CTN# ${s.containers.map((c) => c.container_no).join(', ')}`].filter(Boolean);
    lines.push(`<li><b>${esc(inv.number)}</b> : ${esc(inv.memo || s?.commodity || '')}${refs.length ? ` // ${esc(refs.join(' // '))}` : ''} — USD ${inv.total.toLocaleString('en-US', { minimumFractionDigits: 2 })}, due ${esc(inv.due_date)}</li>`);
  }
  await notify.queueEmail({
    kind: 'AR_INVOICE', to, subject: `Invoice - ${invs[0].company_name}`,
    html: `<p>Hello,</p><p>배송 완료된 인보이스 건 전달 드립니다. / Please find attached the invoice(s) below.</p><ul>${lines.join('')}</ul>
      <p>Total USD ${invs.reduce((a, i) => a + i.balance, 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}</p>`,
    documents: docs,
  });
  for (const inv of invs) store.db.run("UPDATE invoices SET sent_at = datetime('now') WHERE id = ?", inv.id);
  flash(req, 'ok', `${invs.length} invoice(s) emailed to ${to.join(', ')}`);
  return res.redirect(req.body.back || '/billing');
}
router.post('/billing/send-batch', auth.requireAccounting, (req, res) => sendArBatch(req, res, Number(req.body.company_id), arr(req.body.invoice_ids)));

// ---------- payments ----------
router.post('/billing/payments', auth.requireAccounting, (req, res) => {
  const allocations = req.body.allocations_for ? [{ invoice_id: Number(req.body.allocations_for), amount: Number(req.body.amount) }] : null;
  const r = A.recordPayment({ ...req.body, company_id: Number(req.body.company_id), allocations }, { userId: req.user.id });
  flash(req, 'ok', `Payment recorded${r.unapplied > 0 ? ` — USD ${r.unapplied} unapplied (no more open items)` : ''}`);
  res.redirect(req.body.back || '/billing');
});

// ---------- open items by party — check the items to settle ----------
router.get('/billing/parties/:id', auth.requireAccounting, (req, res) => {
  const party = store.db.get('SELECT * FROM companies WHERE id = ?', Number(req.params.id));
  if (!party) return res.status(404).render('error', { title: 'Not found', message: 'Party not found.' });
  const items = A.openItems(party.id);
  const paid = store.db.all(`SELECT i.*, s.ref_no, s.shipper_name, s.hbl_no, s.mbl_no, s.mode,
      (SELECT k.container_no FROM containers k WHERE k.shipment_id = s.id ORDER BY k.id LIMIT 1) AS first_ctn,
      (SELECT COUNT(*) FROM containers k WHERE k.shipment_id = s.id) AS ctn_count
    FROM invoices i LEFT JOIN shipments s ON s.id = i.shipment_id WHERE i.company_id = ? AND i.status = 'PAID' ORDER BY i.paid_at DESC, i.id DESC LIMIT 50`, party.id);
  res.render('billing/party', { title: `Open items — ${party.name}`, party, items, paid });
});
router.post('/billing/parties/:id/settle', auth.requireAccounting, (req, res) => {
  const companyId = Number(req.params.id);
  const picked = arr(req.body.invoice_ids).map((id) => ({ invoice_id: Number(id), amount: req.body[`amt_${id}`] }));
  if (!picked.length) { flash(req, 'err', 'Check at least one item'); return res.redirect(`/billing/parties/${companyId}`); }
  const r = A.settleSelected({ company_id: companyId, items: picked, paid_on: req.body.paid_on, method: req.body.method, reference: req.body.reference, memo: req.body.memo }, { userId: req.user.id });
  const fmt = (v) => v.toLocaleString('en-US', { minimumFractionDigits: 2 });
  flash(req, 'ok', `${picked.length} item(s) settled — ${r.direction === 'IN' ? 'received' : 'paid'} USD ${fmt(r.amount)}${r.netted ? ` (USD ${fmt(r.netted)} offset by netting)` : ''}`);
  res.redirect(`/billing/parties/${companyId}`);
});

// ---------- profit & loss by file ----------
router.get('/billing/profit', auth.requireAccounting, async (req, res) => {
  const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : '';
  const from = month ? `${month}-01` : req.query.from || '';
  const to = month ? `${month}-31` : req.query.to || '';
  const f = { from, to, customerId: Number(req.query.customer) || null, stage: req.query.stage || '' };
  const report = A.profitReport(f);
  if (req.query.format === 'xlsx') {
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('P&L by file');
    ws.addRow(['File', 'File no.', 'Customer', 'Mode', 'ETA', 'MBL', 'HBL', 'Revenue', 'Cost', 'Profit', 'Margin %', 'Closed']).font = { bold: true };
    for (const r of report.rows) ws.addRow([S.fileName(r), r.ref_no, r.customer_name || '', r.mode, r.eta || '', r.mbl_no || '', r.hbl_no || '', r.revenue, r.cost, r.profit, r.margin, r.closed_at ? r.closed_at.slice(0, 10) : '']);
    ws.addRow(['Total', '', '', '', '', '', '', report.total.revenue, report.total.cost, report.total.profit, report.total.margin]).font = { bold: true };
    [8, 9, 10].forEach((c) => { ws.getColumn(c).numFmt = '#,##0.00;[Red]-#,##0.00'; ws.getColumn(c).width = 14; });
    ws.getColumn(1).width = 36;
    res.set('Content-Disposition', `attachment; filename="PL_by_file_${month || new Date().toISOString().slice(0, 10)}.xlsx"`);
    return res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(Buffer.from(await wb.xlsx.writeBuffer()));
  }
  const customers = store.db.all("SELECT id, name FROM companies WHERE type IN ('customer', 'importer') ORDER BY name");
  res.render('billing/profit', { title: 'Profit & loss by file', report, q: { ...req.query, month }, customers });
});

// ---------- agent statement of account ----------
router.get('/billing/agents/:id', auth.requireAccounting, (req, res) => {
  const agent = store.db.get('SELECT * FROM companies WHERE id = ?', Number(req.params.id));
  if (!agent) return res.status(404).end();
  const soa = A.agentStatement(agent.id, { includePaid: req.query.all === '1' });
  res.render('billing/soa', { title: `SOA — ${agent.name}`, agent, soa, all: req.query.all === '1' });
});
router.post('/billing/agents/:id/settle', auth.requireAccounting, (req, res) => {
  const r = A.settleNetting({ company_id: Number(req.params.id), invoice_ids: arr(req.body.invoice_ids), paid_on: req.body.paid_on, reference: req.body.reference, memo: req.body.memo }, { userId: req.user.id });
  flash(req, 'ok', `Settled — ${r.net >= 0 ? `agent pays USD ${r.net}` : `we pay USD ${-r.net}`} (receivable ${r.receivable}, payable ${r.payable}); unselected items carried forward`);
  res.redirect(`/billing/agents/${req.params.id}`);
});

router.post('/billing/agents/:id/pay', auth.requireAccounting, (req, res) => {
  const r = A.payOnAccount({ company_id: Number(req.params.id), direction: req.body.direction || 'OUT', amount: req.body.amount, paid_on: req.body.paid_on,
    method: req.body.method, reference: req.body.reference, memo: req.body.memo, netFirst: Boolean(req.body.net_first) }, { userId: req.user.id });
  flash(req, 'ok', `Recorded${r.netting ? ` — offset ${r.netting} of D/N first` : ''}${r.unapplied > 0 ? ` — ${r.unapplied} kept on account (applied to the next items)` : ''}`);
  res.redirect(`/billing/agents/${req.params.id}`);
});

async function soaWorkbook(agent, soa) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('SOA');
  ws.addRow([`${company.get().name} — Statement of Account`]);
  ws.addRow([`Agent: ${agent.name}`, '', '', '', `As of ${new Date().toISOString().slice(0, 10)}`]);
  ws.addRow([]);
  ws.addRow(['Date', 'Doc No.', 'Type', 'Our Filing No.', 'Agent Ref / HBL', 'MBL', 'ETA', 'Amount (USD)', 'Settled', 'Open', 'Running', 'Sent']).font = { bold: true };
  for (const i of soa.items) {
    ws.addRow([i.invoice_date, i.number, i.kind === 'AP' ? 'Agent invoice' : i.total < 0 ? 'Credit note' : 'Debit note', i.ref_no || '',
      i.agent_ref || i.ship_agent_ref || i.hbl_no || '', i.mbl_no || '', i.eta || '', i.signed, i.paid_amount, i.open, i.running, i.sent_at ? i.sent_at.slice(0, 10) : '']);
  }
  ws.addRow([]);
  ws.addRow(['', '', '', '', '', '', 'Due to us', soa.dueToUs]).font = { bold: true };
  ws.addRow(['', '', '', '', '', '', 'Due to agent', soa.dueToAgent]).font = { bold: true };
  if (soa.paidOnAccount) ws.addRow(['', '', '', '', '', '', 'Paid on account (unapplied)', soa.paidOnAccount]).font = { bold: true };
  if (soa.receivedOnAccount) ws.addRow(['', '', '', '', '', '', 'Received on account (unapplied)', soa.receivedOnAccount]).font = { bold: true };
  ws.addRow(['', '', '', '', '', '', 'Net (+ due to GlobalBridge)', soa.net]).font = { bold: true };
  if (soa.months.length) {
    const wm = wb.addWorksheet('By month');
    wm.addRow(['Month', 'Items', 'Due to us', 'Due to agent', 'Net', 'Guideline pay-by']).font = { bold: true };
    for (const g of soa.months) wm.addRow([g.month, g.count, g.dueToUs, g.dueToAgent, g.net, g.guideline]);
    [3, 4, 5].forEach((c) => { wm.getColumn(c).numFmt = '#,##0.00;[Red]-#,##0.00'; wm.getColumn(c).width = 14; });
  }
  ws.columns.forEach((c, i) => { c.width = [11, 13, 13, 14, 20, 18, 11, 14, 11, 12, 12, 11][i] || 12; });
  [8, 9, 10, 11].forEach((c) => { ws.getColumn(c).numFmt = '#,##0.00;[Red]-#,##0.00'; });
  return wb.xlsx.writeBuffer();
}
router.get('/billing/agents/:id/soa.xlsx', auth.requireAccounting, async (req, res) => {
  const agent = store.db.get('SELECT * FROM companies WHERE id = ?', Number(req.params.id));
  const buf = await soaWorkbook(agent, A.agentStatement(agent.id));
  res.set('Content-Disposition', `attachment; filename="SOA_${agent.name.replace(/[^A-Za-z0-9]+/g, '_')}_${new Date().toISOString().slice(0, 10)}.xlsx"`);
  res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(Buffer.from(buf));
});
router.post('/billing/agents/:id/send-soa', auth.requireAccounting, async (req, res) => {
  const agent = store.db.get('SELECT * FROM companies WHERE id = ?', Number(req.params.id));
  const soa = A.agentStatement(agent.id);
  const to = (agent.billing_emails || agent.emails || '').split(/[,;\s]+/).filter((e) => /.+@.+\..+/.test(e));
  if (!to.length) { flash(req, 'err', 'No email for this agent'); return res.redirect(`/billing/agents/${agent.id}`); }
  const fs = require('node:fs'); const path = require('node:path'); const config = require('../config');
  const file = path.join(config.uploadDir, 'generated', `SOA_${agent.id}_${Date.now()}.xlsx`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(await soaWorkbook(agent, soa)));
  const d = store.db.run(`INSERT INTO documents (doc_type, filename, stored_path, mime, size, source) VALUES ('SOA', ?, ?, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ?, 'generated')`,
    `SOA_GLOBALBRIDGE_${new Date().toISOString().slice(0, 10)}.xlsx`, file, fs.statSync(file).size);
  const doc = store.db.get('SELECT * FROM documents WHERE id = ?', Number(d.lastInsertRowid));
  const fmt = (v) => v.toLocaleString('en-US', { minimumFractionDigits: 2 });
  await notify.queueEmail({
    kind: 'SOA', to, subject: `[GLOBALBRIDGE/NSC] SOA ${new Date().toISOString().slice(0, 10)}`,
    html: `<p>Dear ${esc(agent.name)},</p><p>SOA 전달 드립니다. Open items attached (${soa.items.length}).</p>
      <p>Due to GlobalBridge: <b>USD ${fmt(soa.dueToUs)}</b><br>Due to ${esc(agent.name)}: <b>USD ${fmt(soa.dueToAgent)}</b><br>Net: <b>USD ${fmt(Math.abs(soa.net))} ${soa.net >= 0 ? 'due to GlobalBridge' : `due to ${esc(agent.name)}`}</b></p>`,
    documents: [doc],
  });
  flash(req, 'ok', `SOA emailed to ${to.join(', ')}`);
  res.redirect(`/billing/agents/${agent.id}`);
});

module.exports = router;
