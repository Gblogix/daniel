// "Other" files: hold invoices that belong to no shipment, with their own A/R, A/P and profit.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gbl-misc-'));
const store = require('../src/db');
store.db = store.open(':memory:');
const { seedDemo } = require('../src/seed');
const S = require('../src/shipments');
const A = require('../src/accounting');
const F = require('../src/followups');
seedDemo(store.db);
const db = store.db;
const co = (name) => db.get('SELECT id FROM companies WHERE name LIKE ?', `%${name}%`).id;
const admin = db.get("SELECT * FROM users WHERE role = 'admin'");

test('an Other file gets an OTH number, its own name, A/R + A/P + profit, and stays off the tracking boards', () => {
  const id = S.create({ mode: 'OTHER', title: 'Unlockt — warehouse storage', customer_id: co('UNLOCKT') }, { userId: admin.id });
  const s = S.find(id, null);
  assert.match(s.ref_no, /^OTH\d{7}$/);
  assert.equal(S.fileName(s), 'Unlockt — warehouse storage');
  assert.equal(S.fileName({ mode: 'OTHER', customer_name: 'UNLOCKT BRANDS, INC', ref_no: 'OTH1' }), 'UNLOCKT BRANDS');

  A.saveInvoice({ kind: 'AR', shipment_id: id, company_id: co('UNLOCKT'), lines: [{ description: 'STORAGE SEP', amount: 1200 }] });
  A.saveInvoice({ kind: 'AP', shipment_id: id, company_id: co('CTC'), number: 'WH-77', lines: [{ description: 'WAREHOUSE RENT', amount: 800 }] });
  assert.deepEqual(A.shipmentProfit(id), { revenue: 1200, cost: 800, profit: 400, margin: 33.3 });
  const row = A.profitReport({}).rows.find((r) => r.id === id);
  assert.equal(S.fileName(row), 'Unlockt — warehouse storage');

  const staff = { role: 'staff' };
  assert.ok(S.list(staff, { stage: 'open' }).some((x) => x.id === id), 'in the file list');
  assert.ok(S.list(staff, { mode: 'OTHER' }).some((x) => x.id === id));
  assert.ok(!S.list(staff, { active: true }).some((x) => x.id === id), 'not on the tracking board');
  assert.ok(!S.list({ role: 'customer', company_id: co('UNLOCKT') }).some((x) => x.id === id), 'not in the customer portal');
  const items = F.forUser(admin).filter((i) => i.shipment_id === id);
  assert.ok(items.length && items.every((i) => i.area === 'acct'), 'only accounting follow-ups (review / send the invoice) — no shipping follow-ups (ISF, A/N, D/O…)');
});

test('the customer of an Other file is picked from its name, and the first A/R fills it in', () => {
  const id = S.create({ mode: 'OTHER', title: 'Annual Bond - Unlockt Brands' });
  const s = S.find(id, null);
  assert.equal(S.guessCustomer(s), co('UNLOCKT'));
  assert.equal(S.guessCustomer({ mode: 'OTHER', title: 'Office rent' }), null);
  A.saveInvoice({ kind: 'AR', shipment_id: id, company_id: co('UNLOCKT'), lines: [{ description: 'ANNUAL BOND', amount: 450 }] });
  assert.equal(S.find(id, null).customer_id, co('UNLOCKT'));
});
