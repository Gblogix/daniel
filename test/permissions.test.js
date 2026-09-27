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
  return (p) => fetch(base + p, { headers: { cookie }, redirect: 'manual' });
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
  for (const p of ['/billing/profit', `/billing/parties/${ids.ctc}`]) {
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

  assert.equal((await customer(`/invoices/${invId}`)).status, 403);
  assert.equal((await customer(`/documents/${docId}`)).status, 403);
  assert.equal((await customer('/my/invoices')).status, 404);
  const custPage = await (await customer(`/shipments/${s.id}`)).text();
  assert.doesNotMatch(custPage, /Service price|Invoice|\$\d/);
});
