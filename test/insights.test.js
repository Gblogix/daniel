// Management dashboard numbers (names / numbers made up).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gbl-ins-'));
const store = require('../src/db');
store.db = store.open(':memory:');
const db = store.db;
const S = require('../src/shipments');
const A = require('../src/accounting');
const I = require('../src/insights');

const party = (name, type = 'customer') => Number(db.run('INSERT INTO companies (name, type) VALUES (?, ?)', name, type).lastInsertRowid);
const file = (customer, eta, revenue, cost, extra = {}) => {
  const id = S.create({ mode: 'FCL', status: 'BOOKED', customer_id: customer, eta, ...extra });
  if (revenue) A.saveInvoice({ kind: 'AR', company_id: customer, shipment_id: id, invoice_date: eta, lines: [{ description: 'Ocean freight', amount: revenue }] });
  if (cost) A.saveInvoice({ kind: 'AP', number: `C-${id}`, company_id: vendor, shipment_id: id, invoice_date: eta, lines: [{ description: 'Trucking', amount: cost }] });
  return id;
};
const vendor = party('SAMPLE TRUCKING', 'trucker');
const now = new Date('2026-10-01T12:00:00Z');

test('period: default last 60 days vs the 60 days before; Y/Y = same dates last year', () => {
  assert.deepEqual(I.period({}, now), { from: '2026-08-03', to: '2026-10-01', cmp: 'mm', prev: { from: '2026-06-04', to: '2026-08-02' } });
  assert.deepEqual(I.period({ from: '2026-09-01', to: '2026-09-30', cmp: 'yy' }, now).prev, { from: '2025-09-01', to: '2025-09-30' });
  assert.deepEqual(I.period({ from: '2026-09-01', to: '2026-09-30' }, now).prev, { from: '2026-08-02', to: '2026-08-31' });
});

test('profit, volume, active / lost customers, top 5, negative files', () => {
  const big = party('HARBOR TRADE INC');
  const small = party('MAPLE COSMETICS');
  const gone = party('OLD BUYER LLC');
  const oneOff = party('ONE OFF CO');
  file(big, '2026-09-10', 3000, 1000);
  file(big, '2026-09-20', 1500, 500);
  const loss = file(small, '2026-09-15', 400, 900, { hbl_no: 'H-LOSS' });
  file(null, '2026-09-18', 0, 0);
  file(gone, '2026-07-01', 800, 300); // previous period only, no file since → lost
  file(oneOff, '2026-06-20', 100, 50);
  const d = I.dashboard({}, { now });
  const k = Object.fromEntries(d.kpi.map((x) => [x.key, x]));
  assert.equal(k.profit.value, 2500); // 2000 + 1000 - 500
  assert.equal(k.volume.value, 4);
  assert.equal(k.active.value, 2);
  assert.equal(k.profit.prev, 550);
  assert.equal(k.lost.value, 2);
  assert.equal(d.noCustomer, 1);
  assert.deepEqual(d.topProfit.rows.map((r) => [r.name, r.value]), [['HARBOR TRADE INC', 3000], ['MAPLE COSMETICS', -500]]);
  assert.deepEqual(d.topVolume.rows.map((r) => [r.name, r.value, r.share]), [['HARBOR TRADE INC', 2, 66.7], ['MAPLE COSMETICS', 1, 33.3]]);
  assert.deepEqual(d.negative.rows.map((r) => [r.id, r.profit]), [[loss, -500]]);
  // Ignore: the one-off customer and the explained loss drop out.
  db.run('UPDATE companies SET lost_ignored = 1 WHERE id = ?', oneOff);
  assert.deepEqual(I.lostCustomers('2026-10-01').map((r) => r.name), ['OLD BUYER LLC']);
  assert.equal(I.lostCustomers('2026-10-01', { view: 'ignored' })[0].name, 'ONE OFF CO');
  assert.equal(I.lostCustomers('2026-10-01')[0].days, 92);
  db.run("UPDATE shipments SET profit_ignore = 1, profit_remark = 'free storage' WHERE id = ?", loss);
  const p = I.period({}, now);
  assert.equal(I.negative(p).rows.length, 0);
  assert.equal(I.negative(p, { status: 'ignored' }).rows[0].profit_remark, 'free storage');
});

test('negative by master B/L sums the houses', () => {
  const c = party('CONSOL BUYER');
  const mid = require('../src/masters').create({ mode: 'FCL', mbl_no: 'MAEU000111222', eta: '2026-09-25' });
  file(c, '2026-09-25', 500, 300, { master_id: mid, hbl_no: 'H1' });
  file(c, '2026-09-25', 200, 700, { master_id: mid, hbl_no: 'H2' });
  const p = I.period({}, now);
  const byM = I.negative(p, { by: 'mbl' }).rows.find((r) => r.master_id === mid);
  assert.equal(byM.profit, -300);
  assert.deepEqual(byM.hbls.sort(), ['H1', 'H2']);
  assert.equal(I.negative(p, { by: 'hbl' }).rows.filter((r) => r.master_id === mid).length, 1);
});
