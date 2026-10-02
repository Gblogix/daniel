// Side-by-side review: create a file from an upload, or update an existing one with only the ticked fields.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gbl-side-'));
const store = require('../src/db');
store.db = store.open(':memory:');
test.after(() => require('../src/docs/pdf').close());
require('../src/seed').seedDemo(store.db);
const db = store.db;
const S = require('../src/shipments');
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

const intake = (draft, shipmentId = null) => {
  const id = Number(db.run("INSERT INTO intakes (status, extracted_json, shipment_id) VALUES ('PENDING', ?, ?)", JSON.stringify({ draft }), shipmentId).lastInsertRowid);
  db.run("INSERT INTO documents (intake_id, doc_type, filename, stored_path, mime, source, extracted_json) VALUES (?, 'HBL', 'HBL_SAMPLE.pdf', ?, 'application/pdf', 'upload', ?)", id, __filename, JSON.stringify({ ...draft, doc_type: 'HBL' }));
  return id;
};

test('hub tabs and side-by-side page', async () => {
  const get = await admin();
  const iid = intake({ mode: 'FCL', hbl_no: 'SIDE-H1', mbl_no: 'MAEU000222333', vessel: 'SAMPLE VESSEL', eta: '2026-10-20', containers: [{ container_no: 'MSKU1234565' }] });
  const hub = await (await get('/intakes')).text();
  assert.match(hub, /Document hub/);
  assert.match(hub, new RegExp(`/intakes/${iid}/side`));
  const page = await (await get(`/intakes/${iid}/side`)).text();
  assert.match(page, /Audit MB\/L/);
  assert.match(page, /Create new shipment/);
  const csrf = await get.csrf();
  const r = await get.form(`/intakes/${iid}/side`, { _csrf: csrf, target: 'new', u_mode: 'FCL', u_hbl_no: 'SIDE-H1', u_vessel: 'SAMPLE VESSEL', u_eta: '2026-10-20' });
  assert.equal(r.status, 302);
  const s = db.get("SELECT * FROM shipments WHERE hbl_no = 'SIDE-H1'");
  assert.equal(s.vessel, 'SAMPLE VESSEL');
  assert.equal(db.get('SELECT COUNT(*) AS n FROM containers WHERE shipment_id = ?', s.id).n, 1, 'containers from the document');
  assert.equal(db.get('SELECT status FROM intakes WHERE id = ?', iid).status, 'APPLIED');
});

test('update existing: only ticked fields change; current vs extracted shown', async () => {
  const get = await admin();
  const sid = S.create({ mode: 'FCL', status: 'BOOKED', hbl_no: 'SIDE-H2', vessel: 'OLD VESSEL', eta: '2026-10-10', commodity: 'COSMETICS' });
  const iid = intake({ mode: 'FCL', hbl_no: 'SIDE-H2', vessel: 'NEW VESSEL', eta: '2026-10-15', commodity: 'SKIN CARE' }, sid);
  const page = await (await get(`/intakes/${iid}/side`)).text();
  assert.match(page, /Current data/);
  assert.match(page, /OLD VESSEL/);
  assert.match(page, /name="use_vessel" value="1" checked/, 'changed fields are pre-ticked');
  const csrf = await get.csrf();
  await get.form(`/intakes/${iid}/side`, { _csrf: csrf, target: String(sid), u_vessel: 'NEW VESSEL', use_eta: '1', u_eta: '2026-10-15', u_commodity: 'SKIN CARE' });
  const s = S.find(sid, null);
  assert.equal(s.eta, '2026-10-15');
  assert.equal(s.vessel, 'OLD VESSEL', 'not ticked → unchanged');
  assert.equal(s.commodity, 'COSMETICS');
  assert.equal(db.get('SELECT shipment_id FROM documents WHERE intake_id = ?', iid).shipment_id, sid);
});

test('reading feedback is kept', async () => {
  const get = await admin();
  const iid = intake({ mode: 'FCL', hbl_no: 'SIDE-H3' });
  await get.form(`/intakes/${iid}/feedback`, { _csrf: await get.csrf(), good: '0', note: 'POL read as POD' });
  assert.deepEqual(db.get('SELECT feedback, feedback_note FROM intakes WHERE id = ?', iid), { feedback: 0, feedback_note: 'POL read as POD' });
});
