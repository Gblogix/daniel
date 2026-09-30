// Debit / credit notes with agents: read, sides from the issuer's view, book on the agent D/N account.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gbl-dn-'));
const store = require('../src/db');
store.db = store.open(':memory:');
const { seedDemo } = require('../src/seed');
const { parseNote, isNote, creditSubset } = require('../src/extract/debitNote');
const V = require('../src/vendorbills');
const A = require('../src/accounting');
seedDemo(store.db);
const db = store.db;
const agents = [{ id: 9, name: 'NATIONAL SHIPPING CO., LTD (국민해운)', short_name: 'NSC' }];
const own = 'GLOBALBRIDGE LOGISTICS';

const OURS = `GLOBALBRIDGE LOGISTICS  DEBIT NOTE
1661 N. RAYMOND AVE., SUITE 140F, ANAHEIM, CA 92801
EMAIL: info@gblogix.com  D/C No. : DCN-11664
AGENT :  NATIONAL SHIPPING CO., LTD (국민해운)  D/C DATE  Sep-30-2026
AGENT FILING NO.  :  NSCLGB26090028  KGS / LBS  :  11,840.00
M/H  BL NO  DESCRIPTION  UNIT  RATE  QTY REV/COST P/C  DEBIT(+)  CREDIT(-)
M KMHB2409001  TRUCKING CHARGE  650.00  C  650.00
M  HANDLING CHARGE  65.00  C  65.00
M  PROFIT SHARE  200.00  C  200.00
TOTAL  715.00  200.00
GRAND TOTAL BALANCE DUE TO GLOBALBRIDGE LOGISTICS  USD  515.00`;

const THEIRS = `NATIONAL SHIPPING CO., LTD
SEOUL, KOREA
DEBIT NOTE
TO: GLOBALBRIDGE LOGISTICS
DEBIT NOTE NO.: NSCDN2609-0012   DATE: 2026-09-28
HOUSE B/L NO.: KMHB2409001
DESCRIPTION  AMOUNT
OCEAN FREIGHT  1,800.00
THC  320.00
PROFIT SHARE  150.00
TOTAL  2,120.00  150.00
BALANCE DUE TO NATIONAL SHIPPING CO., LTD  USD 1,970.00`;

test('recognised as a note; our D/N: debit lines owed by the agent, profit share credited', () => {
  assert.ok(isNote(OURS) && isNote(THEIRS));
  assert.ok(!isNote('PACIFIC CFS INC\nINVOICE\nINVOICE NO: 1'));
  const r = parseNote(OURS, { companies: agents, ownName: own });
  assert.deepEqual([r.kind, r.issuer, r.number, r.date, r.agent_ref, r.party.id, r.total], ['DN', 'us', 'DCN-11664', '2026-09-30', 'NSCLGB26090028', 9, 515]);
  assert.deepEqual(r.lines.map((l) => [l.description, l.bl_no, l.amount, l.side]),
    [['TRUCKING CHARGE', 'KMHB2409001', 650, 'DEBIT'], ['HANDLING CHARGE', null, 65, 'DEBIT'], ['PROFIT SHARE', null, 200, 'CREDIT']]);
  assert.deepEqual(r.warnings, []);
});

test("the agent's D/N flips: their charges are what we owe; the balance check agrees", () => {
  const r = parseNote(THEIRS, { companies: agents, ownName: own });
  assert.deepEqual([r.issuer, r.number, r.total], ['them', 'NSCDN2609-0012', -1970]);
  assert.deepEqual(r.lines.map((l) => l.side), ['CREDIT', 'CREDIT', 'DEBIT']);
  assert.deepEqual(r.warnings, []);
});

test('credit lines found from the credit total even without wording', () => {
  const lines = [{ description: 'A', amount: 100 }, { description: 'B', amount: 40 }, { description: 'C', amount: 60 }];
  assert.deepEqual(creditSubset(lines, 100).sort(), [0]);
  assert.deepEqual(creditSubset(lines, 60).sort(), [2]);
  assert.equal(creditSubset(lines, 7), null);
});

test('uploaded agent D/N → matched to the file by B/L → booked on the D/N account with its own number', async () => {
  const s = db.get("SELECT id, hbl_no FROM shipments WHERE hbl_no = 'KMHB2409001'");
  const nsc = db.get("SELECT id FROM companies WHERE short_name = 'NSC'").id;
  const id = await V.receive({ buffer: Buffer.from(THEIRS), filename: 'NSC DN.txt', mime: 'text/plain' });
  const d = V.get(id);
  assert.equal(d.ex.doc_kind, 'DN');
  assert.equal(d.ex.vendor.id, nsc);
  assert.equal(d.shipment_id, s.id);
  const inv = A.getInvoice(V.book(id, { kind: 'DN', company_id: nsc, shipment_id: s.id, number: d.ex.number, invoice_date: d.ex.invoice_date, lines: d.ex.lines }));
  assert.deepEqual([inv.kind, inv.number, inv.total], ['DN', 'NSCDN2609-0012', -1970]);
  assert.deepEqual(inv.lines.map((l) => l.side), ['CREDIT', 'CREDIT', 'DEBIT']);
});
