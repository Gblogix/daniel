// Carrier from SCAC / AWB prefix; pick-up location and delivery details from past files (names / numbers made up).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gbl-af-'));
const store = require('../src/db');
store.db = store.open(':memory:');
const S = require('../src/shipments');
const M = require('../src/masters');
const AF = require('../src/autofill');
const { mergeExtractions } = require('../src/extract/index');
const db = store.db;

const party = (name, type) => Number(db.run('INSERT INTO companies (name, type) VALUES (?, ?)', name, type).lastInsertRowid);

test('carrier / airline from the SCAC, the AWB prefix, the container owner — and a prefix learned from a past file', () => {
  assert.equal(AF.carrierFor({ mode: 'FCL', mbl_no: 'HDMUPUSA1234567' }).carrier, 'HMM');
  assert.equal(AF.carrierFor({ mode: 'AIR', mbl_no: '180-12345675' }).carrier, 'Korean Air');
  assert.equal(AF.carrierFor({ mode: 'FCL', mbl_no: '261234567', containers: [{ container_no: 'MSKU1234565' }] }).carrier, 'Maersk');
  assert.equal(AF.carrierFor({ mode: 'FCL', mbl_no: 'QQQQ00012345' }), null);
  S.create({ mode: 'FCL', status: 'BOOKED', mbl_no: 'QQQQ00012345', carrier: 'Sample Lines' });
  assert.equal(AF.carrierFor({ mode: 'FCL', mbl_no: 'QQQQ99999999' }).carrier, 'Sample Lines');
  S.create({ mode: 'AIR', status: 'BOOKED', mbl_no: '999-00000011', carrier: 'Air China' });
  const d = mergeExtractions([{ doc_type: 'MBL', mbl_no: 'ONEYSELA00001', containers: [], items: [], warnings: [] }]);
  assert.equal(d.carrier, 'ONE');
  assert.equal(d.scac, 'ONEY');
  const mid = M.create({ mode: 'AIR', mbl_no: '988-11112222' });
  assert.equal(M.get(mid).carrier, 'Asiana');
});

test('pick-up location from the last file with the same carrier + port; delivery from the customer\'s last file', () => {
  const cust = party('HARBOR TRADE INC', 'customer');
  const wh = party('HARBOR WAREHOUSE', 'delivery');
  const truck = party('SAMPLE TRUCKING', 'trucker');
  S.create({ mode: 'AIR', status: 'DELIVERED', mbl_no: '350-10000001', pod: 'LOS ANGELES, CA', customer_id: cust, eta: '2026-08-01',
    cfs_location: 'SAMPLE CARGO TERMINAL LAX', firms_code: 'WZZ1', freight_location_tel: '310-555-0100',
    delivery_company_id: wh, delivery_address: '100 W SAMPLE AVE FULLERTON, CA 92833', trucker_id: truck });
  // Different airline, same port → no pick-up location; delivery still from the customer.
  const other = S.find(S.create({ mode: 'AIR', status: 'BOOKED', mbl_no: '180-10000002', pod: 'LOS ANGELES,CA U.S.A.', customer_id: cust }), null);
  assert.equal(other.carrier, 'Korean Air');
  assert.equal(other.cfs_location, null);
  assert.equal(other.delivery_address, '100 W SAMPLE AVE FULLERTON, CA 92833');
  assert.equal(other.delivery_company_id, wh);
  assert.equal(other.trucker_id, truck);
  // Same airline + port, new consignee (no customer yet) → pick-up filled, delivery not.
  const id = S.create({ mode: 'AIR', status: 'BOOKED', mbl_no: '350-10000003', pod: 'LOS ANGELES,CA U.S.A.', consignee_name: 'NEW BUYER LLC', delivery_address: 'typed address' });
  const s = S.find(id, null);
  assert.equal(s.carrier, 'Air Premia');
  assert.equal(s.cfs_location, 'SAMPLE CARGO TERMINAL LAX');
  assert.equal(s.firms_code, 'WZZ1');
  assert.equal(s.delivery_address, 'typed address', 'typed values stay');
  assert.ok(db.get("SELECT 1 FROM events WHERE shipment_id = ? AND type = 'AUTOFILL'", id));
  // Customer set later → the customer's delivery details come in then (only empty fields).
  S.update(id, { customer_id: cust });
  const s2 = S.find(id, null);
  assert.equal(s2.delivery_address, 'typed address');
  assert.equal(s2.delivery_company_id, wh);
  // Consignee name alone is enough when the customer is not linked.
  const sug = AF.suggest({ mode: 'FCL', consignee_name: 'Harbor Trade, Inc', pod: 'LONG BEACH' });
  assert.equal(sug.fills.delivery_address, undefined, 'no past file carries that consignee name yet');
  db.run("UPDATE shipments SET consignee_name = 'HARBOR TRADE INC' WHERE delivery_company_id = ?", wh);
  assert.equal(AF.suggest({ mode: 'FCL', consignee_name: 'Harbor Trade Inc.' }).fills.delivery_company_id, wh);
});

test('LCL pick-up (CFS) follows the co-loader agent + port', () => {
  const ag = party('SAMPLE CONSOL KOREA', 'agent');
  S.create({ mode: 'LCL', status: 'DELIVERED', agent_id: ag, pod: 'LONG BEACH, CA', cfs_location: 'SAMPLE CFS CARSON', firms_code: 'Y123' });
  assert.equal(AF.suggest({ mode: 'LCL', agent_id: ag, pod: 'LONG BEACH' }).fills.cfs_location, 'SAMPLE CFS CARSON');
  assert.equal(AF.suggest({ mode: 'LCL', agent_id: ag, pod: 'OAKLAND' }).fills.cfs_location, undefined);
  assert.equal(AF.suggest({ mode: 'LCL', pod: 'LONG BEACH' }).fills.cfs_location, undefined);
});
