// Nightly backup: consistent DB copy + uploads mirrored + old copies pruned.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gbl-bk-up-'));
const store = require('../src/db');
const dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gbl-bk-db-')), 'live.db');
store.db = store.open(dbFile);
const B = require('../src/backup');

test('backup copies the database and new uploads, prunes old copies', () => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'gbl-bk-out-'));
  store.db.run("INSERT INTO companies (name, type) VALUES ('BACKUP CO', 'customer')");
  fs.mkdirSync(path.join(process.env.UPLOAD_DIR, 'shipments'), { recursive: true });
  fs.writeFileSync(path.join(process.env.UPLOAD_DIR, 'shipments', 'a.pdf'), 'pdf');
  fs.mkdirSync(path.join(target, 'database'), { recursive: true });
  fs.writeFileSync(path.join(target, 'database', 'gblogix-2020-01-01.db'), 'old');
  const r = B.run({ target, now: new Date('2026-10-06T09:00:00Z') });
  assert.equal(r.files, 1);
  assert.ok(fs.existsSync(path.join(target, 'uploads', 'shipments', 'a.pdf')));
  assert.ok(!fs.existsSync(path.join(target, 'database', 'gblogix-2020-01-01.db')), 'old copy pruned');
  const copy = store.open(r.file);
  assert.equal(copy.get("SELECT name FROM companies WHERE name = 'BACKUP CO'").name, 'BACKUP CO');
  assert.equal(B.run({ target, now: new Date('2026-10-07T09:00:00Z') }).files, 0, 'unchanged files not copied again');
  assert.equal(B.last().file.endsWith('gblogix-2026-10-07.db'), true);
});
