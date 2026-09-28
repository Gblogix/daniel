// Deleting uploads from Document intake: loose documents (and their files) go; documents already on a file stay.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gbl-idel-'));
const store = require('../src/db');
store.db = store.open(':memory:');
const { deleteIntakes } = require('../src/routes/intake');
const db = store.db;

test('delete pending and applied uploads', () => {
  const file = path.join(process.env.UPLOAD_DIR, 'merged.pdf');
  fs.writeFileSync(file, 'x');
  const kept = path.join(process.env.UPLOAD_DIR, 'hbl.pdf');
  fs.writeFileSync(kept, 'x');
  const pending = Number(db.run("INSERT INTO intakes (status) VALUES ('PENDING')").lastInsertRowid);
  db.run("INSERT INTO documents (intake_id, doc_type, filename, stored_path) VALUES (?, 'MBL', 'm.pdf [p.1]', ?)", pending, file);
  db.run("INSERT INTO documents (intake_id, doc_type, filename, stored_path) VALUES (?, 'HBL', 'm.pdf [p.2]', ?)", pending, file);
  db.run("INSERT INTO mail_imports (message_id, intake_id) VALUES ('msg-1', ?)", pending);
  const sid = Number(db.run("INSERT INTO shipments (ref_no, mode, status) VALUES ('OI-1', 'FCL', 'BOOKED')").lastInsertRowid);
  const applied = Number(db.run("INSERT INTO intakes (status, shipment_id) VALUES ('APPLIED', ?)", sid).lastInsertRowid);
  db.run("INSERT INTO documents (intake_id, shipment_id, doc_type, filename, stored_path) VALUES (?, ?, 'HBL', 'hbl.pdf', ?)", applied, sid, kept);

  assert.equal(deleteIntakes([pending, applied, 999]), 2);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM intakes').n, 0);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM documents WHERE shipment_id IS NULL').n, 0);
  assert.equal(fs.existsSync(file), false, 'loose file removed once both documents are gone');
  assert.equal(db.get('SELECT COUNT(*) AS n FROM documents WHERE shipment_id = ?', sid).n, 1, 'document on the file stays');
  assert.equal(fs.existsSync(kept), true);
  assert.equal(db.get("SELECT intake_id FROM mail_imports WHERE message_id = 'msg-1'").intake_id, null, 'email not re-imported');
});
