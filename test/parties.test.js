// New customers / vendors read from documents: B/L boxes, invoice letterhead, one-click add, no duplicates.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gbl-party-'));
const store = require('../src/db');
store.db = store.open(':memory:');
const { seedDemo } = require('../src/seed');
const P = require('../src/extract/party');
const { extractRules } = require('../src/extract/rules');
seedDemo(store.db);
const db = store.db;
const own = { ownName: 'GlobalBridge Logistics', ownDomains: ['gblogix.com'] };

const HBL = `BILL OF LADING (HOUSE)
SHIPPER
HANIL COSMETICS CO., LTD.
123 TEHERAN-RO, SEOUL, KOREA
CONSIGNEE
BRIGHT HOME GOODS INC
455 W ALONDRA BLVD
GARDENA, CA 90248
TEL: 310-555-1212
EMAIL: ops@brighthome.com
NOTIFY PARTY
SAME AS CONSIGNEE
B/L NO.: KMHB2410099
PORT OF LOADING: BUSAN, KOREA`;

const CFS = `PACIFIC CFS WAREHOUSE INC.
2250 E CARSON ST, CARSON, CA 90810
TEL: (310) 555-0199  billing@pacificcfs.com
INVOICE
INVOICE NO: PC-55812   DATE: 09/25/2026
BILL TO:
GlobalBridge Logistics
3801 N. Raymond Ave, Anaheim, CA 92801
TOTAL DUE 450.00`;

test('B/L boxes: name, address, email, phone and country; "same as consignee" is not a party', () => {
  const r = P.readParties(HBL, { ...own, db });
  assert.deepEqual(r.map((p) => p.role), ['shipper', 'consignee']);
  const c = r[1];
  assert.equal(c.name, 'BRIGHT HOME GOODS INC');
  assert.equal(c.address, '455 W ALONDRA BLVD\nGARDENA, CA 90248');
  assert.equal(c.email, 'ops@brighthome.com');
  assert.equal(c.phone, '310-555-1212');
  assert.equal(c.country, 'US');
  assert.equal(c.suggest, 'customer');
  assert.equal(c.match, null);
  assert.equal(r[0].country, 'KR');
  const ex = extractRules(HBL);
  assert.equal(ex.consignee_address, '455 W ALONDRA BLVD\nGARDENA, CA 90248', 'addresses reach the intake draft');
});

test('invoice letterhead = the vendor; we are never offered as a party', () => {
  const r = P.readParties(CFS, { ...own, db });
  assert.equal(r.length, 1);
  assert.deepEqual({ ...r[0], match: undefined }, { role: 'letterhead', name: 'PACIFIC CFS WAREHOUSE INC.', address: '2250 E CARSON ST, CARSON, CA 90810',
    email: 'billing@pacificcfs.com', phone: '(310) 555-0199', country: 'US', suggest: 'vendor', match: undefined });
});

test('side-by-side SHIPPER / CONSIGNEE / NOTIFY boxes are split into columns', () => {
  const r = P.readParties('SHIPPER  CONSIGNEE  NOTIFY PARTY\nSHENZHEN YOUYUE TECHNOLOGY  LEEPOP COMPANY LLC  REKO FREIGHT LLC\nMAWB NO.  921-63150570', { ...own, db });
  assert.deepEqual(r.map((p) => [p.role, p.name, p.address]), [['shipper', 'SHENZHEN YOUYUE TECHNOLOGY', null], ['consignee', 'LEEPOP COMPANY LLC', null], ['notify', 'REKO FREIGHT LLC', null]]);
  assert.equal(r[1].match.name, 'LEEPOP Company LLC', 'matched despite case / punctuation');
});

test('matching ignores punctuation and legal suffixes; adding never duplicates', () => {
  assert.equal(P.findParty('UNLOCKT BRANDS INC.', { db }).name, 'UNLOCKT BRANDS, INC');
  assert.equal(P.findParty('Unlockt', { db }).name, 'UNLOCKT BRANDS, INC');
  assert.equal(P.findParty('BRIGHT HOME GOODS', { db }), null);
  const n = db.get('SELECT COUNT(*) AS n FROM companies').n;
  const body = { customer_id: 'new', new_party_name: 'BRIGHT HOME GOODS INC', new_party_address: '455 W ALONDRA BLVD\nGARDENA, CA 90248', new_party_email: 'ops@brighthome.com' };
  assert.equal(P.fromForm(body, 'customer_id', { db }), 'BRIGHT HOME GOODS INC');
  const c = db.get('SELECT * FROM companies WHERE id = ?', Number(body.customer_id));
  assert.deepEqual([c.type, c.country, c.emails, c.billing_emails], ['customer', 'US', 'ops@brighthome.com', 'ops@brighthome.com']);
  const again = { customer_id: 'new', new_party_name: 'Bright Home Goods, Inc.' };
  assert.equal(P.fromForm(again, 'customer_id', { db }), null, 'already there — nothing added');
  assert.equal(Number(again.customer_id), c.id);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM companies').n, n + 1);
  const untouched = { customer_id: '12' };
  assert.equal(P.fromForm(untouched, 'customer_id', { db }), null);
  assert.equal(untouched.customer_id, '12');
});

test('a vendor invoice from an unknown vendor carries the letterhead to add it when booking', async () => {
  const V = require('../src/vendorbills');
  const id = await V.receive({ buffer: Buffer.from(CFS), filename: 'pc.txt', mime: 'text/plain', sender: 'Billing@PacificCFS.com' });
  const d = V.get(id);
  assert.ok(!d.ex.vendor);
  assert.equal(d.ex.vendor_new.name, 'PACIFIC CFS WAREHOUSE INC.');
  assert.equal(d.ex.vendor_new.email, 'billing@pacificcfs.com');
});
