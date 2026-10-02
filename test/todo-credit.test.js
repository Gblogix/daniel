// To-do by task, Action Center tasks, team summary, customer credit hold.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gbl-td-'));
const store = require('../src/db');
store.db = store.open(':memory:');
test.after(() => require('../src/docs/pdf').close());
require('../src/seed').seedDemo(store.db);
const db = store.db;
const S = require('../src/shipments');
const A = require('../src/accounting');
const F = require('../src/followups');
const C = require('../src/credit');
const notify = require('../src/notify');
const { createApp } = require('../src/server');

let server; let base;
test.before(async () => { server = createApp().listen(0); await new Promise((r) => server.once('listening', r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());
async function login(email, pw) {
  let cookie = '';
  const keep = (res) => { const c = res.headers.getSetCookie?.() || []; if (c.length) cookie = c.map((x) => x.split(';')[0]).join('; '); };
  const r1 = await fetch(`${base}/login`); keep(r1);
  const csrf = /name="_csrf" value="([^"]+)"/.exec(await r1.text())[1];
  keep(await fetch(`${base}/login`, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: csrf, email, password: pw }) }));
  const get = (p) => fetch(base + p, { headers: { cookie }, redirect: 'manual' });
  get.form = (p, body) => fetch(base + p, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
  get.csrf = async () => /name="_csrf" value="([^"]+)"/.exec(await (await get('/followups')).text())[1];
  return get;
}
const admin = () => login('admin@gblogix.com', 'changeme123');
const adminUser = () => db.get("SELECT * FROM users WHERE role = 'admin' LIMIT 1");
const party = (name, type, x = {}) => Number(db.run('INSERT INTO companies (name, type, emails, credit_limit, credit_hold, credit_note) VALUES (?, ?, ?, ?, ?, ?)', name, type, x.emails || null, x.limit ?? null, x.hold ? 1 : 0, x.note || null).lastInsertRowid);

test('follow-ups carry a task group; tasks join the list and clear when done', () => {
  const me = adminUser();
  const id = S.create({ mode: 'FCL', status: 'BOOKED', hbl_no: 'TD-H1', owner_id: me.id, mbl_no: 'MAEU500000005', etd: '2026-01-01' });
  db.run('INSERT INTO tasks (title, shipment_id, assignee_id, created_by) VALUES (?, ?, ?, ?)', 'Call customer about Friday', id, me.id, me.id);
  const items = F.forUser(me, { owner: me.id });
  const groups = F.byTask(items);
  assert.equal(groups[0].task, 'Task');
  assert.ok(groups.some((g) => g.task === 'Pre-Alert' || g.task === 'ISF'));
  const t = items.find((i) => i.task === 'Task');
  F.done(t.key);
  assert.equal(db.get('SELECT status FROM tasks WHERE id = ?', t.taskId).status, 'DONE');
  assert.ok(!F.forUser(me, { owner: me.id }).some((i) => i.task === 'Task'));
  const sum = F.teamSummary(me);
  assert.ok(sum.find((r) => r.id === me.id).alerts + sum.find((r) => r.id === me.id).warnings > 0);
});

test('credit: manual hold or over limit with past-due stops the D/O; an admin can release one file', async () => {
  const held = party('HELD BUYER', 'customer', { hold: true, note: 'bad credit' });
  const trucker = party('SAMPLE TRUCK', 'trucker', { emails: 'disp@truck.example' });
  const id = S.create({ mode: 'FCL', status: 'ARRIVED', hbl_no: 'CR-H1', customer_id: held, trucker_id: trucker, customs_status: 'RELEASED' });
  assert.equal(C.forShipment(S.find(id, null)).blocksRelease, true);
  assert.equal(await notify.sendDeliveryOrder(id), null);
  assert.ok(db.get("SELECT 1 FROM events WHERE shipment_id = ? AND type = 'NOTICE_SKIPPED' AND message LIKE 'D/O held%'", id));
  assert.ok(F.shipmentItems(S.find(id, null)).some((i) => i.key.endsWith(':credit')));
  const get = await admin();
  const page = await (await get(`/shipments/${id}`)).text();
  assert.match(page, /On hold — credit/);
  await get.form(`/shipments/${id}/credit-release`, { _csrf: await get.csrf(), on: '1' });
  assert.equal(C.forShipment(S.find(id, null)).blocksRelease, false);
  assert.ok(await notify.sendDeliveryOrder(id));
  // Over the limit only matters once something is past due.
  const big = party('BIG BUYER', 'customer', { limit: 1000 });
  A.saveInvoice({ kind: 'AR', company_id: big, invoice_date: '2030-01-01', due_date: '2030-01-31', lines: [{ description: 'Freight', amount: 5000 }] });
  assert.deepEqual([C.state(big).over, C.state(big).hold], [true, false]);
  A.saveInvoice({ kind: 'AR', company_id: big, invoice_date: '2026-01-01', due_date: '2026-01-15', lines: [{ description: 'Freight', amount: 100 }] });
  assert.equal(C.state(big).hold, true);
});

test('pages: to-do by task, team summary, dashboard Action Center, party credit fields', async () => {
  const get = await admin();
  const csrf = await get.csrf();
  await get.form('/tasks', { _csrf: csrf, title: 'Chase POD from trucker', assignee_id: String(adminUser().id) });
  const dash = await (await get('/dashboard')).text();
  assert.match(dash, /Action Center/);
  assert.match(dash, /Chase POD from trucker/);
  assert.match(dash, /To-do list — team/);
  assert.match(await (await get(`/followups?view=details&op=${adminUser().id}`)).text(), /class="tgroup"/);
  assert.match(await (await get('/followups?view=summary')).text(), /Alerts/);
  const pid = party('FORM BUYER', 'customer');
  await get.form('/companies', { _csrf: csrf, id: String(pid), name: 'FORM BUYER', types: 'customer', type: 'customer', credit_limit: '$200,000', credit_hold: '1', credit_note: 'pay first' });
  assert.deepEqual(db.get('SELECT credit_limit, credit_hold, credit_note FROM companies WHERE id = ?', pid), { credit_limit: 200000, credit_hold: 1, credit_note: 'pay first' });
});
