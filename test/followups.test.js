// The four principles across the system: follow-ups (nothing slips), heads-up digests, automatic status,
// person in charge, global search, customer next step / delivery requests / shipment reports.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gbl-fu-'));
const store = require('../src/db');
store.db = store.open(':memory:');
test.after(() => require('../src/docs/pdf').close());
const { seedDemo, bootstrap } = require('../src/seed');
const S = require('../src/shipments');
const F = require('../src/followups');
const A = require('../src/accounting');
const ids = seedDemo(store.db);
bootstrap?.(store.db);
const db = store.db;
const admin = () => db.get("SELECT * FROM users WHERE role = 'admin'") || { id: 0, role: 'admin' };
const staffUser = () => db.get("SELECT * FROM users WHERE email = 'staff@gblogix.com'");
const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const ship = (mbl) => S.list({ role: 'staff' }).find((x) => x.mbl_no === mbl);
const keysFor = (sid, user = admin()) => F.forUser(user, { shipmentId: sid }).map((i) => i.key.split(':')[1]);

test('follow-ups: ISF, A/N, missing documents, delivery plan for a file arriving soon', () => {
  const s = ship('HDMUPUSA1234567');
  db.run('UPDATE shipments SET isf_filed = 0, etd = ?, eta = ?, an_sent_at = NULL, delivery_date = NULL, status = ? WHERE id = ?', day(1), day(3), 'BOOKED', s.id);
  const k = keysFor(s.id);
  assert.ok(k.includes('isf'), 'ISF due before loading');
  assert.ok(k.includes('an'), 'A/N within 5 days of ETA');
  assert.ok(k.includes('delivery_plan'));
  assert.ok(k.includes('pic'), 'no person in charge');
  const an = F.forUser(admin(), { shipmentId: s.id }).find((i) => i.key.endsWith(':an'));
  assert.equal(an.action.post, `/shipments/${s.id}/actions/send-an`);
});

test('follow-ups: hold, D/O after release, LFD, delivery date passed, empty return', () => {
  const s = ship('CMDUSHZ8105615');
  assert.ok(keysFor(s.id).includes('hold'));
  db.run("UPDATE shipments SET holds = NULL, customs_status = 'RELEASED', do_sent_at = NULL, last_free_day = ?, delivery_date = ? WHERE id = ?", day(0), day(-1), s.id);
  const k = keysFor(s.id);
  assert.ok(k.includes('do'));
  assert.ok(k.includes('lfd'));
  assert.ok(k.includes('pod'));
  const lfd = F.forUser(admin(), { shipmentId: s.id }).find((i) => i.key.includes(':lfd'));
  assert.equal(lfd.severity, 'critical');
  db.run("UPDATE shipments SET status = 'DELIVERED', picked_up_at = ?, empty_returned_at = NULL WHERE id = ?", day(-5), s.id);
  assert.deepEqual(keysFor(s.id).filter((x) => ['empty', 'not_invoiced', 'no_cost'].includes(x)).sort(), ['empty', 'no_cost', 'not_invoiced']);
});

test('follow-ups disappear when the work is done; snooze and done hide them', () => {
  const s = ship('HDMUPUSA1234567');
  db.run("UPDATE shipments SET an_sent_at = datetime('now') WHERE id = ?", s.id);
  assert.ok(!keysFor(s.id).includes('an'));
  const isf = F.forUser(admin(), { shipmentId: s.id }).find((i) => i.key.endsWith(':isf'));
  F.snooze(isf.key, 1);
  assert.ok(!keysFor(s.id).includes('isf'));
  assert.ok(F.forUser(admin(), { shipmentId: s.id, includeHidden: true }).some((i) => i.key === isf.key && i.hidden === 'snoozed'));
  F.reopen(isf.key);
  F.done(isf.key);
  assert.ok(!keysFor(s.id).includes('isf'));
});

test('accounting follow-ups only for accounting users; one-click actions respect permissions', () => {
  const s = ship('CMDUSHZ8105615');
  const staff = staffUser();
  assert.ok(!F.forUser(staff, { shipmentId: s.id }).some((i) => i.area === 'acct'));
  const inv = A.saveInvoice({ kind: 'AR', shipment_id: s.id, company_id: ids.leepop, lines: [{ description: 'X', amount: 10 }] });
  assert.ok(F.forUser(admin(), { shipmentId: s.id }).some((i) => i.key === `i${inv}:review`));
  A.setReviewed(inv, true);
  assert.ok(F.forUser(admin(), { shipmentId: s.id }).some((i) => i.key === `i${inv}:send` && i.action.post === `/invoices/${inv}/send`));
  db.run(`UPDATE users SET perms = '{"shipments_edit":true,"send_notices":false}' WHERE id = ?`, staff.id);
  const s2 = ship('HDMUPUSA1234567');
  db.run('UPDATE shipments SET an_sent_at = NULL WHERE id = ?', s2.id);
  const an = F.forUser(db.get('SELECT * FROM users WHERE id = ?', staff.id), { shipmentId: s2.id }).find((i) => i.key.endsWith(':an'));
  assert.equal(an.action.label, 'Open file');
  db.run('UPDATE users SET perms = NULL WHERE id = ?', staff.id);
});

test('"my files": PIC defaults to the customer default PIC, else the creator; mine filters by PIC', () => {
  const staff = staffUser();
  db.run('UPDATE companies SET default_pic_id = ? WHERE id = ?', staff.id, ids.pgp);
  const a = S.create({ mode: 'FCL', customer_id: ids.pgp, shipper_name: 'X' }, { userId: admin().id });
  assert.equal(S.find(a, null).owner_id, staff.id);
  const b = S.create({ mode: 'FCL', customer_id: ids.leepop, shipper_name: 'Y' }, { userId: staff.id });
  assert.equal(S.find(b, null).owner_id, staff.id);
  assert.ok(S.list(staff, { owner: staff.id }).every((x) => x.owner_id === staff.id));
  const mine = F.forUser(staff, { mine: true });
  assert.ok(mine.filter((i) => i.shipment_id).every((i) => i.owner_id === staff.id));
});

test('status follows the dates, only forward', () => {
  const id = S.create({ mode: 'FCL', status: 'BOOKED', shipper_name: 'AUTO', etd: day(-5), eta: day(5) }, {});
  S.update(id, { atd: day(-5) });
  assert.equal(S.find(id, null).status, 'DEPARTED');
  S.update(id, { ata: day(0) });
  assert.equal(S.find(id, null).status, 'ARRIVED');
  S.update(id, { customs_status: 'RELEASED' });
  assert.equal(S.find(id, null).status, 'CUSTOMS_CLEARED');
  S.update(id, { picked_up_at: day(0) });
  assert.equal(S.find(id, null).status, 'OUT_FOR_DELIVERY');
  S.update(id, { pod_received: 1 });
  assert.equal(S.find(id, null).status, 'DELIVERED');
  S.update(id, { atd: day(-6) }); // never goes back
  assert.equal(S.find(id, null).status, 'DELIVERED');
  db.setSetting('auto_status', '0');
  const j = S.create({ mode: 'FCL', status: 'BOOKED', shipper_name: 'MANUAL' }, {});
  S.update(j, { atd: day(-1) });
  assert.equal(S.find(j, null).status, 'BOOKED');
  db.setSetting('auto_status', '1');
});

test('customer next step in plain language', () => {
  assert.match(S.customerStep({ status: 'IN_TRANSIT', mode: 'FCL', eta: day(4) }).text, /On the water — arriving .* \(4 days\)/);
  assert.equal(S.customerStep({ status: 'ARRIVED', customs_status: 'EXAM', mode: 'FCL' }).text, 'Arrived — held for customs exam; we will update you on release');
  const r = S.customerStep({ status: 'CUSTOMS_CLEARED', mode: 'AIR' });
  assert.equal(r.ask, true);
});

test('heads-up digests to staff and scheduled reports to customers', async () => {
  const { sendDailyDigests, sendCustomerReports } = require('../src/alerts');
  const n = await sendDailyDigests({ force: true });
  assert.ok(n >= 1);
  const mail = db.get("SELECT * FROM emails WHERE kind = 'DAILY_DIGEST' ORDER BY id DESC LIMIT 1");
  assert.match(mail.subject, /critical · .* high · .* follow-ups/);
  assert.equal(await sendDailyDigests(), 0, 'once a day');
  db.run("UPDATE companies SET report_frequency = 'daily', report_emails = 'ops@leepop.example' WHERE id = ?", ids.leepop);
  assert.equal(await sendCustomerReports({ force: true }), 1);
  const rep = db.get("SELECT * FROM emails WHERE kind = 'CUSTOMER_REPORT' ORDER BY id DESC LIMIT 1");
  assert.equal(rep.to_addr, 'ops@leepop.example');
  assert.match(rep.body_html, /Where \/ next/);
  assert.doesNotMatch(rep.body_html, /USD|invoice/i);
});

test('a B/L invoice with no P/L lines stays on the file follow-ups until its P/L arrives', () => {
  const S2 = require('../src/shipments');
  const F2 = require('../src/followups');
  const db2 = require('../src/db').db;
  const id = S2.create({ mode: 'FCL', status: 'BOOKED', shipper_name: 'X CO' });
  db2.run("UPDATE shipments SET bl_invoices = 'UB005,EZVC_TGT_26-09' WHERE id = ?", id);
  S2.saveLines(id, { item_desc: ['Serum'], item_inv: ['EZVC_TGT_26-09'], item_buyer: ['Target'] });
  const admin = db2.get("SELECT * FROM users WHERE role = 'admin'");
  const it = F2.forUser(admin, { shipmentId: id }).find((i) => i.key.includes('plmissing'));
  assert.ok(it, 'follow-up present');
  assert.match(it.title, /UB005/);
  assert.doesNotMatch(it.title, /EZVC/);
  S2.saveLines(id, { item_desc: ['Serum', 'Mask'], item_inv: ['EZVC_TGT_26-09', 'ub005'], item_buyer: ['Target', 'Ulta'] });
  assert.ok(!F2.forUser(admin, { shipmentId: id }).some((i) => i.key.includes('plmissing')), 'cleared once the P/L is in');
});

test('ETA unknown once the B/L is in', () => {
  const S2 = require('../src/shipments');
  const F2 = require('../src/followups');
  const db2 = require('../src/db').db;
  const id = S2.create({ mode: 'FCL', status: 'BOOKED', mbl_no: 'MAEU999000111' });
  const admin = db2.get("SELECT * FROM users WHERE role = 'admin'");
  assert.ok(F2.forUser(admin, { shipmentId: id }).some((i) => i.key.endsWith(':eta_missing')));
  S2.update(id, { eta: '2026-10-20' });
  assert.ok(!F2.forUser(admin, { shipmentId: id }).some((i) => i.key.endsWith(':eta_missing')));
});
