// End-to-end permission checks over HTTP: accounting is visible only to admins and staff with accounting access.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gbl-perm-'));
const store = require('../src/db');
store.db = store.open(':memory:');
test.after(() => require('../src/docs/pdf').close());
const { seedDemo } = require('../src/seed');
const A = require('../src/accounting');
const ids = seedDemo(store.db);
const { createApp } = require('../src/server');

let server; let base;
test.before(async () => {
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

async function login(email) {
  let cookie = '';
  const keep = (res) => { const c = res.headers.getSetCookie?.() || []; if (c.length) cookie = c.map((x) => x.split(';')[0]).join('; '); };
  const r1 = await fetch(`${base}/login`); keep(r1);
  const csrf = /name="_csrf" value="([^"]+)"/.exec(await r1.text())[1];
  const r2 = await fetch(`${base}/login`, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrf, email, password: email.startsWith('admin') ? 'changeme123' : 'demo1234' }) });
  keep(r2);
  assert.equal(r2.status, 302, `login ${email}`);
  const get = (p) => fetch(base + p, { headers: { cookie }, redirect: 'manual' });
  get.form = (p, body) => fetch(base + p, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body });
  get.post = (p, body, csrf) => fetch(base + p, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify(body) });
  return get;
}

test('accounting pages: admin and accounting staff only', async () => {
  const s = store.db.get("SELECT id FROM shipments WHERE mbl_no = 'HDMUPUSA1234567'");
  const invId = A.saveInvoice({ kind: 'AR', shipment_id: s.id, company_id: ids.unlockt, lines: [{ description: 'Ocean freight', amount: 8100 }] });
  const doc = store.db.run("INSERT INTO documents (shipment_id, doc_type, filename, stored_path, mime, source) VALUES (?, 'AR', 'AR_INV.pdf', ?, 'application/pdf', 'generated')", s.id, __filename);
  const docId = Number(doc.lastInsertRowid);

  const admin = await login('admin@gblogix.com');
  const acct = await login('accounting@gblogix.com');
  const staff = await login('staff@gblogix.com');
  const customer = await login('customer@unlockt.example');

  for (const get of [admin, acct]) {
    assert.equal((await get('/billing')).status, 200);
    assert.equal((await get(`/invoices/${invId}`)).status, 200);
    const page = await (await get(`/shipments/${s.id}`)).text();
    assert.match(page, /id="accounting"/);
  }
  assert.equal((await staff('/billing')).status, 403);
  assert.equal((await staff(`/invoices/${invId}`)).status, 403);
  assert.equal((await staff(`/invoices/${invId}/preview`)).status, 403);
  assert.equal((await staff(`/documents/${docId}`)).status, 403);
  const staffPage = await (await staff(`/shipments/${s.id}`)).text();
  assert.doesNotMatch(staffPage, /id="accounting"|bill-(warn|bad)|Not invoiced|AR_INV\.pdf|href="\/billing"|Service price/);
  assert.doesNotMatch(await (await staff('/dashboard')).text(), /not invoiced|awaiting payment/i);
  assert.match(await (await acct('/dashboard')).text(), /Delivered — not invoiced/);
  for (const p of ['/billing/profit', `/billing/parties/${ids.ctc}`, '/billing/aging', `/billing/parties/${ids.unlockt}/statement?basis=eta`, '/billing/aging?format=xlsx', '/vendor-bills']) {
    assert.equal((await admin(p)).status, 200, p);
    assert.equal((await acct(p)).status, 200, p);
    assert.equal((await staff(p)).status, 403, p);
    assert.equal((await customer(p)).status, 403, p);
  }
  const staffHistory = await staff('/history');
  assert.equal(staffHistory.status, 200);
  assert.doesNotMatch(await staffHistory.text(), /Profit|Billing<\/th>/);
  assert.doesNotMatch(await (await staff('/track?filter=delivered')).text(), /bill-(warn|bad)/);
  assert.equal((await customer('/history')).status, 403);
  for (const p of ['/shipments?sort=desc', '/masters?sort=desc', '/track?sort=asc', '/history?sort=asc']) {
    const r = await staff(p);
    assert.equal(r.status, 200, p);
    assert.match(await r.text(), /ETA ↑ next arrival first/, p);
  }

  assert.equal((await customer(`/invoices/${invId}`)).status, 403);
  assert.equal((await customer(`/documents/${docId}`)).status, 403);
  assert.equal((await customer('/my/invoices')).status, 404);
  const custPage = await (await customer(`/shipments/${s.id}`)).text();
  assert.doesNotMatch(custPage, /Service price|Invoice|\$\d/);
});

test('staff workspace: tabs shell, menu by permission, favorites saved per user', async () => {
  const staff = await login('staff@gblogix.com');
  const acct = await login('accounting@gblogix.com');
  const customer = await login('customer@unlockt.example');
  assert.equal((await staff('/')).headers.get('location'), '/app');
  assert.equal((await customer('/')).headers.get('location'), '/track');
  assert.equal((await customer('/app')).status, 403);
  const page = await (await staff('/app?open=/shipments')).text();
  const data = JSON.parse(/<script type="application\/json" id="shell-data">([^<]*)<\/script>/.exec(page)[1]);
  assert.equal(data.open, '/shipments');
  assert.ok(!data.items.some((i) => i.href.startsWith('/billing')), 'no accounting menu for staff');
  assert.ok(!data.favorites.includes('ar-entry'));
  const acctData = JSON.parse(/id="shell-data">([^<]*)</.exec(await (await acct('/app')).text())[1]);
  assert.ok(acctData.items.some((i) => i.id === 'pl'));
  // Staff cannot favorite an accounting page; the rest is saved.
  const r = await staff.post('/me/favorites', { ids: ['track', 'pl', 'history'] }, data.csrf);
  assert.deepEqual((await r.json()).ids, ['track', 'history']);
  const again = JSON.parse(/id="shell-data">([^<]*)</.exec(await (await staff('/app')).text())[1]);
  assert.deepEqual(again.favorites, ['track', 'history']);
  assert.equal((await staff.post('/me/favorites', { ids: [] }, 'bad')).status, 403);
  // An absolute URL cannot be smuggled into ?open=
  const evil = JSON.parse(/id="shell-data">([^<]*)</.exec(await (await staff('/app?open=//evil.example')).text())[1]);
  assert.equal(evil.open, '');
});

test('permission matrix: check / uncheck per staff user is enforced', async () => {
  const auth = require('../src/auth');
  const staffRow = store.db.get("SELECT * FROM users WHERE email = 'staff@gblogix.com'");
  // Defaults: staff edit shipments and send notices, but no accounting / delete / settings / users.
  assert.equal(auth.can(staffRow, 'shipments_edit'), true);
  assert.equal(auth.can(staffRow, 'delete'), false);
  const admin = await login('admin@gblogix.com');
  const page = await (await admin('/admin/permissions')).text();
  assert.match(page, /Save permissions/);
  const csrf = /name="_csrf" value="([^"]+)"/.exec(page)[1];
  const staffBefore = await login('staff@gblogix.com');
  assert.equal((await staffBefore('/admin/permissions')).status, 403);
  // Take "send notices" away, give "delete" and "settings".
  const body = new URLSearchParams({ _csrf: csrf, ids: String(staffRow.id) });
  for (const k of ['shipments_edit', 'intake', 'parties', 'delete', 'settings']) body.append(`u${staffRow.id}_${k}`, '1');
  body.append(`u${staffRow.id}_active`, '1');
  const r = await admin.form('/admin/permissions', body);
  assert.equal(r.status, 302);
  const after = store.db.get("SELECT * FROM users WHERE email = 'staff@gblogix.com'");
  assert.equal(auth.can(after, 'send_notices'), false);
  assert.equal(auth.can(after, 'delete'), true);
  assert.equal(auth.can(after, 'accounting'), false);
  const staff = await login('staff@gblogix.com');
  const s = store.db.get('SELECT id FROM shipments LIMIT 1');
  assert.doesNotMatch(await (await staff(`/shipments/${s.id}`)).text(), /Send A\/N/);
  assert.equal((await staff('/admin/settings')).status, 200);
  const menu = JSON.parse(/id="shell-data">([^<]*)</.exec(await (await staff('/app')).text())[1]);
  assert.ok(menu.items.some((i) => i.id === 'settings'));
  assert.ok(!menu.items.some((i) => i.id === 'permissions'));
  // Deactivate: login is refused.
  const off = new URLSearchParams({ _csrf: csrf, ids: String(staffRow.id) });
  await admin.form('/admin/permissions', off);
  assert.equal(store.db.get('SELECT active FROM users WHERE id = ?', staffRow.id).active, 0);
  store.db.run('UPDATE users SET active = 1, perms = NULL WHERE id = ?', staffRow.id);
});

test('workspace helpers: follow-ups page, bell count, global search; customer delivery request and Excel', async () => {
  const staff = await login('staff@gblogix.com');
  const acct = await login('accounting@gblogix.com');
  const customer = await login('customer@unlockt.example');
  assert.equal((await staff('/followups')).status, 200);
  assert.equal((await customer('/followups')).status, 403);
  const c = await (await staff('/followups/count.json')).json();
  assert.ok(Number.isInteger(c.critical) && Number.isInteger(c.total));
  const found = await (await staff('/search.json?q=TCLU1234567')).json();
  assert.equal(found[0].type, 'File');
  assert.match(found[0].label, /TCLU1234567/);
  assert.ok(!(await (await staff('/search.json?q=INV')).json()).some((r) => r.type === 'Invoice'), 'no invoices for non-accounting staff');
  assert.equal((await customer('/search.json?q=TCLU')).status, 403);
  void acct;

  const s = store.db.get("SELECT id FROM shipments WHERE mbl_no = 'HDMUPUSA1234567'");
  const page = await (await customer(`/shipments/${s.id}`)).text();
  assert.match(page, /Request a delivery date|Need a different delivery date/);
  const csrf = /name="_csrf" value="([^"]+)"/.exec(page)[1];
  const r = await customer.form(`/shipments/${s.id}/delivery-request`, new URLSearchParams({ _csrf: csrf, date: '2026-10-06', time: '9:00-12:00', note: 'Dock 4' }));
  assert.equal(r.status, 302);
  const row = store.db.get('SELECT * FROM shipments WHERE id = ?', s.id);
  assert.equal(row.delivery_request_date, '2026-10-06');
  assert.ok(store.db.get("SELECT 1 FROM emails WHERE kind = 'CUSTOMER_REQUEST' AND subject LIKE '%2026-10-06%'"));
  const F = require('../src/followups');
  assert.ok(F.forUser({ id: 0, role: 'admin' }, { shipmentId: s.id }).some((i) => i.key.includes(':custreq')));
  // Another customer cannot touch it.
  const other = await login('customer@leepop.example');
  const csrf2 = /name="_csrf" value="([^"]+)"/.exec(await (await other('/track')).text())[1];
  assert.equal((await other.form(`/shipments/${s.id}/delivery-request`, new URLSearchParams({ _csrf: csrf2, date: '2026-10-07' }))).status, 404);
  const x = await customer('/track.xlsx');
  assert.equal(x.status, 200);
  assert.match(x.headers.get('content-type'), /spreadsheetml/);
});

test('party lookup for Shipper / Consignee: Parties of the fitting type first, earlier files with their address; staff only', async () => {
  const S = require('../src/shipments');
  S.create({ mode: 'FCL', status: 'BOOKED', shipper_name: 'Olive International Inc.', shipper_address: '14F, 398, Seocho-daero, Seoul' });
  const staff = await login('staff@gblogix.com');
  const ship = await (await staff('/parties/lookup.json?role=shipper&q=olive')).json();
  assert.deepEqual(ship.map((r) => [r.name, r.address, r.source]), [['Olive International Inc.', '14F, 398, Seocho-daero, Seoul', 'file']]);
  const cnee = await (await staff('/parties/lookup.json?role=consignee&q=unlo')).json();
  assert.equal(cnee[0].name, 'UNLOCKT BRANDS, INC');
  assert.equal(cnee[0].type, 'customer');
  assert.match(cnee[0].address, /FIRESTONE/);
  const customer = await login('customer@unlockt.example');
  assert.notEqual((await customer('/parties/lookup.json?role=consignee&q=unlo')).status, 200);
});
