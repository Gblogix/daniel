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
