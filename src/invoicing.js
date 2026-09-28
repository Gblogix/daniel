/**
 * Issue and email invoices / debit & credit notes to the file's parties.
 * Only reviewed items are sent: AR invoices go out batched per customer ("Invoice - <Customer>"), each D/N or C/N
 * to its agent. Statements of account (any party) are rendered here too.
 */
const fs = require('node:fs');
const path = require('node:path');
const store = require('./db');
const S = require('./shipments');
const A = require('./accounting');
const notify = require('./notify');
const company = require('./company');
const config = require('./config');
const { INVOICE_GENERATORS, invoiceFileName, statementOfAccount, esc } = require('./docs/templates');

const money = (v) => Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const emailsOf = (c) => String(c?.billing_emails || c?.company_emails || c?.emails || '').split(/[,;\s]+/).filter((e) => /.+@.+\..+/.test(e));

function renderInvoice(inv, userId) {
  const s = inv.shipment_id ? S.find(inv.shipment_id, null) : null;
  const user = userId ? store.db.get('SELECT name FROM users WHERE id = ?', userId) : null;
  const prepared = inv.prepared_by ? store.db.get('SELECT name FROM users WHERE id = ?', inv.prepared_by) : null;
  return INVOICE_GENERATORS[inv.kind](inv, { company: company.get(), shipment: s, preparedBy: prepared?.name || user?.name || '' });
}

/** Issue the PDF (AR_INV12214_Unlockt.pdf / DC_DCN11664-NSC.pdf) and link it to the invoice. Reuses the current PDF unless `force`. */
async function issue(inv, userId, { force = false } = {}) {
  if (!force && inv.document_id) {
    const d = store.db.get('SELECT * FROM documents WHERE id = ?', inv.document_id);
    if (d) return d;
  }
  const d = await notify.storeGenerated(store.db, {
    shipmentId: inv.shipment_id, type: inv.kind, base: invoiceFileName(inv), html: renderInvoice(inv, userId), visible: false, userId, refNo: inv.number,
  });
  store.db.run('UPDATE invoices SET document_id = ? WHERE id = ?', d.id, inv.id);
  return d;
}

/**
 * Email the given invoices to their parties. Returns { sent: [{to, numbers}], skipped: [{number, reason}] }.
 * `requireReview` (default) skips items not marked reviewed.
 */
async function send(ids, { userId = null, requireReview = true } = {}) {
  const out = { sent: [], skipped: [] };
  const invs = ids.map((id) => A.getInvoice(Number(id))).filter(Boolean);
  const ok = [];
  for (const inv of invs) {
    if (inv.kind === 'AP') out.skipped.push({ number: inv.number, reason: 'vendor bill (not sent)' });
    else if (inv.status === 'VOID') out.skipped.push({ number: inv.number, reason: 'void' });
    else if (requireReview && !inv.reviewed_at) out.skipped.push({ number: inv.number, reason: 'not reviewed' });
    else if (!emailsOf(inv).length) out.skipped.push({ number: inv.number, reason: `no billing email for ${inv.company_name}` });
    else ok.push(inv);
  }
  // AR: one email per customer, as the accounting team sends them.
  const byCustomer = new Map();
  for (const inv of ok.filter((i) => i.kind === 'AR')) {
    if (!byCustomer.has(inv.company_id)) byCustomer.set(inv.company_id, []);
    byCustomer.get(inv.company_id).push(inv);
  }
  for (const list of byCustomer.values()) {
    const docs = []; const lines = [];
    for (const inv of list) {
      docs.push(await issue(inv, userId));
      const s = inv.shipment_id ? S.find(inv.shipment_id, null) : null;
      const refs = [s?.ci_invoice_no && `CI# ${s.ci_invoice_no}`, s?.hbl_no && `HBL# ${s.hbl_no}`, s?.containers?.length && `CTN# ${s.containers.map((c) => c.container_no).join(', ')}`].filter(Boolean);
      lines.push(`<li><b>${esc(inv.number)}</b> : ${esc(inv.memo || s?.commodity || '')}${refs.length ? ` // ${esc(refs.join(' // '))}` : ''} — USD ${money(inv.total)}, due ${esc(inv.due_date)}</li>`);
    }
    const to = emailsOf(list[0]);
    await notify.queueEmail({
      shipmentId: list.length === 1 ? list[0].shipment_id : null, kind: 'AR_INVOICE', to, subject: `Invoice - ${list[0].company_name}`,
      html: `<p>Hello,</p><p>인보이스 전달 드립니다. / Please find attached the invoice(s) below.</p><ul>${lines.join('')}</ul>
        <p>Total USD ${money(list.reduce((a, i) => a + i.balance, 0))}</p>`,
      documents: docs,
    });
    for (const inv of list) store.db.run("UPDATE invoices SET sent_at = datetime('now') WHERE id = ?", inv.id);
    out.sent.push({ to: to.join(', '), numbers: list.map((i) => i.number) });
  }
  // D/N and C/N: one email each to the agent.
  for (const inv of ok.filter((i) => i.kind === 'DN')) {
    const d = await issue(inv, userId);
    const to = emailsOf(inv);
    const refs = [...new Set([inv.agent_ref, inv.hbl_no, inv.mbl_no].filter(Boolean))].join(' // ');
    const cn = inv.total < 0;
    await notify.queueEmail({
      shipmentId: inv.shipment_id, kind: 'DEBIT_NOTE', to,
      subject: `[GLOBALBRIDGE] ${cn ? 'C/N' : 'D/N'} ${inv.number}${refs ? ` // ${refs}` : ''}`,
      html: `<p>Dear ${esc(inv.company_name)},</p><p>동 건 ${cn ? 'C/N' : 'D/N'} 전달 드립니다. / Please find attached our ${cn ? 'credit' : 'debit'} note <b>${esc(inv.number)}</b>
        (USD ${money(Math.abs(inv.total))}${cn ? ', due to you' : ''}).</p>`,
      documents: [d],
    });
    store.db.run("UPDATE invoices SET sent_at = datetime('now') WHERE id = ?", inv.id);
    out.sent.push({ to: to.join(', '), numbers: [inv.number] });
  }
  return out;
}

function summarize(r) {
  const sent = r.sent.map((x) => `${x.numbers.join(', ')} → ${x.to}`).join('; ');
  const skipped = r.skipped.map((x) => `${x.number} (${x.reason})`).join(', ');
  return [sent && `Sent: ${sent}`, skipped && `Not sent: ${skipped}`].filter(Boolean).join(' · ') || 'Nothing to send';
}

// ---------- statements of account ----------
function statementHtml(party, st) {
  return statementOfAccount({ company: company.get(), party, st });
}

const BASIS_LABEL = { invoice: 'Invoice date', eta: 'ETA', due: 'Due date' };

async function statementWorkbook(party, st) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Statement');
  const co = company.get();
  ws.addRow([`${co.name} — Statement of Account`]).font = { bold: true, size: 13 };
  ws.addRow([party.name, '', '', '', '', `As of ${st.asOf}`]);
  ws.addRow([`By ${BASIS_LABEL[st.basis] || 'Invoice date'}${st.from || st.to ? `: ${st.from || '…'} – ${st.to || '…'}` : ''}${st.status === 'open' ? ' · open items' : ' · all items'}`]);
  ws.addRow([]);
  const head = ws.addRow(['Date', 'Doc no.', 'Type', 'File (Shipper · Container)', 'Our file no.', 'HBL / HAWB', 'MBL / MAWB', 'ETA', 'Due', 'Debit (+)', 'Credit (−)', 'Paid', 'Open', 'Balance']);
  head.font = { bold: true };
  for (const i of st.items) {
    ws.addRow([i.basis_date, i.number, i.type, i.shipment_id ? S.fileName(i) : '', i.ref_no || '', i.hbl_no || '', i.mbl_no || '', i.eta || '', i.due_date || '',
      i.debit || null, i.credit || null, i.paid_amount || null, i.open, i.running]);
  }
  ws.addRow([]);
  ws.addRow(['', '', '', '', '', '', '', '', 'Total', st.totals.debit, st.totals.credit, st.totals.paid, st.totals.open]).font = { bold: true };
  ws.addRow(['', '', '', '', '', '', '', '', st.totals.open >= 0 ? `Balance due to ${co.name}` : `Balance due to ${party.name}`, '', '', '', Math.abs(st.totals.open)]).font = { bold: true };
  ws.columns.forEach((c, idx) => { c.width = [11, 13, 12, 34, 12, 18, 18, 11, 11, 13, 13, 12, 13, 13][idx] || 12; });
  [10, 11, 12, 13, 14].forEach((c) => { ws.getColumn(c).numFmt = '#,##0.00;[Red]-#,##0.00'; });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const safe = (v) => String(v || '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '');

async function sendStatement(party, st, { userId = null, to = null } = {}) {
  const recipients = to?.length ? to : emailsOf(party);
  if (!recipients.length) throw Object.assign(new Error(`No billing email for ${party.name} — add it on the Parties page`), { status: 400, expose: true });
  const base = `SOA_${safe(party.short_name || party.name)}_${st.asOf}`;
  const pdfDoc = await notify.storeGenerated(store.db, { shipmentId: null, type: 'SOA', base, html: statementHtml(party, st), visible: false, userId, refNo: 'SOA' });
  const file = path.join(config.uploadDir, 'generated', `${base}_${Date.now()}.xlsx`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const buf = await statementWorkbook(party, st);
  fs.writeFileSync(file, buf);
  const x = store.db.run(`INSERT INTO documents (doc_type, filename, stored_path, mime, size, source, uploaded_by) VALUES ('SOA', ?, ?, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ?, 'generated', ?)`,
    `${base}.xlsx`, file, buf.length, userId);
  const xlsx = store.db.get('SELECT * FROM documents WHERE id = ?', Number(x.lastInsertRowid));
  const co = company.get();
  const t = st.totals;
  await notify.queueEmail({
    kind: 'SOA', to: recipients, subject: `[GLOBALBRIDGE] Statement of Account — ${party.name} — ${st.asOf}`,
    html: `<p>Dear ${esc(party.name)},</p><p>SOA 전달 드립니다. / Please find attached our statement of account (${st.items.length} item${st.items.length === 1 ? '' : 's'},
      by ${esc((BASIS_LABEL[st.basis] || 'invoice date').toLowerCase())}${st.from || st.to ? `, ${esc(st.from || '…')} – ${esc(st.to || '…')}` : ''}).</p>
      <p>Debit (due to ${esc(co.name)}): <b>USD ${money(t.debit)}</b><br>Credit (due to ${esc(party.name)}): <b>USD ${money(t.credit)}</b><br>
      Paid: USD ${money(t.paid)}<br><b>Balance: USD ${money(Math.abs(t.open))} due to ${esc(t.open >= 0 ? co.name : party.name)}</b></p>
      <p>Please let us know if anything does not match your records.</p>`,
    documents: [pdfDoc, xlsx],
  });
  return recipients;
}

module.exports = { renderInvoice, issue, send, summarize, statementHtml, statementWorkbook, sendStatement, emailsOf, BASIS_LABEL };
