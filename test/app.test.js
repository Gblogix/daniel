const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gbl-test-'));
process.env.UPLOAD_DIR = tmp;
delete process.env.SMTP_HOST;

const store = require('../src/db');
store.db = store.open(':memory:');
const S = require('../src/shipments');
const notify = require('../src/notify');
const { seedDemo } = require('../src/seed');
const ids = seedDemo(store.db);

test('tracking bar: one cell per day, today blinking', () => {
  const now = new Date(2026, 9, 5); // 2026-10-05
  const tr = S.tracking({ status: 'IN_TRANSIT', mode: 'FCL', etd: '2026-10-01', eta: '2026-10-11' }, now);
  assert.equal(tr.days.length, 11);
  assert.deepEqual(tr.days.map((d) => d.state).slice(0, 6), ['done', 'done', 'done', 'done', 'current', 'todo']);
  assert.equal(tr.daysLeft, 6);
  assert.equal(tr.percent, 40);
  const arrived = S.tracking({ status: 'ARRIVED', mode: 'FCL', etd: '2026-10-01', eta: '2026-10-11' }, now);
  assert.ok(arrived.days.every((d) => d.state === 'done'));
  assert.equal(arrived.percent, 100);
  assert.equal(S.tracking({ status: 'BOOKED', mode: 'AIR' }).days.length, 0);
});

test('customers only see their own shipments', () => {
  const unlockt = { role: 'customer', company_id: ids.unlockt };
  const pgp = { role: 'customer', company_id: ids.pgp };
  const staff = { role: 'staff' };
  const all = S.list(staff);
  assert.equal(all.length, 5);
  assert.ok(S.list({ role: 'customer', company_id: ids.leepop }).every((s) => s.customer_id === ids.leepop));
  assert.ok(S.list(unlockt).every((s) => s.customer_id === ids.unlockt));
  assert.equal(S.list(pgp).length, 1);
  const pgpShipment = S.list(pgp)[0];
  assert.equal(S.find(pgpShipment.id, unlockt), null);
  assert.ok(S.find(pgpShipment.id, { role: 'broker', company_id: ids.opulen }));
  assert.equal(S.find(pgpShipment.id, { role: 'trucker', company_id: ids.omc }), null);
});

test('documents applied -> broker packet with A/N + customer update, subject format', async () => {
  const s = S.list({ role: 'staff' }).find((x) => x.mbl_no === 'HDMUPUSA1234567');
  await notify.onDocumentsApplied(s.id);
  const emails = store.db.all('SELECT * FROM emails WHERE shipment_id = ? ORDER BY id', s.id);
  assert.deepEqual(emails.map((e) => e.kind), ['BROKER_PACKET', 'CUSTOMER_UPDATE']);
  assert.equal(emails[0].to_addr, 'entry@ohmycustoms.example');
  assert.equal(emails[0].subject, '[A/N] MBL# HDMUPUSA1234567 / HBL# KMHB2409001 / CTN# TCLU1234567 / ETA ' + s.eta);
  assert.equal(emails[0].status, 'LOGGED');
  const att = JSON.parse(emails[0].attachments_json);
  assert.ok(att.some((a) => a.filename.includes('Arrival Notice')));
  assert.ok(fs.existsSync(att[0].path));
  assert.ok(S.find(s.id).an_sent_at);
});

test('customs released -> D/O to trucker automatically', async () => {
  const s = S.list({ role: 'staff' }).find((x) => x.mbl_no === 'HDMUPUSA1234567');
  const changes = S.update(s.id, { customs_status: 'RELEASED' });
  assert.deepEqual(changes.map((c) => c.field), ['customs_status']);
  await notify.onShipmentChanged(s.id, changes);
  const kinds = store.db.all('SELECT kind, to_addr FROM emails WHERE shipment_id = ? ORDER BY id', s.id);
  assert.ok(kinds.some((k) => k.kind === 'DELIVERY_ORDER' && k.to_addr === 'dispatch@ctc.example'));
  assert.ok(S.find(s.id).do_sent_at);
});

test('automation can be switched off', async () => {
  store.db.setSetting('auto_send_do', '0');
  const s = S.list({ role: 'staff' }).find((x) => x.mode === 'LCL');
  assert.ok(s);
  const changes = S.update(s.id, { customs_status: 'RELEASED' });
  await notify.onShipmentChanged(s.id, changes);
  assert.equal(store.db.all("SELECT 1 FROM emails WHERE shipment_id = ? AND kind = 'DELIVERY_ORDER'", s.id).length, 0);
  store.db.setSetting('auto_send_do', '1');
});

test('unchanged save reports no changes', () => {
  const s = S.list({ role: 'staff' })[0];
  assert.deepEqual(S.update(s.id, { eta: s.eta, paid: s.paid ? '1' : '' , weight_kg: String(s.weight_kg ?? '') }), []);
});

test('ref numbers are sequential per month', () => {
  const ref = S.nextRefNo(store.db);
  assert.match(ref, /^GBL-\d{4}-0006$/);
});
