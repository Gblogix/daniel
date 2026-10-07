// Accounting lock: a finished file locks itself; only an admin locks / unlocks (with a reason).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gbl-lock-'));
const store = require('../src/db');
store.db = store.open(':memory:');
require('../src/seed').seedDemo(store.db);
const db = store.db;
const S = require('../src/shipments');
const A = require('../src/accounting');
const L = require('../src/locks');
const { createApp } = require('../src/server');

let server; let base;
test.before(async () => { server = createApp().listen(0); await new Promise((r) => server.once('listening', r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());
async function login(email, password) {
  let cookie = '';
  const keep = (res) => { const c = res.headers.getSetCookie?.() || []; if (c.length) cookie = c.map((x) => x.split(';')[0]).join('; '); };
  const r1 = await fetch(`${base}/login`); keep(r1);
  const csrf = /name="_csrf" value="([^"]+)"/.exec(await r1.text())[1];
  keep(await fetch(`${base}/login`, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: csrf, email, password }) }));
  const page = await (await fetch(`${base}/dashboard`, { headers: { cookie } })).text();
  const token = /name="_csrf" value="([^"]+)"/.exec(page)?.[1];
  const get = (p) => fetch(base + p, { headers: { cookie }, redirect: 'manual' });
  get.form = (p, body) => fetch(base + p, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded', referer: `${base}/dashboard` }, body: new URLSearchParams({ _csrf: token, ...body }) });
  return get;
}
const party = (name, type) => Number(db.run('INSERT INTO companies (name, type) VALUES (?, ?)', name, type).lastInsertRowid);

/** A delivered file with one customer invoice and one vendor bill. */
function file(tag) {
  const cust = party(`LOCK BUYER ${tag}`, 'customer'); const vend = party(`LOCK TRUCKER ${tag}`, 'vendor');
  const id = S.create({ mode: 'FCL', status: 'DELIVERED', hbl_no: `LOCK-${tag}`, customer_id: cust, shipper_name: 'SAMPLE FACTORY' });
  const ar = A.saveInvoice({ kind: 'AR', shipment_id: id, company_id: cust, lines: [{ description: 'OCEAN FREIGHT', amount: 1000 }] });
  const ap = A.saveInvoice({ kind: 'AP', shipment_id: id, company_id: vend, number: `TRK-${tag}`, lines: [{ description: 'TRUCKING', amount: 400 }] });
  return { id, cust, vend, ar, ap };
}

test('locks itself only when the customer is paid AND the vendor bills are paid', () => {
  const f = file('A');
  A.recordPayment({ company_id: f.cust, direction: 'IN', amount: 1000, allocations: [{ invoice_id: f.ar, amount: 1000 }] });
  assert.ok(S.find(f.id, null).closed_at, 'closed when the customer paid');
  assert.equal(L.isLocked(f.id), false, 'vendor bill still open → not locked');
  A.recordPayment({ company_id: f.vend, direction: 'OUT', amount: 400, allocations: [{ invoice_id: f.ap, amount: 400 }] });
  assert.equal(L.isLocked(f.id), true);
  assert.match(db.get("SELECT message FROM events WHERE shipment_id = ? AND type = 'LOCKED'", f.id).message, /automatically/);
});

test('a locked file: fields, lines and invoices cannot change; tracking / sync updates are ignored', () => {
  const f = file('B');
  A.recordPayment({ company_id: f.cust, direction: 'IN', amount: 1000, allocations: [{ invoice_id: f.ar, amount: 1000 }] });
  A.recordPayment({ company_id: f.vend, direction: 'OUT', amount: 400, allocations: [{ invoice_id: f.ap, amount: 400 }] });
  assert.ok(L.isLocked(f.id));
  assert.deepEqual(S.update(f.id, { vessel: 'CHANGED', status: 'ARRIVED' }), []);
  assert.equal(S.find(f.id, null).vessel ?? null, null);
  S.saveLines(f.id, { ctn_no: ['ABCU1234567'] });
  assert.equal(db.get('SELECT COUNT(*) AS n FROM containers WHERE shipment_id = ?', f.id).n, 0);
  assert.throws(() => A.saveInvoice({ kind: 'AP', shipment_id: f.id, company_id: f.vend, number: 'LATE-1', lines: [{ description: 'X', amount: 5 }] }), { code: 'LOCKED' });
  assert.throws(() => A.saveInvoice({ kind: 'AR', company_id: f.cust, lines: [{ description: 'X', amount: 5 }] }, { id: f.ar }), { code: 'LOCKED' });
  assert.throws(() => A.voidInvoice(f.ar), { code: 'LOCKED' });
  assert.throws(() => S.setClosed(f.id, false), { code: 'LOCKED' });
  // Invoices not on a file are not affected.
  assert.ok(A.saveInvoice({ kind: 'AR', company_id: f.cust, lines: [{ description: 'MISC', amount: 5 }] }));
});

test('unlock needs a reason; an unlocked file does not lock itself again until an admin locks it', () => {
  const f = file('C');
  A.recordPayment({ company_id: f.cust, direction: 'IN', amount: 1000, allocations: [{ invoice_id: f.ar, amount: 1000 }] });
  A.recordPayment({ company_id: f.vend, direction: 'OUT', amount: 400, allocations: [{ invoice_id: f.ap, amount: 400 }] });
  assert.throws(() => L.unlock(f.id, { userId: 1, reason: ' ' }), /reason/);
  L.unlock(f.id, { userId: 1, reason: 'vendor sent a corrected bill' });
  assert.equal(L.isLocked(f.id), false);
  const row = db.get('SELECT lock_release_reason FROM shipments WHERE id = ?', f.id);
  assert.equal(row.lock_release_reason, 'vendor sent a corrected bill');
  assert.equal(L.sweep(), 0, 'sweep leaves an unlocked file alone');
  assert.deepEqual(S.update(f.id, { vessel: 'FIXED' }).map((c) => c.field), ['vessel']);
  L.lock(f.id, { userId: 1 });
  assert.ok(L.isLocked(f.id));
  assert.equal(db.get('SELECT lock_released_at FROM shipments WHERE id = ?', f.id).lock_released_at, null);
});

test('sweep locks finished files that were closed before the lock existed', () => {
  const f = file('D');
  db.run("UPDATE invoices SET status = 'PAID', paid_amount = ABS(total) WHERE shipment_id = ?", f.id);
  db.run("UPDATE shipments SET closed_at = datetime('now') WHERE id = ?", f.id);
  assert.equal(L.isLocked(f.id), false);
  assert.ok(L.sweep() >= 1);
  assert.ok(L.isLocked(f.id));
});

test('only an admin locks / unlocks; staff with accounting access cannot; the page says it is locked', async () => {
  const f = file('E');
  const acct = await login('accounting@gblogix.com', 'demo1234');
  assert.equal((await acct.form(`/shipments/${f.id}/lock`, { on: '1' })).status, 403);
  assert.equal(L.isLocked(f.id), false);
  const admin = await login('admin@gblogix.com', 'changeme123');
  await admin.form(`/shipments/${f.id}/lock`, { on: '1' });
  assert.ok(L.isLocked(f.id));
  const html = await (await admin(`/shipments/${f.id}`)).text();
  assert.match(html, /Locked — accounting finished/);
  assert.match(html, /Reason for unlocking/);
  // Editing the locked file is refused with a message, not an error page.
  const r = await admin.form(`/shipments/${f.id}`, { vessel: 'NOPE' });
  assert.equal(r.status, 302);
  assert.equal(S.find(f.id, null).vessel ?? null, null);
  // Staff see the lock but no unlock box.
  const staffPage = await (await acct(`/shipments/${f.id}`)).text();
  assert.match(staffPage, /Locked — accounting finished/);
  assert.doesNotMatch(staffPage, /Reason for unlocking/);
  assert.equal((await acct.form(`/shipments/${f.id}/lock`, { on: '0', reason: 'x' })).status, 403);
  // Unlock without a reason is refused; with one it works.
  await admin.form(`/shipments/${f.id}/lock`, { on: '0' });
  assert.ok(L.isLocked(f.id));
  await admin.form(`/shipments/${f.id}/lock`, { on: '0', reason: 'customer disputed a charge' });
  assert.equal(L.isLocked(f.id), false);
});
