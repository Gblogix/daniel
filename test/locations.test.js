// Pick-up locations ↔ FIRMS codes: learned from files, found by name or code (made-up places and codes).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gbl-loc-'));
const store = require('../src/db');
store.db = store.open(':memory:');
const S = require('../src/shipments');
const L = require('../src/locations');

test('a saved file teaches the location; name or FIRMS code finds it', () => {
  const id = S.create({ mode: 'FCL', hbl_no: 'LOC-1', cfs_location: 'Sample Harbor Terminal', firms_code: 'x901', cfs_address: '1 Pier Rd, San Pedro, CA' });
  assert.equal(L.search('X90')[0].name, 'Sample Harbor Terminal');
  assert.equal(L.search('harbor')[0].firms_code, 'X901');
  S.update(id, { freight_location_tel: '310-555-0100' });
  const r = L.search('Sample Harbor Terminal')[0];
  assert.equal(r.tel, '310-555-0100');
  assert.equal(r.address, '1 Pier Rd, San Pedro, CA');
  S.create({ mode: 'AIR', hbl_no: 'LOC-2', cfs_location: 'Sample Air Cargo Warehouse', firms_code: 'X777' });
  assert.equal(L.search('sample', { mode: 'AIR' })[0].name, 'Sample Air Cargo Warehouse', 'air places first on an air file');
  assert.equal(L.search('sample', { mode: 'FCL' })[0].name, 'Sample Harbor Terminal');
});

test('edit, add by hand, remove; backfill learns old files once', () => {
  L.save(0, { name: 'Hand Added CFS', firms_code: ' y 123 ', mode: 'OCEAN' });
  const h = L.search('Y123')[0];
  assert.equal(h.name, 'Hand Added CFS');
  L.save(h.id, { name: 'Hand Added CFS', firms_code: 'Y124' });
  assert.equal(L.search('Y124')[0].id, h.id);
  L.remove(h.id);
  assert.equal(L.search('Hand Added').length, 0);
  store.db.run("INSERT INTO shipments (ref_no, mode, cfs_location, firms_code) VALUES ('OLD-1', 'LCL', 'Old Files CFS', 'Z555')");
  assert.ok(L.backfill() >= 1);
  assert.equal(L.search('Z555')[0].name, 'Old Files CFS');
});
