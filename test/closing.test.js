// File name, per-file P/L, checkbox settlement, closing files into history, and the "start fresh" reset.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gbl-close-'));
const store = require('../src/db');
store.db = store.open(':memory:');
const { seedDemo } = require('../src/seed');
const S = require('../src/shipments');
const A = require('../src/accounting');
const ids = seedDemo(store.db);
const db = store.db;
const staff = { role: 'staff' };
const get = (mbl) => S.list(staff).find((x) => x.mbl_no === mbl);

test('file name: shipper without legal suffix + container, AWB for air, file no. as fallback', () => {
  assert.equal(S.shortParty('Hanil Cosmetics Co., Ltd.'), 'HANIL COSMETICS');
  assert.equal(S.shortParty('MTWO IMPORT AND EXPORT CO'), 'MTWO');
  assert.equal(S.fileName(get('HDMUPUSA1234567')), 'HANIL COSMETICS · TCLU1234567');
  assert.equal(S.fileName(get('921-63150570')), 'SHENZHEN YOUYUE TECHNOLOGY · 921-63150570');
  assert.equal(S.fileName({ ref_no: 'OI-11900' }), 'OI-11900');
  const s = get('HDMUPUSA1234567');
  db.run("INSERT INTO containers (shipment_id, container_no) VALUES (?, 'TCLU7654321')", s.id);
  assert.equal(S.fileName(get('HDMUPUSA1234567')), 'HANIL COSMETICS · TCLU1234567 +1');
  assert.ok(S.list(staff, { q: 'TCLU7654321' }).some((x) => x.id === s.id));
});

test('P/L per file, line by line: AR + D/N debit = revenue; vendor bills + D/N credit = cost', () => {
  const s = get('CMDUSHZ8105615');
  A.saveInvoice({ kind: 'AR', shipment_id: s.id, company_id: ids.leepop, lines: [{ description: 'OCEAN FREIGHT', amount: 3000 }, { description: 'D/O FEE', amount: 100 }] });
  A.saveInvoice({ kind: 'AP', shipment_id: s.id, company_id: ids.ctc, number: 'CTC-9001', lines: [{ description: 'TRUCKING CHARGE', amount: 650 }, { description: 'CHASSIS', rate: 45, qty: 2 }] });
  A.saveInvoice({ kind: 'DN', shipment_id: s.id, company_id: ids.zhejiang, lines: [{ description: 'HANDLING', amount: 300 }, { description: 'PROFIT SHARE', amount: 200, side: 'CREDIT' }] });
  assert.deepEqual(A.shipmentProfit(s.id), { revenue: 3400, cost: 940, profit: 2460, margin: 72.4 });
  assert.equal(A.shipmentLines(s.id).length, 6);
  const rep = A.profitReport({ customerId: ids.leepop });
  assert.equal(rep.rows.find((r) => r.id === s.id).profit, 2460);
});

test('billing state, checkbox settlement and closing the file into history', () => {
  const s = get('CMDUSHZ8105615');
  assert.equal(S.billingState(get('CMDUSHZ8105615')).code, 'unsent');
  S.update(s.id, { status: 'DELIVERED' });
  assert.equal(S.list(staff, { stage: 'delivered' }).some((x) => x.id === s.id), true);

  // Vendor: check two lines of the CTC bill → one OUT payment for exactly that bill.
  const ctc = A.openItems(ids.ctc);
  const bill = ctc.payable.find((i) => i.number === 'CTC-9001');
  assert.equal(bill.lines.length, 2);
  const r = A.settleSelected({ company_id: ids.ctc, items: [{ invoice_id: bill.id, amount: '' }], method: 'ACH' });
  assert.deepEqual(r, { direction: 'OUT', amount: 740, netted: 0 });
  assert.equal(A.getInvoice(bill.id).status, 'PAID');

  // Customer pays part → still open; pays the rest → file closes automatically.
  const ar = A.openItems(ids.leepop).receivable.find((i) => i.shipment_id === s.id);
  A.settleSelected({ company_id: ids.leepop, items: [{ invoice_id: ar.id, amount: '1000' }] });
  assert.equal(S.billingState(get('CMDUSHZ8105615')).code, 'unsent');
  db.run("UPDATE invoices SET sent_at = datetime('now') WHERE shipment_id = ?", s.id);
  assert.match(S.billingState(get('CMDUSHZ8105615')).code, /awaiting|overdue/);
  A.settleSelected({ company_id: ids.leepop, items: [{ invoice_id: ar.id }] });
  // D/N to the agent is still open → not closed yet.
  assert.equal(get('CMDUSHZ8105615').closed_at, null);
  const dn = A.openItems(ids.zhejiang).receivable.find((i) => i.shipment_id === s.id);
  A.settleSelected({ company_id: ids.zhejiang, items: [{ invoice_id: dn.id }] });
  const closed = S.list(staff, { stage: 'closed' }).find((x) => x.id === s.id);
  assert.ok(closed?.closed_at, 'file closed after all receivables paid');
  assert.equal(S.stage(closed), 'closed');
  assert.ok(!S.list(staff, { stage: 'delivered' }).some((x) => x.id === s.id));
  assert.ok(!S.list(staff, { active: true }).some((x) => x.id === s.id));

  // Everything paid (vendor bill too) → the file locked itself: no new invoice until an admin unlocks it.
  const L = require('../src/locks');
  assert.ok(L.isLocked(s.id), 'locked once all invoices and bills are paid');
  assert.throws(() => A.saveInvoice({ kind: 'AR', shipment_id: s.id, company_id: ids.leepop, lines: [{ description: 'X', amount: 1 }] }), { code: 'LOCKED' });
  L.unlock(s.id, { userId: 1, reason: 'storage billed late' });

  // A new invoice on the file reopens it; voiding it closes it again.
  const extra = A.saveInvoice({ kind: 'AR', shipment_id: s.id, company_id: ids.leepop, lines: [{ description: 'STORAGE CHARGE', amount: 80 }] });
  assert.equal(S.list(staff, { stage: 'closed' }).some((x) => x.id === s.id), false);
  A.voidInvoice(extra);
  assert.equal(S.list(staff, { stage: 'closed' }).some((x) => x.id === s.id), true);
});

test('delivered without invoice is flagged; manual close / reopen', () => {
  const s = get('921-63150570');
  S.update(s.id, { status: 'DELIVERED' });
  assert.equal(S.billingState(get('921-63150570')).code, 'not_invoiced');
  S.setClosed(s.id, true, { userId: 1 });
  assert.equal(S.stage(S.find(s.id, null)), 'closed');
  S.refreshClosed(s.id); // manual close is not undone automatically
  assert.ok(S.find(s.id, null).closed_at);
  S.setClosed(s.id, false);
  assert.equal(S.find(s.id, null).closed_at, null);
});

test('netting when both sides are checked (agent owes a D/N, we owe a bill)', () => {
  const agent = Number(db.run("INSERT INTO companies (name, type) VALUES ('AGENT NET', 'agent')").lastInsertRowid);
  const dn = A.saveInvoice({ kind: 'DN', company_id: agent, lines: [{ description: 'X', amount: 500 }] });
  const ap = A.saveInvoice({ kind: 'AP', company_id: agent, number: 'AG-1', lines: [{ description: 'Y', amount: 200 }] });
  const r = A.settleSelected({ company_id: agent, items: [{ invoice_id: dn }, { invoice_id: ap }] });
  assert.deepEqual(r, { direction: 'IN', amount: 300, netted: 200 });
  assert.equal(A.getInvoice(dn).status, 'PAID');
  assert.equal(A.getInvoice(ap).status, 'PAID');
});

test('start fresh: removes shipments, invoices and demo logins; keeps admin and parties', () => {
  const adminId = db.get("SELECT id FROM users WHERE role = 'admin'")?.id
    ?? Number(db.run("INSERT INTO users (email, name, role, password_hash) VALUES ('admin@gblogix.com', 'Admin', 'admin', 'x')").lastInsertRowid);
  const parties = db.get('SELECT COUNT(*) AS n FROM companies').n;
  const r = require('../src/reset').clearData({ keepUserId: adminId });
  assert.ok(r.shipments >= 5 && r.users >= 5);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM shipments').n, 0);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM invoices').n, 0);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM users WHERE email LIKE '%.example'").n, 0);
  assert.ok(db.get('SELECT 1 FROM users WHERE id = ?', adminId));
  assert.equal(db.get('SELECT COUNT(*) AS n FROM companies').n, parties);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM companies WHERE emails LIKE '%.example%'").n, 0);
});
