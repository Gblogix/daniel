/**
 * Vendor invoices (CFS, warehouse, trucker, broker, carrier, agent): upload on the file, from Billing, or by email →
 * read the invoice (no., date, terms, lines, total) → match the vendor and the file → accounting reviews the
 * pre-filled bill next to the PDF and books it as A/P. Nothing is booked without that confirmation.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('./config');
const store = require('./db');
const S = require('./shipments');
const A = require('./accounting');
const { parseVendorInvoice } = require('./extract/vendorInvoice');

const round = (v) => Math.round(v * 100) / 100;

/** Files that the invoice's references point to (container, MBL, HBL, sub B/L, agent ref, our file no.). */
function matchShipments(refs, db = store.db) {
  const keys = [...new Set([...(refs.containers || []), ...(refs.tokens || [])].map((t) => String(t).toUpperCase().replace(/\s/g, '')))].filter(Boolean);
  if (!keys.length) return [];
  const ph = keys.map(() => '?').join(',');
  return db.all(`SELECT DISTINCT s.id FROM shipments s LEFT JOIN containers k ON k.shipment_id = s.id
    WHERE s.mbl_no IN (${ph}) OR s.hbl_no IN (${ph}) OR s.sub_bl_no IN (${ph}) OR s.agent_ref IN (${ph}) OR s.ref_no IN (${ph}) OR k.container_no IN (${ph})
    ORDER BY s.id DESC LIMIT 5`, ...Array(6).fill(keys).flat()).map((r) => r.id);
}

async function extract({ buffer, filename, mime, db = store.db }) {
  const { readDocument } = require('./extract/text');
  const { segments } = await readDocument(buffer, filename, mime);
  const text = segments.map((s) => s.text).join('\n');
  const companies = db.all('SELECT id, name, short_name, emails, billing_emails, type FROM companies');
  const own = require('./company').get().name;
  const r = parseVendorInvoice(text, { companies, ownName: own });
  r.source = 'rules';
  r.ocr = segments.some((s) => s.ocr);
  if (config.ai.enabled) {
    try {
      const ai = await require('./extract/ai').extractVendorInvoiceAI({ buffer, filename, mime, text });
      if (ai) {
        r.source = 'ai';
        r.number = ai.invoice_no || r.number;
        r.invoice_date = ai.invoice_date || r.invoice_date;
        r.due_date = ai.due_date || r.due_date;
        r.terms_days = ai.terms_days ?? r.terms_days;
        r.total = ai.total ?? r.total;
        r.currency = ai.currency || r.currency;
        if (ai.lines?.length) r.lines = ai.lines.map((l) => ({ description: l.description.toUpperCase(), qty: l.quantity, rate: l.rate, amount: round(l.amount) }));
        r.refs.tokens = [...new Set([...r.refs.tokens, ...ai.container_nos, ...ai.bl_nos, ...ai.other_refs])];
        if (!r.vendor && ai.vendor_name) r.vendor = require('./extract/vendorInvoice').matchVendor(ai.vendor_name, companies, own);
        r.vendor_name_read = ai.vendor_name;
        r.warnings = r.warnings.filter((w) => !/not found|not recognised/.test(w) || (/number/.test(w) && !r.number) || (/date/.test(w) && !r.invoice_date) || (/Vendor/.test(w) && !r.vendor));
      }
    } catch (e) { r.warnings.push(`AI reading unavailable: ${e.message}`); }
  }
  r.shipments = matchShipments(r.refs, db);
  // Vendor not on Parties yet: take name / address / email from the letterhead so it can be added when booking.
  if (!r.vendor) {
    const Party = require('./extract/party');
    const lh = Party.readParties(text, { ...Party.own(), db }).find((p) => p.role === 'letterhead');
    const name = r.vendor_name_read || lh?.name;
    if (name) {
      const same = lh && Party.norm(lh.name) === Party.norm(name);
      r.vendor_new = { name, address: same ? lh.address : null, email: same ? lh.email : null, phone: same ? lh.phone : null };
      r.vendor_name_read = name;
      r.warnings = r.warnings.map((w) => (/^Vendor not recognised/.test(w) ? `New vendor ${name} — added to Parties when you book (check the details)` : w));
      const hit = Party.findParty(name, { db });
      if (hit) { r.vendor = { id: hit.id, name: hit.name }; delete r.vendor_new; }
    }
  }
  if (r.vendor && r.number) {
    const dup = db.get("SELECT id, number FROM invoices WHERE kind = 'AP' AND company_id = ? AND UPPER(number) = UPPER(?) AND status <> 'VOID'", r.vendor.id, r.number);
    if (dup) { r.duplicate = dup.id; r.warnings.unshift(`Already booked: ${dup.number} — this may be a duplicate`); }
  }
  return r;
}

/**
 * Store a received vendor invoice and read it. Returns the document id (doc_type VINV, waiting to be booked).
 * shipmentId / companyId given by the uploader win over the automatic match.
 */
async function receive({ buffer, filename, mime, shipmentId = null, companyId = null, userId = null, via = 'upload', ex = null, sender = null, db = store.db }) {
  const dir = path.join(config.uploadDir, 'vendor');
  fs.mkdirSync(dir, { recursive: true });
  const stored = path.join(dir, `${crypto.randomBytes(12).toString('hex')}${path.extname(filename).toLowerCase()}`);
  fs.writeFileSync(stored, buffer);
  let r;
  try { r = ex || await extract({ buffer, filename, mime, db }); } catch (e) { r = { warnings: [`Could not read the document: ${e.message}`], lines: [], refs: {}, shipments: [] }; }
  if (r.vendor_new && sender && !r.vendor_new.email) r.vendor_new.email = String(sender).toLowerCase();
  if (companyId) r.vendor = { id: Number(companyId), name: db.get('SELECT name FROM companies WHERE id = ?', Number(companyId))?.name };
  const sid = shipmentId ? Number(shipmentId) : r.shipments?.length === 1 ? r.shipments[0] : null;
  if (!shipmentId && r.shipments?.length > 1) r.warnings.push(`References match ${r.shipments.length} files — pick the right one`);
  if (!sid) r.warnings.push('File not matched — pick it before booking');
  r.via = via;
  const id = Number(db.run(`INSERT INTO documents (shipment_id, doc_type, filename, stored_path, mime, size, source, extracted_json, uploaded_by, company_id)
    VALUES (?, 'VINV', ?, ?, ?, ?, ?, ?, ?, ?)`, sid, filename, stored, mime || null, buffer.length, via === 'email' ? 'email' : 'upload', JSON.stringify(r), userId, r.vendor?.id || null).lastInsertRowid);
  if (sid) {
    S.addEvent(sid, 'VENDOR_INVOICE', `Vendor invoice received${r.vendor ? ` from ${r.vendor.name}` : ''}${r.number ? ` #${r.number}` : ''}${r.total != null ? ` — USD ${r.total.toFixed(2)}` : ''} (to book)`,
      { db, userId, customerVisible: false });
  }
  return id;
}

function get(docId, db = store.db) {
  const d = db.get("SELECT * FROM documents WHERE id = ? AND doc_type = 'VINV'", docId);
  if (!d) return null;
  try { d.ex = JSON.parse(d.extracted_json || '{}'); } catch { d.ex = {}; }
  return d;
}

/** Waiting to be booked (newest first). */
function pending(db = store.db) {
  return db.all(`SELECT d.*, c.name AS vendor_name, s.ref_no, s.shipper_name, s.hbl_no, s.mbl_no, s.mode, s.title,
      (SELECT k.container_no FROM containers k WHERE k.shipment_id = s.id ORDER BY k.id LIMIT 1) AS first_ctn,
      (SELECT COUNT(*) FROM containers k WHERE k.shipment_id = s.id) AS ctn_count
    FROM documents d LEFT JOIN companies c ON c.id = d.company_id LEFT JOIN shipments s ON s.id = d.shipment_id
    WHERE d.doc_type = 'VINV' AND d.invoice_id IS NULL ORDER BY d.id DESC`).map((d) => {
    try { d.ex = JSON.parse(d.extracted_json || '{}'); } catch { d.ex = {}; }
    return d;
  });
}

/** Book the reviewed bill as A/P on the file and link the vendor's PDF to it. */
function book(docId, data, { db = store.db, userId = null } = {}) {
  const d = get(docId, db);
  if (!d) throw Object.assign(new Error('Vendor invoice not found'), { status: 404, expose: true });
  if (d.invoice_id) return d.invoice_id;
  return db.tx(() => {
    const id = A.saveInvoice({ ...data, kind: 'AP' }, { db, userId });
    db.run('UPDATE invoices SET document_id = ? WHERE id = ?', d.id, id);
    db.run('UPDATE documents SET invoice_id = ?, shipment_id = ?, company_id = ? WHERE id = ?', id, data.shipment_id || null, Number(data.company_id) || null, d.id);
    if (data.shipment_id) S.addEvent(Number(data.shipment_id), 'VENDOR_BILL', `Vendor bill ${data.number} booked`, { db, userId, customerVisible: false });
    return id;
  });
}

function discard(docId, db = store.db) {
  db.run("UPDATE documents SET doc_type = 'OTHER' WHERE id = ? AND doc_type = 'VINV' AND invoice_id IS NULL", docId);
}

module.exports = { receive, extract, get, pending, book, discard, matchShipments };
