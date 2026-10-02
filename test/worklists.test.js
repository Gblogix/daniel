// 12 stages, My Containers, list quick edits and bulk actions.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gbl-wl-'));
const store = require('../src/db');
store.db = store.open(':memory:');
test.after(() => require('../src/docs/pdf').close());
require('../src/seed').seedDemo(store.db);
const db = store.db;
const S = require('../src/shipments');
const ST = require('../src/stages');
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
  get.json = (p, body, csrf) => fetch(base + p, { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify(body) });
  get.csrf = async () => /name="_csrf" value="([^"]+)"/.exec(await (await get('/intakes')).text())[1];
  return get;
}

test('12 stages for FCL; air and LCL have no empty return', () => {
  const s = { mode: 'FCL', status: 'ARRIVED', atd: '2026-09-01', etd: '2026-09-01', eta: '2026-09-20', ata: '2026-09-21', pickup_appt: null };
  const c = { discharged_at: '2026-09-22', pickup_lfd: '2026-09-26' };
  const st = ST.stages(s, c);
  assert.equal(st.total, 12);
  assert.deepEqual(st.list.map((x) => x.label), ['Gate in', 'ETD', 'ETA', 'ATA', 'Unloaded from vessel', 'LFD', 'Appointment', 'Gate out', 'ETA door', 'ATA door', 'Empty returned', 'Complete']);
  assert.equal(st.current, 'LFD'); assert.equal(st.n, 6); assert.equal(st.next, 'Appointment');
  assert.equal(ST.stages({ ...s, mode: 'AIR' }).total, 10);
  assert.equal(ST.stages({ ...s, mode: 'LCL' }).total, 11);
  assert.equal(ST.flags(s, { ...c, pickup_lfd: '2020-01-01' }).overdue, true);
  assert.equal(ST.flags(s, c).toPickUp, true);
});

test('My Containers lists open containers with tabs; notes stick after the file is saved again', async () => {
  const get = await admin();
  const id = S.create({ mode: 'FCL', status: 'ARRIVED', hbl_no: 'WL-H1', eta: '2026-09-20', ata: '2026-09-21' });
  S.saveLines(id, { ctn_no: ['MSKU1234565'], ctn_size: ['40HC'], ctn_lfd: ['2020-01-01'] });
  const page = await (await get('/containers?tab=overdue')).text();
  assert.match(page, /MSKU1234565/);
  const cid = db.get('SELECT id FROM containers WHERE shipment_id = ?', id).id;
  const csrf = await get.csrf();
  assert.equal((await get.json(`/quick/containers/${cid}`, { remark: 'driver booked', color_label: 'urgent' }, csrf)).status, 200);
  S.saveLines(id, { ctn_no: ['MSKU1234565'], ctn_size: ['40HC'] });
  assert.deepEqual(db.get('SELECT remark, color_label FROM containers WHERE shipment_id = ?', id), { remark: 'driver booked', color_label: 'urgent' });
  assert.equal((await get('/containers.xlsx')).status, 200);
});

test('House B/L list: inline note, flag, bulk change OP and block', async () => {
  const get = await admin();
  const a = S.create({ mode: 'FCL', status: 'BOOKED', hbl_no: 'WL-A' });
  const b = S.create({ mode: 'FCL', status: 'BOOKED', hbl_no: 'WL-B' });
  const csrf = await get.csrf();
  await get.json(`/quick/shipments/${a}`, { internal_note: 'check daily', flagged: true }, csrf);
  assert.deepEqual(db.get('SELECT internal_note, flagged FROM shipments WHERE id = ?', a), { internal_note: 'check daily', flagged: 1 });
  const staff = db.get("SELECT id FROM users WHERE role = 'staff' LIMIT 1").id;
  const body = new URLSearchParams({ _csrf: csrf, action: 'owner', owner_id: String(staff), back: '/shipments' }); body.append('ids', a); body.append('ids', b);
  await get.form('/bulk/shipments', body);
  assert.equal(S.find(b, null).owner_id, staff);
  const blk = new URLSearchParams({ _csrf: csrf, action: 'block', reason: 'bad credit' }); blk.append('ids', b);
  await get.form('/bulk/shipments', blk);
  assert.ok(S.find(b, null).blocked_at);
  const list = await (await get('/shipments?q=WL-')).text();
  assert.match(list, /check daily/);
  assert.match(list, /container\(s\) to pick up/);
  assert.match(list, /Journey/);
});
