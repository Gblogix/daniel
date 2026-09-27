const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gbl-ss-'));
process.env.SMARTSHEET_TOKEN = 'sstoken';
const store = require('../src/db');
store.db = store.open(':memory:');
test.after(() => require('../src/docs/pdf').close());
test.after(() => require('../src/extract/pdf').shutdownOcr());
const db = store.db;
const S = require('../src/shipments');
const ss = require('../src/smartsheet');
const { seedDemo } = require('../src/seed');
seedDemo(db);

const C = (id, title) => ({ id, title });
const UNLOCKT = {
  id: 821, name: 'Unlockt - GlobalBridge',
  columns: [C(1, 'Detail'), C(2, 'MBL'), C(3, 'HBL'), C(4, 'Container'), C(5, 'SSL'), C(6, 'Deliver to:'), C(7, 'ETD'), C(8, 'ETA'),
    C(9, 'Delivery Date'), C(10, 'ISF'), C(11, 'Custom'), C(12, 'UB Remarks'), C(13, 'Column3'), C(14, 'Column4'), C(15, 'Shipping Mode')],
  rows: [
    { id: 100, cells: [{ columnId: 1, value: 'Aug Shipment_2026' }] },
    { id: 101, cells: [{ columnId: 1, value: 'ABW (INV#: 260708_G003), 16 PLT_1 X 40RH' }, { columnId: 2, value: 'MAEU275376573' }, { columnId: 3, value: 'NSCLGB26080029' },
      { columnId: 4, value: 'MNBU4555192' }, { columnId: 5, value: 'MSK' }, { columnId: 6, value: 'Dolly' }, { columnId: 7, value: '8/13' }, { columnId: 8, value: '9/2 > 8/29' },
      { columnId: 9, value: '9/2' }, { columnId: 10, value: true }, { columnId: 11, value: true }, { columnId: 13, value: 'USD 136,288.80' }, { columnId: 14, value: '16 PLT' }, { columnId: 15, value: 'Ship' }],
      attachments: [{ id: 9001, name: 'PL_HC-2410-07.xlsx', attachmentType: 'FILE', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }] },
    // consol: parent + brand rows repeating MBL / HBL
    { id: 102, cells: [{ columnId: 1, value: 'UB CONSOL_MEDICUBE, SEORIN (40 HC x 1, 20 GP x 1)' }, { columnId: 2, value: 'MAEU268831119' }, { columnId: 3, value: 'NSCLGB26030009' },
      { columnId: 4, value: 'BEAU5909967 (40) & DFSU1983345 (20)' }, { columnId: 8, value: '3/28' }] },
    { id: 103, cells: [{ columnId: 1, value: 'SEORIN (INV#: UB-SR-20260312_TGT), 22 PLT' }, { columnId: 2, value: 'MAEU268831119' }, { columnId: 3, value: 'NSCLGB26030009' }, { columnId: 4, value: 'BEAU5909967' }] },
    { id: 104, cells: [{ columnId: 1, value: 'MEDICUBE (INV#: CI-UN-260301), 12 PLT' }, { columnId: 2, value: 'MAEU268831119' }, { columnId: 3, value: 'NSCLGB26030009' }, { columnId: 4, value: 'DFSU1983345' }] },
    // LCL co-load, both house numbers
    { id: 105, cells: [{ columnId: 1, value: 'ALTHEA - The Pure Lab (INV#: UB001-2-1), 1 PLT' }, { columnId: 2, value: 'HDMUPUSM65859700' }, { columnId: 3, value: 'NSCLGB26080015 // ESSASEL26080617' },
      { columnId: 4, value: 'KOCU4569012' }, { columnId: 8, value: '8/28 > 8/24' }] },
    // air
    { id: 106, cells: [{ columnId: 1, value: 'ABW (INV#: 260414_G003), 2 PLT, AIR' }, { columnId: 2, value: '180-20247975' }, { columnId: 3, value: 'NSCXA2604028' }, { columnId: 4, value: '-' },
      { columnId: 7, value: '4/20' }, { columnId: 8, value: '4/19' }, { columnId: 15, value: 'Air' }] },
    // pre-booking placeholders -> skipped
    { id: 107, cells: [{ columnId: 1, value: '[NSC] MEDICUBE (INV#: CI-UN-260909-SEA-1-A), 240 PLT_12 X 40HQ' }, { columnId: 2, value: 'REF; SEE BELOW' }, { columnId: 3, value: 'REF; SEE BELOW' }, { columnId: 4, value: 'REF; SEE BELOW' }] },
    { id: 108, cells: [{ columnId: 1, value: '[NSC] MEDICUBE, 60 PLT (OUT OF 240 PLT)' }, { columnId: 2, value: 'BKG#: 277088965' }, { columnId: 3, value: 'TBD' }, { columnId: 4, value: 'TBD' }] },
  ],
};
const DELIVERY = {
  id: 202, name: 'Delivery Status_Unlockt',
  columns: [C(21, 'Container #'), C(22, 'Terminal'), C(23, 'Available'), C(24, 'Delivery Date'), C(25, 'Delivery Time'), C(26, 'Delivered'), C(27, 'LFD')],
  rows: [
    { id: 301, cells: [{ columnId: 21, value: 'MNBU4555192' }, { columnId: 22, value: 'LBCT' }, { columnId: 23, value: true }, { columnId: 24, value: '9/1, 11:00 AM' }, { columnId: 26, value: true }, { columnId: 27, value: '9/3' }] },
    { id: 302, cells: [{ columnId: 21, value: 'KOCU4569012' }, { columnId: 22, value: 'SSA' }, { columnId: 24, value: 'ETA 10/6' }] },
    { id: 303, cells: [{ columnId: 21, value: 'Done' }] },
  ],
};
const MARKETING = { id: 999, name: 'Marketing Tracker', columns: [], rows: [] };

function mockFetch() {
  const calls = [];
  const pl = fs.readFileSync(path.join(__dirname, 'fixtures', 'PL_HC-2410-07.xlsx'));
  const json = (body) => ({ ok: true, status: 200, json: async () => body, arrayBuffer: async () => Buffer.from(JSON.stringify(body)) });
  const fn = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET', opts });
    if (url.startsWith('https://s3.example/pl')) return { ok: true, status: 200, arrayBuffer: async () => pl.buffer.slice(pl.byteOffset, pl.byteOffset + pl.length) };
    assert.equal(opts.headers.Authorization, 'Bearer sstoken');
    const p = url.replace('https://api.smartsheet.com/2.0', '');
    if (p === '/sheets?includeAll=true') return json({ data: [UNLOCKT, DELIVERY, MARKETING].map(({ id, name }) => ({ id, name })) });
    if (p === '/sheets/821?include=attachments') return json(UNLOCKT);
    if (p === '/sheets/202?include=attachments') return json(DELIVERY);
    if (p === '/sheets/821/attachments/9001') return json({ id: 9001, name: 'PL_HC-2410-07.xlsx', url: 'https://s3.example/pl', urlExpiresInMillis: 60000 });
    return { ok: false, status: 404, json: async () => ({ message: `no route ${p}` }) };
  };
  fn.calls = calls;
  return fn;
}

test('sheet parsing helpers', () => {
  assert.equal(ss.sheetDate('9/2 > 8/29', new Date(Date.UTC(2026, 7, 15))), '2026-08-29');
  assert.equal(ss.sheetDate('1/5', new Date(Date.UTC(2026, 11, 20))), '2027-01-05');
  assert.equal(ss.sheetDate('REF; SEE BELOW'), null);
  assert.deepEqual(ss.splitHouse('NSCLGB26070035 // ESSASEL26071573'), { hbl_no: 'ESSASEL26071573', sub_bl_no: 'NSCLGB26070035', agent_ref: 'NSCLGB26070035' });
  assert.equal(ss.parseDetail('[NSC] MEDICUBE (INV#: CI-UN-260909-SEA-1-A), 240 PLT_12 X 40HQ').pallets, 240);
});

test('sync: discovers sheets, imports shipments, consol rows, attachments, delivery status; idempotent; read-only', async () => {
  const f = mockFetch();
  ss.setFetch(f);
  const r1 = await ss.syncAll();
  for (const r of r1) assert.equal(r.error, undefined, r.error);
  assert.deepEqual(r1.map((r) => [r.sheet, r.created, r.skipped]), [['Unlockt - GlobalBridge', 4, 3], ['Delivery Status_Unlockt', 0, 1]]);
  assert.ok(!f.calls.some((c) => c.url.includes('/sheets/999')), 'Marketing Tracker is not read');
  assert.ok(f.calls.every((c) => c.method === 'GET'), 'no writes to Smartsheet');

  const fcl = S.find(db.get("SELECT id FROM shipments WHERE mbl_no = 'MAEU275376573'").id);
  assert.equal(fcl.hbl_no, 'NSCLGB26080029');
  assert.equal(fcl.agent_ref, 'NSCLGB26080029');
  assert.equal(fcl.eta, '2026-08-29');
  assert.equal(fcl.etd, '2026-08-13');
  assert.equal(fcl.isf_filed, 1);
  assert.equal(fcl.cargo_value, 136288.8);
  assert.equal(fcl.pallets, 16);
  assert.equal(fcl.containers[0].size_type, '40RH');
  assert.match(fcl.customer_name, /UNLOCKT/);
  // P/L attachment downloaded, extracted, lines replace the placeholder
  const docs = db.all('SELECT * FROM documents WHERE shipment_id = ?', fcl.id);
  assert.equal(docs.length, 1);
  assert.equal(docs[0].doc_type, 'PL');
  assert.deepEqual(fcl.items.map((i) => i.description), ['Hydrating Toner 200ml', 'Vitamin C Serum 30ml', 'Sheet Mask (10pk)']);
  // delivery status sheet: terminal, LFD, delivered
  assert.equal(fcl.devan_location, 'LBCT');
  assert.equal(fcl.delivery_date, '2026-09-01');
  assert.equal(fcl.delivery_time, '11:00 AM');
  assert.equal(fcl.status, 'DELIVERED');

  const consol = S.find(db.get("SELECT id FROM shipments WHERE mbl_no = 'MAEU268831119'").id);
  assert.deepEqual(consol.containers.map((c) => c.container_no).sort(), ['BEAU5909967', 'DFSU1983345']);
  assert.deepEqual(consol.items.map((i) => [i.description, i.po_no, i.quantity]).sort(), [['MEDICUBE', 'CI-UN-260301', 12], ['SEORIN', 'UB-SR-20260312_TGT', 22], ['UB CONSOL_MEDICUBE', null, null]].sort());

  const lcl = S.find(db.get("SELECT id FROM shipments WHERE mbl_no = 'HDMUPUSM65859700'").id);
  assert.deepEqual([lcl.mode, lcl.hbl_no, lcl.sub_bl_no, lcl.eta], ['LCL', 'ESSASEL26080617', 'NSCLGB26080015', '2026-08-24']);
  const air = S.find(db.get("SELECT id FROM shipments WHERE mbl_no = '180-20247975'").id);
  assert.deepEqual([air.mode, air.hbl_no, air.containers.length], ['AIR', 'NSCXA2604028', 0]);

  // second run: nothing new, attachment not downloaded again
  const before = db.get('SELECT COUNT(*) AS n FROM shipments').n;
  f.calls.length = 0;
  await ss.syncAll();
  assert.equal(db.get('SELECT COUNT(*) AS n FROM shipments').n, before);
  assert.ok(!f.calls.some((c) => c.url.includes('/attachments/9001')));
});
