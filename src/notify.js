/**
 * Email outbox + automation rules (the red arrows on the whiteboard).
 * Every email is stored in the `emails` table and sent through Outlook (Microsoft Graph) or SMTP;
 * with neither configured it is marked LOGGED so staff can review it in the Outbox.
 */
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
const store = require('./db');
const S = require('./shipments');
const { GENERATORS, DOC_TITLES, esc, fileName } = require('./docs/templates');

let transporter;
function getTransport() {
  if (!config.smtp.host) return null;
  if (!transporter) {
    const nodemailer = require('nodemailer');
    transporter = nodemailer.createTransport({
      host: config.smtp.host, port: config.smtp.port, secure: config.smtp.secure,
      auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
    });
  }
  return transporter;
}

/**
 * Subject in the style used in the office inbox: tokens joined by " // ".
 *   ocean: [A/N] CMDUSHZ8105615 // HBL TWS26050088 // EWLU7068201 // 40HC x 1 // ETA 5/31
 *   air:   [A/N] 921-63150570 // 46 CTN // ETA 9/14
 */
function subjectLine(s, kind) {
  const md = (d) => (d ? `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}` : 'TBA');
  const parts = [s.mbl_no || s.ref_no];
  if (s.hbl_no && !s.direct_shipment) parts.push(`${s.mode === 'AIR' ? 'HAWB' : 'HBL'} ${s.hbl_no}`);
  const ctns = s.containers || [];
  if (ctns.length) {
    parts.push(ctns.map((c) => c.container_no).join(', '));
    const sizes = {};
    for (const c of ctns) if (c.size_type) sizes[c.size_type] = (sizes[c.size_type] || 0) + 1;
    const sz = Object.entries(sizes).map(([k, v]) => `${k} x ${v}`).join(', ');
    if (sz) parts.push(sz);
  } else if (s.packages) {
    parts.push(`${s.packages} ${s.package_unit === 'PLTS' ? 'PLT' : s.package_unit === 'CTNS' || !s.package_unit ? 'CTN' : s.package_unit}`);
  }
  parts.push(s.ata ? `ATA ${md(s.ata)}` : `ETA ${md(s.eta)}`);
  if (s.last_free_day && ['D/O', 'A/N'].includes(kind)) parts.push(`LFD ${md(s.last_free_day)}`);
  return `[${kind}] ${parts.join(' // ')}`;
}

function recipients(companyId, db = store.db) {
  if (!companyId) return [];
  const c = db.get('SELECT emails FROM companies WHERE id = ?', companyId);
  return (c?.emails || '').split(/[,;\s]+/).map((e) => e.trim()).filter((e) => /.+@.+\..+/.test(e));
}

function generatedDir() {
  const dir = path.join(config.uploadDir, 'generated');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Render A/N, D/O or ATME for a shipment (PDF when Chromium is available), store it as a document and return the row. */
async function generateDocument(shipmentId, type, { db = store.db, userId = null } = {}) {
  const s = S.find(shipmentId, null, { db });
  if (!s) throw new Error('Shipment not found');
  // Re-issuing a document marks it as a revision (…_Rev, …_Rev2), as brokers expect.
  const revision = db.get("SELECT COUNT(*) AS n FROM documents WHERE shipment_id = ? AND doc_type = ? AND source = 'generated'", s.id, type).n;
  const html = GENERATORS[type](s, { revision });
  const pdf = await require('./docs/pdf').htmlToPdf(html);
  const base = fileName(type, s, revision);
  const stored = path.join(generatedDir(), `${s.ref_no}_${base}_${Date.now()}.${pdf ? 'pdf' : 'html'}`);
  fs.writeFileSync(stored, pdf || html);
  const visible = type === 'AN' ? 1 : 0;
  const res = db.run(`INSERT INTO documents (shipment_id, doc_type, filename, stored_path, mime, size, source, customer_visible, uploaded_by)
    VALUES (?, ?, ?, ?, ?, ?, 'generated', ?, ?)`, s.id, type, `${base}.${pdf ? 'pdf' : 'html'}`, stored,
  pdf ? 'application/pdf' : 'text/html', pdf ? pdf.length : html.length, visible, userId);
  return db.get('SELECT * FROM documents WHERE id = ?', Number(res.lastInsertRowid));
}

function latestDocs(shipmentId, types, db = store.db) {
  const out = [];
  for (const t of types) {
    const d = db.get('SELECT * FROM documents WHERE shipment_id = ? AND doc_type = ? ORDER BY id DESC LIMIT 1', shipmentId, t);
    if (d) out.push(d);
  }
  return out;
}

async function queueEmail({ shipmentId = null, kind, to, cc = [], subject, html, documents = [] }, { db = store.db } = {}) {
  const attachments = documents.map((d) => ({ id: d.id, filename: d.filename, path: d.stored_path }));
  const res = db.run(`INSERT INTO emails (shipment_id, kind, to_addr, cc_addr, subject, body_html, attachments_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)`, shipmentId, kind, to.join(', '), cc.join(', '), subject, html, JSON.stringify(attachments));
  const id = Number(res.lastInsertRowid);
  await deliver(id, { db });
  return id;
}

async function deliver(emailId, { db = store.db } = {}) {
  const e = db.get('SELECT * FROM emails WHERE id = ?', emailId);
  if (config.mailTransport === 'log') {
    db.run("UPDATE emails SET status = 'LOGGED', error = 'Email sending not configured (Outlook / SMTP)' WHERE id = ?", emailId);
    return;
  }
  try {
    const files = JSON.parse(e.attachments_json || '[]')
      .filter((a) => a.path && fs.existsSync(a.path)).map((a) => ({ filename: a.filename, path: a.path }));
    const to = e.to_addr.split(/,\s*/).filter(Boolean);
    const cc = (e.cc_addr || '').split(/,\s*/).filter(Boolean);
    if (config.mailTransport === 'outlook') {
      await require('./graph').sendMail({
        to, cc, subject: e.subject, html: e.body_html,
        attachments: files.map((f) => ({ filename: f.filename, content: fs.readFileSync(f.path) })),
      });
    } else {
      await getTransport().sendMail({ from: config.smtp.from, to, cc: cc.length ? cc : undefined, subject: e.subject, html: e.body_html, attachments: files });
    }
    db.run("UPDATE emails SET status = 'SENT', error = NULL, sent_at = datetime('now') WHERE id = ?", emailId);
  } catch (err) {
    db.run("UPDATE emails SET status = 'FAILED', error = ? WHERE id = ?", String(err.message).slice(0, 500), emailId);
  }
}

// ---------- email bodies ----------

function progressHtml(s) {
  const tr = S.tracking(s);
  const cells = tr.days.map((d) => {
    const bg = d.state === 'done' ? '#1f6feb' : d.state === 'current' ? '#f59e0b' : '#e5e7eb';
    return `<td style="background:${bg};height:14px;border:1px solid #fff" title="${d.date}"></td>`;
  }).join('');
  return tr.days.length
    ? `<table style="width:100%;border-collapse:collapse;table-layout:fixed;margin:8px 0"><tr>${cells}</tr></table>
       <div style="font-size:12px;color:#555">ETD ${esc(s.etd)} → ETA ${esc(s.eta)} · ${tr.percent}% · ${tr.daysLeft ?? '-'} day(s) to arrival</div>`
    : '';
}

function summaryHtml(s, intro) {
  const items = s.items.slice(0, 15).map((i) => `<tr><td>${esc(i.po_no)}</td><td>${esc(i.description)}</td>
    <td style="text-align:right">${esc(i.quantity ?? '')} ${esc(i.unit ?? '')}</td><td style="text-align:right">${esc(i.packages ?? '')}</td></tr>`).join('');
  const td = 'style="padding:4px 8px;border-bottom:1px solid #eee"';
  return `<div style="font:14px/1.5 Arial,sans-serif;color:#111;max-width:680px">
<p>${intro}</p>
<h3 style="margin:16px 0 4px;color:#0b3d91">${esc(s.ref_no)} · ${esc(S.MODES[s.mode]?.label || s.mode)} · ${esc(S.statusLabel(s.status))}</h3>
${progressHtml(s)}
<table style="border-collapse:collapse;margin-top:8px">
<tr><td ${td}><b>Shipper</b></td><td ${td}>${esc(s.shipper_name)}</td></tr>
<tr><td ${td}><b>MBL / HBL</b></td><td ${td}>${esc(s.mbl_no)} / ${esc(s.hbl_no)}</td></tr>
<tr><td ${td}><b>Container</b></td><td ${td}>${esc(s.containers.map((c) => `${c.container_no}${c.size_type ? ` (${c.size_type})` : ''}`).join(', '))}</td></tr>
<tr><td ${td}><b>${s.mode === 'AIR' ? 'Flight' : 'Vessel'}</b></td><td ${td}>${esc(s.mode === 'AIR' ? s.flight_no : `${s.vessel || ''} ${s.voyage || ''}`)}</td></tr>
<tr><td ${td}><b>ETD / ETA</b></td><td ${td}>${esc(s.etd)} / ${esc(s.eta)}</td></tr>
<tr><td ${td}><b>Packages / Weight / CBM</b></td><td ${td}>${esc(s.packages ?? '')} ${esc(s.package_unit ?? '')} / ${esc(s.weight_kg ?? '')} KG / ${esc(s.cbm ?? '')} CBM</td></tr>
<tr><td ${td}><b>Delivery to</b></td><td ${td}>${esc(s.delivery_company_name || '')} ${esc(s.delivery_address || '')}</td></tr>
<tr><td ${td}><b>Delivery date</b></td><td ${td}>${esc(s.delivery_date || 'TBA')} ${esc(s.delivery_time || '')}</td></tr>
</table>
${items ? `<h4 style="margin:16px 0 4px">Packing list</h4><table style="border-collapse:collapse;font-size:13px">
<tr><th ${td}>PO</th><th ${td}>Description</th><th ${td}>Qty</th><th ${td}>Pkgs</th></tr>${items}</table>` : ''}
<p style="margin-top:16px"><a href="${config.baseUrl}/shipments/${s.id}" style="background:#0b3d91;color:#fff;padding:8px 14px;border-radius:6px;text-decoration:none">View live tracking</a></p>
<p style="color:#666;font-size:12px">${esc(config.company.name)} · ${esc(config.company.email)}</p></div>`;
}

// ---------- automations ----------

async function sendBrokerPacket(shipmentId, { db = store.db, userId = null } = {}) {
  const s = S.find(shipmentId, null, { db });
  const to = recipients(s.broker_id, db);
  if (!to.length) { S.addEvent(s.id, 'NOTICE_SKIPPED', 'Broker packet not sent: no customs broker email on file', { db, customerVisible: false }); return null; }
  const an = await generateDocument(s.id, 'AN', { db, userId });
  const extra = s.mode === 'AIR' ? [await generateDocument(s.id, 'ATME', { db, userId })] : [];
  const docs = [an, ...extra, ...latestDocs(s.id, ['HBL', 'MBL', 'PL', 'CI', 'ISF'], db)];
  const id = await queueEmail({
    shipmentId: s.id, kind: 'BROKER_PACKET', to, subject: subjectLine(s, 'A/N'),
    html: summaryHtml(s, `Dear ${esc(s.broker_name)},<br>Please find attached the arrival notice${extra.length ? ', authority to make entry' : ''} and shipping documents (${docs.map((d) => d.doc_type).join(', ')}) for customs clearance.`),
    documents: docs,
  }, { db });
  db.run("UPDATE shipments SET an_sent_at = datetime('now') WHERE id = ?", s.id);
  S.addEvent(s.id, 'AN_SENT', `Arrival notice & documents sent to customs broker (${s.broker_name})`, { db, userId });
  return id;
}

async function sendCustomerUpdate(shipmentId, reason, { db = store.db, userId = null, attachAN = false } = {}) {
  const s = S.find(shipmentId, null, { db });
  const to = recipients(s.customer_id, db);
  if (!to.length) { S.addEvent(s.id, 'NOTICE_SKIPPED', 'Customer update not sent: no customer email on file', { db, customerVisible: false }); return null; }
  const docs = attachAN ? latestDocs(s.id, ['AN'], db) : [];
  return queueEmail({
    shipmentId: s.id, kind: 'CUSTOMER_UPDATE', to, subject: subjectLine(s, reason),
    html: summaryHtml(s, `Dear ${esc(s.customer_name)},<br>${esc(reason)} for your shipment ${esc(s.ref_no)}.`), documents: docs,
  }, { db });
}

async function sendDeliveryOrder(shipmentId, { db = store.db, userId = null } = {}) {
  const s = S.find(shipmentId, null, { db });
  const to = recipients(s.trucker_id, db);
  if (!to.length) { S.addEvent(s.id, 'NOTICE_SKIPPED', 'D/O not sent: no trucker email on file', { db, customerVisible: false }); return null; }
  const d = await generateDocument(s.id, 'DO', { db, userId });
  // Air pickups need the ATME with the D/O (terminal / CES release).
  const atme = s.mode === 'AIR' ? (latestDocs(s.id, ['ATME'], db)[0] || await generateDocument(s.id, 'ATME', { db, userId })) : null;
  const id = await queueEmail({
    shipmentId: s.id, kind: 'DELIVERY_ORDER', to, subject: subjectLine(s, 'D/O'),
    html: summaryHtml(s, `Dear ${esc(s.trucker_name)},<br>Please find attached the delivery order. Pick up at <b>${esc(s.cfs_location || s.pod || '')}</b> and deliver to <b>${esc(s.delivery_address || '')}</b>.`),
    documents: atme ? [d, atme] : [d],
  }, { db });
  db.run("UPDATE shipments SET do_sent_at = datetime('now') WHERE id = ?", s.id);
  S.addEvent(s.id, 'DO_SENT', `Delivery order sent to trucker (${s.trucker_name})`, { db, userId });
  return id;
}

/** Called after documents from the agent portal were applied to a shipment. */
async function onDocumentsApplied(shipmentId, { db = store.db, userId = null } = {}) {
  S.addEvent(shipmentId, 'DOCS_RECEIVED', 'Shipping documents received from origin agent', { db, userId });
  if (db.setting('auto_send_docs_received') !== '1') return;
  await sendBrokerPacket(shipmentId, { db, userId });
  await sendCustomerUpdate(shipmentId, 'Shipment details', { db, userId, attachAN: true });
}

/** Called after a staff edit with the list of changed fields. */
async function onShipmentChanged(shipmentId, changes, { db = store.db, userId = null } = {}) {
  const f = Object.fromEntries(changes.map((c) => [c.field, c]));
  const notify = db.setting('auto_notify_status') === '1';
  const reasons = [];
  if (f.status) {
    S.addEvent(shipmentId, 'STATUS', `Status: ${S.statusLabel(f.status.to)}`, { db, userId });
    reasons.push(S.statusLabel(f.status.to));
  }
  if (f.eta && f.eta.from) {
    S.addEvent(shipmentId, 'ETA_CHANGED', `ETA changed ${f.eta.from} → ${f.eta.to}`, { db, userId });
    reasons.push('ETA update');
  }
  if (f.delivery_date || f.delivery_time) {
    const s = S.find(shipmentId, null, { db });
    S.addEvent(shipmentId, 'DELIVERY_SCHEDULED', `Delivery scheduled ${s.delivery_date || ''} ${s.delivery_time || ''}`.trim(), { db, userId });
    reasons.push('Delivery schedule');
  }
  if (f.customs_status) {
    S.addEvent(shipmentId, 'CUSTOMS', `Customs: ${f.customs_status.to}`, { db, userId });
    if (f.customs_status.to === 'EXAM') reasons.push('Customs exam');
    if (f.customs_status.to === 'RELEASED') {
      reasons.push('Customs released');
      if (db.setting('auto_send_do') === '1') await sendDeliveryOrder(shipmentId, { db, userId });
    }
  }
  if (notify && reasons.length) await sendCustomerUpdate(shipmentId, reasons.join(' · '), { db, userId });
}

module.exports = {
  subjectLine, recipients, generateDocument, queueEmail, deliver, summaryHtml,
  sendBrokerPacket, sendCustomerUpdate, sendDeliveryOrder, onDocumentsApplied, onShipmentChanged,
};
