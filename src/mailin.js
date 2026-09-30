/**
 * Outlook → Document intake. Agents who keep emailing documents (instead of using the portal) are handled too:
 * new messages with PDF / Excel / image attachments in the shared mailbox become intakes for staff review.
 * Only senders whose email domain belongs to a company of type "agent" are imported as intakes; invoices emailed by
 * vendors (CFS, warehouse, trucker, broker, carrier) go to the vendor invoice queue for accounting to book.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('./config');
const store = require('./db');

const ALLOWED = /\.(pdf|xlsx|csv|jpe?g|png)$/i;

/** Vendors who email invoices (CFS, warehouse, trucker, broker, carrier): their attachments go to the vendor invoice queue. */
function vendorForSender(email, db = store.db) {
  const domain = email.split('@')[1];
  if (!domain) return null;
  const rows = db.all("SELECT id, name, emails, billing_emails FROM companies WHERE type IN ('vendor', 'trucker', 'broker', 'delivery') AND (emails IS NOT NULL OR billing_emails IS NOT NULL)");
  return rows.find((c) => `${c.emails || ''},${c.billing_emails || ''}`.toLowerCase().split(/[,;\s]+/).some((e) => e && (e === email.toLowerCase() || e.endsWith(`@${domain.toLowerCase()}`)))) || null;
}

function agentForSender(email, db = store.db) {
  const domain = email.split('@')[1];
  if (!domain) return null;
  const agents = db.all("SELECT id, name, emails FROM companies WHERE type = 'agent' AND emails IS NOT NULL");
  return agents.find((a) => a.emails.toLowerCase().split(/[,;\s]+/).some((e) => e === email || e.endsWith(`@${domain}`))) || null;
}

async function pollOnce({ db = store.db, fetchImpl, now = new Date() } = {}) {
  const { listInboxWithAttachments } = require('./graph');
  const { processUpload } = require('./routes/intake');
  // First run looks back one day; afterwards from the last check (with overlap — duplicates are skipped by id).
  const since = db.setting('mail_intake_since') || new Date(now.getTime() - 86400000).toISOString();
  const messages = await listInboxWithAttachments(since, { fetchImpl });
  let imported = 0;
  for (const m of messages) {
    if (db.get('SELECT 1 FROM mail_imports WHERE message_id = ?', m.id)) continue;
    const agent = agentForSender(m.from, db);
    const files = m.attachments.filter((a) => ALLOWED.test(a.filename));
    const vendor = !agent && files.length ? vendorForSender(m.from, db) : null;
    if (vendor) {
      // Only attachments that read like an invoice (number + amount) are queued; the rest (PODs, photos) are skipped.
      const V = require('./vendorbills');
      let queued = 0;
      for (const a of files.filter((f) => /\.(pdf|jpe?g|png)$/i.test(f.filename))) {
        const ex = await V.extract({ buffer: a.content, filename: a.filename, mime: a.mime || '', db }).catch(() => null);
        if (!ex || !(ex.number || /invoice/i.test(`${a.filename} ${m.subject}`)) || ex.total == null) continue;
        await V.receive({ buffer: a.content, filename: a.filename, mime: a.mime || '', companyId: vendor.id, via: 'email', ex, db });
        queued++;
      }
      db.run('INSERT INTO mail_imports (message_id, sender, subject) VALUES (?, ?, ?)', m.id, m.from, `${m.subject}${queued ? ` [${queued} vendor invoice(s)]` : ''}`);
      if (queued) imported++;
      continue;
    }
    if (!agent || !files.length) {
      db.run('INSERT INTO mail_imports (message_id, sender, subject) VALUES (?, ?, ?)', m.id, m.from, m.subject);
      continue;
    }
    // Agent debit / credit notes go to accounting's queue (read and pre-filled), not to Document intake.
    const V = require('./vendorbills');
    const shipping = [];
    let notes = 0;
    for (const a of files) {
      const maybeNote = /\.(pdf|jpe?g|png)$/i.test(a.filename) && /\b(D\s*[/_-]?\s*N|C\s*[/_-]?\s*N|DEBIT|CREDIT|DCN)\b/i.test(`${a.filename} ${m.subject}`.replace(/_/g, ' '));
      const ex = maybeNote ? await V.extract({ buffer: a.content, filename: a.filename, mime: a.mime || '', db }).catch(() => null) : null;
      if (ex?.doc_kind === 'DN') { await V.receive({ buffer: a.content, filename: a.filename, mime: a.mime || '', companyId: agent.id, via: 'email', ex, db }); notes++; } else shipping.push(a);
    }
    if (!shipping.length) {
      db.run('INSERT INTO mail_imports (message_id, sender, subject) VALUES (?, ?, ?)', m.id, m.from, `${m.subject} [${notes} debit / credit note(s)]`);
      imported++;
      continue;
    }
    const dir = path.join(config.uploadDir, 'intake');
    fs.mkdirSync(dir, { recursive: true });
    const saved = shipping.map((a) => {
      const p = path.join(dir, crypto.randomBytes(16).toString('hex'));
      fs.writeFileSync(p, a.content);
      return { path: p, originalname: a.filename, mimetype: a.mime || '', size: a.content.length, slot: 'OTHER' };
    });
    // The email text itself (subject + body) is read like a document: NSC puts MBL / HBL / CNTR / ETD / ETA tables there.
    if ((m.body || '').trim()) {
      const p = path.join(dir, crypto.randomBytes(16).toString('hex'));
      const text = `${m.subject}\n\n${m.body}`;
      fs.writeFileSync(p, text);
      saved.push({ path: p, originalname: 'email-body.txt', mimetype: 'text/plain', size: Buffer.byteLength(text), slot: 'OTHER' });
    }
    const intakeId = await processUpload(saved, { userId: null, agentId: agent.id, note: `Email from ${m.from}: ${m.subject}`, db });
    db.run('INSERT INTO mail_imports (message_id, intake_id, sender, subject) VALUES (?, ?, ?, ?)', m.id, intakeId, m.from, m.subject);
    imported++;
  }
  const last = messages.length ? messages[messages.length - 1].receivedAt : null;
  if (last) db.setSetting('mail_intake_since', last);
  return { checked: messages.length, imported };
}

function start() {
  if (!config.graph.enabled || !config.graph.intake) return null;
  const run = () => pollOnce().catch((e) => console.error('Outlook intake:', e.message));
  run();
  return setInterval(run, config.graph.intakeMinutes * 60000);
}

module.exports = { pollOnce, start, agentForSender, vendorForSender };
