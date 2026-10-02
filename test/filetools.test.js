// Shipment screen tools: copy / move / block / memo log, header badges, the send window, master house cards.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gbl-ft-'));
const store = require('../src/db');
store.db = store.open(':memory:');
test.after(() => require('../src/docs/pdf').close());
require('../src/seed').seedDemo(store.db);
const db = store.db;
const S = require('../src/shipments');
const M = require('../src/masters');
const A = require('../src/accounting');
const FT = require('../src/fileTools');
const { createApp } = require('../src/server');

let server; let base;
test.before(async () => { server = createApp().listen(0); await new Promise((r) => server.once('listening', r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());
async function admin() {
  let cookie = '';
  const keep = (res) => { const c = res.headers.getSetCookie?.() || []; if (c.length) cookie = c.map((x) => x.split(';')[0]).join('; '); };
  const r1 = await fetch(`${base}/login`); keep(r1);
  const csrf = /name="_csrf" value="([^"]+)"/.exec(await r1.text())[1];
  keep(await fetch(`${base}/login`, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: csrf, email: 'admin@gblogix.com', password: 'changeme123' }) }));
  const get = (p) => fetch(base + p, { headers: { cookie }, redirect: 'manual' });
  get.form = (p, body) => fetch(base + p, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
  get.csrf = async () => /name="_csrf" value="([^"]+)"/.exec(await (await get('/intakes')).text())[1];
  return get;
}
const party = (name, type, extra = {}) => Number(db.run('INSERT INTO companies (name, type, emails, terms_days) VALUES (?, ?, ?, ?)', name, type, extra.emails || null, extra.terms ?? null).lastInsertRowid);

test('copy keeps parties and lane, not B/L numbers or dates; move takes the new master\'s carrier leg', () => {
  const cust = party('COPY BUYER', 'customer');
  const m1 = M.create({ mode: 'FCL', mbl_no: 'MAEU100000001', vessel: 'VESSEL ONE', eta: '2026-10-10', pod: 'LONG BEACH, CA' });
  const m2 = M.create({ mode: 'FCL', mbl_no: 'MAEU200000002', vessel: 'VESSEL TWO', eta: '2026-10-20', pod: 'LOS ANGELES, CA' });
  const id = S.create({ mode: 'FCL', status: 'ARRIVED', master_id: m1, hbl_no: 'COPY-H1', customer_id: cust, shipper_name: 'SAMPLE FACTORY', delivery_address: '100 W SAMPLE AVE' });
  const nid = FT.copy(id);
  const c = S.find(nid, null);
  assert.deepEqual([c.customer_id, c.shipper_name, c.delivery_address, c.status], [cust, 'SAMPLE FACTORY', '100 W SAMPLE AVE', 'BOOKED']);
  assert.equal(c.hbl_no, null); assert.equal(c.master_id, null); assert.equal(c.eta, null);
  FT.move(id, m2);
  const s = S.find(id, null);
  assert.deepEqual([s.master_id, s.mbl_no, s.vessel, s.eta, s.pod], [m2, 'MAEU200000002', 'VESSEL TWO', '2026-10-20', 'LOS ANGELES, CA']);
  assert.ok(db.get("SELECT 1 FROM events WHERE shipment_id = ? AND type = 'MOVED'", id));
});

test('header badges: COD terms and overdue invoices of the bill-to party', () => {
  const c = party('COD BUYER', 'customer', { terms: 0 });
  const id = S.create({ mode: 'FCL', status: 'BOOKED', customer_id: c });
  A.saveInvoice({ kind: 'AR', company_id: c, invoice_date: '2026-08-01', due_date: '2026-08-01', lines: [{ description: 'Freight', amount: 500 }] });
  const b = FT.badges(S.find(id, null), { today: '2026-10-01' });
  assert.deepEqual(b.map((x) => x.label), ['COD', 'Over due']);
  assert.equal(b[1].amount, 500);
});

test('block stops edits until unblocked; memos; tools on the page', async () => {
  const get = await admin();
  const id = S.create({ mode: 'FCL', status: 'BOOKED', hbl_no: 'BLOCK-H1', vessel: 'KEEP' });
  const csrf = await get.csrf();
  await get.form(`/shipments/${id}/block`, { _csrf: csrf, on: '1', reason: 'bad credit' });
  const page = await (await get(`/shipments/${id}`)).text();
  assert.match(page, /On hold — file blocked<\/b>: bad credit/);
  assert.match(page, /Tools ▾/);
  await get.form(`/shipments/${id}`, { _csrf: csrf, vessel: 'CHANGED' });
  assert.equal(S.find(id, null).vessel, 'KEEP');
  await get.form(`/shipments/${id}/block`, { _csrf: csrf, on: '0' });
  await get.form(`/shipments/${id}`, { _csrf: csrf, vessel: 'CHANGED' });
  assert.equal(S.find(id, null).vessel, 'CHANGED');
  await get.form(`/shipments/${id}/memos`, { _csrf: csrf, subject: 'Friday delivery', body: 'Customer asked for Friday AM' });
  assert.match(await (await get(`/shipments/${id}`)).text(), /Friday delivery/);
});

test('send window: recipients, BCC, ticked attachments; A/N marks the file', async () => {
  const get = await admin();
  const broker = party('SAMPLE BROKER', 'broker', { emails: 'ops@broker.example' });
  const id = S.create({ mode: 'FCL', status: 'ARRIVED', hbl_no: 'MAIL-H1', mbl_no: 'MAEU300000003', broker_id: broker, eta: '2026-10-05' });
  const doc = Number(db.run("INSERT INTO documents (shipment_id, doc_type, filename, stored_path, mime) VALUES (?, 'HBL', 'HBL.pdf', ?, 'application/pdf')", id, __filename).lastInsertRowid);
  const page = await (await get(`/shipments/${id}/email/AN`)).text();
  assert.match(page, /ops@broker\.example/);
  assert.match(page, new RegExp(`name="doc_ids" value="${doc}" checked`), 'latest HBL pre-ticked');
  const csrf = await get.csrf();
  const r = await get.form(`/shipments/${id}/email/AN?_csrf=${csrf}`, { _csrf: csrf, to: 'ops@broker.example, Second@Broker.example', cc: '', bcc: 'boss@gblogix.example', subject: 'A/N test', html: '<p>Hello</p>', doc_ids: String(doc) });
  assert.equal(r.status, 302);
  const e = db.get('SELECT * FROM emails WHERE shipment_id = ? ORDER BY id DESC', id);
  assert.equal(e.to_addr, 'ops@broker.example, second@broker.example');
  assert.equal(e.bcc_addr, 'boss@gblogix.example');
  assert.deepEqual(JSON.parse(e.attachments_json).map((a) => a.filename), ['HBL.pdf']);
  assert.ok(S.find(id, null).an_sent_at);
  assert.equal((await get(`/shipments/${id}/doc/AN`)).status, 200);
});

test('master page shows house cards', async () => {
  const get = await admin();
  const mid = M.create({ mode: 'FCL', mbl_no: 'MAEU400000004' });
  S.create({ mode: 'FCL', status: 'BOOKED', master_id: mid, hbl_no: 'CARD-H1', shipper_name: 'CARD SHIPPER' });
  const page = await (await get(`/masters/${mid}`)).text();
  assert.match(page, /class="hcard c0"/);
  assert.match(page, /CARD-H1/);
});
