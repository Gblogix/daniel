// Master B/L → house B/Ls (OPUS OIM / OIH): enter the master first, add houses under it; carrier leg shared.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gbl-mst-'));
const store = require('../src/db');
store.db = store.open(':memory:');
const S = require('../src/shipments');
const M = require('../src/masters');
const db = store.db;

test('master first, houses added under it get the carrier leg; master changes reach every house', () => {
  const mid = M.create({ mode: 'FCL', mbl_no: 'maeu 277099556', carrier: 'Maersk', vessel: 'MAERSK CAP JACKSON', voyage: '638E', etd: '2026-09-28', eta: '2026-10-12', pol: 'BUSAN, KOREA', pod: 'LONG BEACH, CA' });
  const m = M.get(mid);
  assert.match(m.ref_no, /^GBL-OM\d{5}$/);
  assert.equal(m.mbl_no, 'MAEU277099556');
  const h1 = S.create({ mode: 'FCL', status: 'BOOKED', master_id: mid, hbl_no: 'NSCLGB26090028' });
  const h2 = S.create({ mode: 'FCL', status: 'BOOKED', hbl_no: 'NSCLGB26090029', mbl_no: 'MAEU277099556' });
  for (const id of [h1, h2]) {
    const s = S.find(id, null);
    assert.equal(s.master_id, mid);
    assert.deepEqual([s.mbl_no, s.vessel, s.eta, s.pod], ['MAEU277099556', 'MAERSK CAP JACKSON', '2026-10-12', 'LONG BEACH, CA']);
  }
  assert.equal(M.get(mid).houses.length, 2);
  const r = M.update(mid, { eta: '2026-10-14', vessel: 'MAERSK CAP JACKSON' });
  assert.deepEqual(r.changed, ['eta']);
  assert.equal(S.find(h1, null).eta, '2026-10-14');
  assert.equal(S.find(h2, null).eta, '2026-10-14');
  assert.ok(r.houses.every((h) => h.changes.some((c) => c.field === 'eta')), 'house changes reported (customer ETA mails)');
});

test('a house from documents creates its master; the next one with the same MB/L joins it; air masters', () => {
  const a = S.create({ mode: 'FCL', status: 'BOOKED', mbl_no: 'HDMUPUSA1234567', carrier: 'HMM', eta: '2026-10-20', hbl_no: 'H1' });
  const ma = S.find(a, null).master_id;
  assert.ok(ma);
  assert.equal(M.get(ma).eta, '2026-10-20', 'master learns from its first house');
  const b = S.create({ mode: 'FCL', status: 'BOOKED', mbl_no: 'HDMU-PUSA1234567', hbl_no: 'H2' });
  assert.equal(S.find(b, null).master_id, ma);
  const air = S.create({ mode: 'AIR', status: 'BOOKED', mbl_no: '350-35125134', hbl_no: 'NSCXA2610002' });
  assert.match(M.get(S.find(air, null).master_id).ref_no, /^GBL-AM\d{5}$/);
  const other = S.create({ mode: 'OTHER', title: 'Office' });
  assert.equal(S.find(other, null).master_id, null);
});

test('back-fill links older files; required fields per mode', () => {
  const id = Number(db.run("INSERT INTO shipments (ref_no, mode, status, mbl_no) VALUES ('OI-1', 'FCL', 'BOOKED', 'ONEYSELA0098812')").lastInsertRowid);
  assert.equal(M.backfill(), 1);
  assert.ok(S.find(id, null).master_id);
  assert.deepEqual(S.missingRequired({ mode: 'AIR', mbl_no: '350-1', hbl_no: 'X' }), ['Customer', 'Carrier / Airline', 'Arrival date (ETA)', 'Departure', 'Destination']);
  assert.deepEqual(S.missingRequired({ mode: 'FCL', mbl_no: 'M', customer_id: 1, pol: 'A', pod: 'B', etd: 'x', eta: 'y', carrier: 'c', direct_shipment: 1 }), []);
  assert.deepEqual(M.missing({ mbl_no: 'M', carrier: 'C' }), ['ETD', 'ETA', 'POL', 'POD']);
});

test('upload plan: MB/L only → master; several HB/Ls → a house each, P/L by HB/L or invoice no.', () => {
  const P = require('../src/intakePlan');
  const doc = (id, type, ex) => ({ id, doc_type: type, filename: `${type}${id}.pdf`, extracted_json: JSON.stringify(ex) });
  const mbl = doc(1, 'MBL', { mbl_no: 'MAEU1', carrier: 'Maersk', eta: '2026-10-12', containers: [{ container_no: 'MNBU4117750' }] });
  assert.equal(P.plan([mbl]).kind, 'master');
  assert.equal(P.plan([mbl, doc(2, 'HBL', { hbl_no: 'NSCLGB1' })]).kind, 'single');
  const p = P.plan([mbl,
    doc(2, 'HBL', { hbl_no: 'NSCLGB1', invoice_refs: ['EZVC_TGT_26-09'], consignee_name: 'A' }),
    doc(3, 'HBL', { hbl_no: 'NSCLGB2', invoice_refs: ['BSBUS26091601'], consignee_name: 'B' }),
    doc(4, 'PL', { ci_invoice_no: 'BSBUS26091601', items: [{ description: 'Cream', invoice_no: 'BSBUS26091601' }] }),
    doc(5, 'ISF', { hbl_no: 'NSCLGB1' }),
    doc(6, 'CI', { ci_invoice_no: 'UNKNOWN-1' })]);
  assert.equal(p.kind, 'multi');
  assert.deepEqual(p.houses.map((h) => [h.hbl, h.docIds]), [['NSCLGB1', [2, 5]], ['NSCLGB2', [3, 4]]]);
  assert.deepEqual(p.unassigned, [6]);
  assert.equal(p.houses[1].draft.items.length, 1);
  assert.equal(p.houses[0].draft.mbl_no, 'MAEU1', 'house drafts carry the master leg');
  const air = P.plan([doc(7, 'AWB', { mawb_no: '350-35125134', mbl_no: '350-35125134' })]);
  assert.equal(air.kind, 'master');
});

test('a house B/L without MB/L no. finds its master by container', () => {
  const mid = M.fromDraft({ mode: 'FCL', mbl_no: 'MAEU277000777', eta: '2026-10-12', containers: [{ container_no: 'TGHU1234567' }] });
  const id = S.create({ mode: 'FCL', status: 'BOOKED', hbl_no: 'NSCLGB26099991' });
  S.saveLines(id, { ctn_no: ['TGHU1234567'] });
  const s = S.find(id, null);
  assert.equal(s.master_id, mid);
  assert.equal(s.mbl_no, 'MAEU277000777');
  assert.equal(s.eta, '2026-10-12');
});

test('lists run in ETA order: next arrival first, no ETA last; history latest first', () => {
  const admin = { id: 1, role: 'admin' };
  const ids = [['2026-12-05', 'ZZ-LATE'], [null, 'ZZ-NOETA'], ['2026-11-02', 'ZZ-SOON'], ['2026-11-20', 'ZZ-MID']]
    .map(([eta, hbl]) => S.create({ mode: 'LCL', status: 'BOOKED', eta, hbl_no: hbl }));
  const order = (opts) => S.list(admin, { q: 'ZZ-', ...opts }).map((s) => s.hbl_no);
  assert.deepEqual(order({ stage: 'open' }), ['ZZ-SOON', 'ZZ-MID', 'ZZ-LATE', 'ZZ-NOETA']);
  assert.deepEqual(order({ stage: 'open', sort: 'desc' }), ['ZZ-LATE', 'ZZ-MID', 'ZZ-SOON', 'ZZ-NOETA']);
  db.run("UPDATE shipments SET closed_at = datetime('now') WHERE id IN (?, ?)", ids[0], ids[2]);
  assert.deepEqual(order({ stage: 'closed' }), ['ZZ-LATE', 'ZZ-SOON']);
  const etas = M.list().map((m) => m.eta).filter(Boolean);
  assert.deepEqual(etas, [...etas].sort());
});

test('MB/L / MAWB dropped on the master page: saved there, empty fields filled, carrier leg goes to the houses', async () => {
  const store = require('../src/db'); const db = store.db;
  const M = require('../src/masters'); const S = require('../src/shipments');
  if (!db.get("SELECT 1 FROM users WHERE email = 'admin@gblogix.com'")) require('../src/seed').bootstrap(db);
  const mid = M.create({ mode: 'FCL', mbl_no: 'MAEU299999991' });
  const hid = S.create({ mode: 'FCL', hbl_no: 'UPLOAD-H1', master_id: mid, mbl_no: 'MAEU299999991' });
  const { createApp } = require('../src/server');
  const server = createApp().listen(0); await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    let cookie = '';
    const keep = (res) => { const c = res.headers.getSetCookie?.() || []; if (c.length) cookie = c.map((x) => x.split(';')[0]).join('; '); return res; };
    let tok = /name="_csrf" value="([^"]+)"/.exec(await keep(await fetch(`${base}/login`)).text())[1];
    keep(await fetch(`${base}/login`, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: tok, email: 'admin@gblogix.com', password: 'changeme123' }) }));
    const page = await (await fetch(`${base}/masters/${mid}`, { headers: { cookie } })).text();
    assert.match(page, /Upload the MB\/L/);
    tok = /name="_csrf" value="([^"]+)"/.exec(page)[1];
    const fd = new FormData();
    fd.append('files', new Blob(['BILL OF LADING\nB/L No. MAEU299999991\nVESSEL / VOYAGE: SAMPLE EXPRESS 123E\nPORT OF LOADING  NINGBO, CHINA\nPORT OF DISCHARGE  LONG BEACH, CA\n']), 'mbl.txt');
    const r = await fetch(`${base}/masters/${mid}/documents?_csrf=${tok}`, { method: 'POST', body: fd, redirect: 'manual', headers: { cookie } });
    assert.equal(r.headers.get('location'), `/masters/${mid}`);
    assert.equal(db.get('SELECT COUNT(*) AS n FROM documents WHERE master_id = ?', mid).n, 1);
    const m = db.get('SELECT * FROM masters WHERE id = ?', mid);
    assert.ok(m.pol || m.pod || m.vessel, 'something was read from the MB/L');
    if (m.pod) assert.equal(S.find(hid, null).pod, m.pod, 'house got the carrier leg');
  } finally { server.close(); }
});

test('upload lines MAWB / HAWB: one master + one house each, even when the waybill numbers alone are unclear', () => {
  const P = require('../src/intakePlan');
  const doc = (id, ex) => ({ id, doc_type: 'AWB', extracted_json: JSON.stringify(ex) });
  // As put on the MAWB line (number read into hbl_no by the reader) and two HAWB lines.
  const p = P.plan([
    doc(1, { doc_type: 'AWB', doc_role: 'master', mawb_no: '350-11111111', mbl_no: '350-11111111' }),
    doc(2, { doc_type: 'AWB', doc_role: 'house', hawb_no: 'TESTXA0000001', hbl_no: 'TESTXA0000001', mbl_no: '350-11111111' }),
    doc(3, { doc_type: 'AWB', doc_role: 'house', hawb_no: 'TESTXA0000002', hbl_no: 'TESTXA0000002', mbl_no: '350-11111111' }),
  ]);
  assert.equal(p.kind, 'multi');
  assert.deepEqual(p.houses.map((h) => h.hbl), ['TESTXA0000001', 'TESTXA0000002']);
  assert.deepEqual(p.masterDocs, [1]);
  // Only the MAWB → a master, no house.
  assert.equal(P.plan([doc(1, { doc_type: 'AWB', doc_role: 'master', mawb_no: '350-11111111', mbl_no: '350-11111111' })]).kind, 'master');
});
