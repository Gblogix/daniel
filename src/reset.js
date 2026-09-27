/**
 * "Start fresh": remove the demo / test data before going live. Deletes every shipment with its documents, invoices,
 * payments, intakes and email log, the demo logins (".example" addresses and "(demo)" users) and the demo notice
 * addresses on parties. Keeps admin accounts, parties, the company profile, numbering and settings.
 * Smartsheet rows are forgotten too, so the next sync brings the real files back in.
 */
const fs = require('node:fs');
const store = require('./db');

function clearData({ db = store.db, keepUserId = null } = {}) {
  const files = [
    ...db.all('SELECT stored_path FROM documents WHERE stored_path IS NOT NULL'),
  ].map((r) => r.stored_path);
  const counts = {
    shipments: db.get('SELECT COUNT(*) AS n FROM shipments').n,
    invoices: db.get('SELECT COUNT(*) AS n FROM invoices').n,
    documents: files.length,
  };
  db.tx(() => {
    db.run('UPDATE mail_imports SET intake_id = NULL');
    for (const t of ['payment_allocations', 'payments', 'invoice_lines', 'invoices', 'smartsheet_files', 'smartsheet_rows',
      'emails', 'tracking_events', 'events', 'charges', 'cargo_items', 'containers', 'documents', 'intakes', 'shipments']) db.run(`DELETE FROM ${t}`);
    const demo = db.all("SELECT id FROM users WHERE (email LIKE '%.example' OR name LIKE '%(demo)%') AND role <> 'admin' AND id IS NOT ?", keepUserId);
    counts.users = demo.length;
    for (const u of demo) db.run('DELETE FROM users WHERE id = ?', u.id);
    // Demo notice addresses on the parties (real addresses stay).
    for (const c of db.all("SELECT id, emails, billing_emails FROM companies WHERE emails LIKE '%.example%' OR billing_emails LIKE '%.example%'")) {
      const strip = (v) => (v || '').split(/[,;\s]+/).filter((e) => e && !/\.example$/i.test(e)).join(', ') || null;
      db.run('UPDATE companies SET emails = ?, billing_emails = ? WHERE id = ?', strip(c.emails), strip(c.billing_emails), c.id);
    }
  });
  for (const f of files) { try { fs.unlinkSync(f); } catch { /* already gone */ } }
  return counts;
}

module.exports = { clearData };
