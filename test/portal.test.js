// Customer portal: phase counts, arrival calendar, invoices tab, journey with hidden stages.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gbl-portal-'));
const store = require('../src/db');
store.db = store.open(':memory:');
test.after(() => require('../src/docs/pdf').close());
const ids = require('../src/seed').seedDemo(store.db);
const db = store.db;
const S = require('../src/shipments');
const P = require('../src/portal');
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
  return (p) => fetch(base + p, { headers: { cookie }, redirect: 'manual' });
}

test('phases and week', () => {
  const rows = [{ status: 'BOOKED', eta: '2026-10-07' }, { status: 'IN_TRANSIT', eta: '2026-10-07' }, { status: 'ARRIVED', ata: '2026-10-05' }, { status: 'DELIVERED', delivery_date: '2026-09-28' }];
  const p = P.phases(rows, new Date('2026-10-05T12:00:00Z'));
  assert.equal(p.active, 3);
  assert.deepEqual(p.counts.map((c) => c.n), [1, 0, 1, 1, 0, 1]);
  const w = P.week(rows, 0, new Date('2026-10-07T12:00:00Z'));
  assert.equal(w[0].day, '2026-10-05');
  assert.equal(w.find((d) => d.day === '2026-10-07').list.length, 2);
});

test('customer portal: dashboard, phase list, invoices tab; hidden stages stay hidden', async () => {
  const cust = db.get("SELECT u.email, u.company_id FROM users u WHERE u.role = 'customer' LIMIT 1");
  const get = await login(cust.email, 'demo1234');
  const page = await (await get('/track')).text();
  assert.match(page, /Active  shipments|Active shipments/);
  assert.match(page, /Estimated arrival/);
  assert.match(await (await get('/track?phase=transit')).text(), /International transit/);
  assert.match(await (await get('/track?tab=invoice')).text(), /Invoices/);
  const sid = db.get('SELECT id FROM shipments WHERE customer_id = ? AND mode = ? LIMIT 1', cust.company_id, 'FCL')?.id
    || S.create({ mode: 'FCL', status: 'ARRIVED', customer_id: cust.company_id, hbl_no: 'PT-H1' });
  if (!db.get('SELECT 1 FROM containers WHERE shipment_id = ?', sid)) S.saveLines(sid, { ctn_no: ['MSKU1234565'] });
  let d = await (await get(`/shipments/${sid}`)).text();
  assert.match(d, /Empty returned/);
  db.run("UPDATE companies SET portal_hide = 'empty,lfd' WHERE id = ?", cust.company_id);
  d = await (await get(`/shipments/${sid}`)).text();
  assert.match(d, /Journey/);
  assert.doesNotMatch(d, /Empty returned/);
  assert.doesNotMatch(d, /j-label">LFD/);
  assert.match(d, /Document info/);
});
