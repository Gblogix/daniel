// Dragging a whole email onto an upload form (its attachments are used) and the one-time go-live clean-up.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gbl-drop-'));
const store = require('../src/db');
store.db = store.open(':memory:');
const { seedDemo } = require('../src/seed');
const { expandMailFiles } = require('../src/extract/mailfile');
const { freshStartOnce } = require('../src/reset');

async function eml() {
  const MailComposer = require('nodemailer/lib/mail-composer');
  return new MailComposer({
    from: 'billing@cfs.example', to: 'ap@gblogix.com', subject: 'Invoice CFS-1001 TCLU1234567',
    html: '<p>Please see attached</p><img src="cid:logo">',
    attachments: [
      { filename: 'CFS-1001.pdf', content: Buffer.from('%PDF-1.4 test'), contentType: 'application/pdf' },
      { filename: 'logo.png', content: Buffer.alloc(200), contentType: 'image/png', cid: 'logo' },
      { filename: 'rates.xlsx', content: Buffer.from('xlsx'), contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
    ],
  }).compile().build();
}

test('an .eml dropped on the vendor invoice page becomes its PDF attachment (logos and other types skipped)', async () => {
  const buffer = await eml();
  const r = await expandMailFiles([{ buffer, filename: 'Invoice CFS-1001.eml', mime: 'message/rfc822' },
    { buffer: Buffer.from('%PDF'), filename: 'direct.pdf', mime: 'application/pdf' }], { accept: ['.pdf', '.jpg', '.jpeg', '.png'] });
  assert.deepEqual(r.files.map((f) => f.filename), ['CFS-1001.pdf', 'direct.pdf']);
  assert.equal(r.files[0].mime, 'application/pdf');
  assert.equal(r.files[0].mail.from, 'billing@cfs.example');
  assert.equal(r.mails[0].subject, 'Invoice CFS-1001 TCLU1234567');
  const all = await expandMailFiles([{ buffer, filename: 'x.eml' }]);
  assert.deepEqual(all.files.map((f) => f.filename), ['CFS-1001.pdf', 'rates.xlsx']);
});

test('a broken email file is reported, not thrown', async () => {
  const r = await expandMailFiles([{ buffer: Buffer.from('not an outlook file'), filename: 'x.msg' }]);
  assert.equal(r.files.length, 0);
  assert.ok(r.mails[0].error);
});

test('go-live clean-up runs once: removes test shipments, keeps parties, turns Smartsheet pull off', () => {
  const db = store.db;
  seedDemo(db);
  const parties = db.get('SELECT COUNT(*) AS n FROM companies').n;
  assert.ok(db.get('SELECT COUNT(*) AS n FROM shipments').n > 0);
  const r = freshStartOnce({ db });
  assert.ok(r.shipments > 0);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM shipments').n, 0);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM companies').n, parties);
  assert.equal(db.setting('smartsheet_sync'), '0');
  db.run("INSERT INTO shipments (ref_no, mode, status) VALUES ('OI-20001', 'OCEAN', 'BOOKED')");
  assert.equal(freshStartOnce({ db }), null);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM shipments').n, 1, 'real files entered afterwards are never touched');
});
