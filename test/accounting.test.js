const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gbl-acc-'));
const store = require('../src/db');
test.after(() => require('../src/docs/pdf').close());
store.db = store.open(':memory:');
const db = store.db;
const A = require('../src/accounting');
const S = require('../src/shipments');
const { seedDemo } = require('../src/seed');
const ids = seedDemo(db);
const nsc = Number(db.run("INSERT INTO companies (name, type, address, emails) VALUES ('NATIONAL SHIPPING CO., LTD', 'agent', '12TH FLOOR, SAM JUNG BLDG\nSEOUL', 'import@nsc.example')").lastInsertRowid);

test('nested transactions roll back only the inner part', () => {
  db.tx(() => {
    db.setSetting('x_outer', '1');
    try { db.tx(() => { db.setSetting('x_inner', '1'); throw new Error('boom'); }); } catch { /* expected */ }
  });
  assert.equal(db.setting('x_outer'), '1');
  assert.equal(db.setting('x_inner'), undefined);
});

test('AR invoice: numbering, terms -> due date, totals from rate x qty', () => {
  const s = S.list({ role: 'staff' }).find((x) => x.mbl_no === 'HDMUPUSA1234567');
  const id = A.saveInvoice({ kind: 'AR', shipment_id: s.id, company_id: ids.unlockt, invoice_date: '2026-09-11', terms_days: 25,
    lines: [{ description: 'Ocean freight', rate: '8,100', qty: 3 }, { description: 'THC', rate: 210, qty: 3 }, { description: 'Handling charge', amount: 65 }, { description: '' }] });
  const inv = A.getInvoice(id);
  assert.equal(inv.number, 'GBL-INV10001');
  assert.equal(inv.due_date, '2026-10-06');
  assert.equal(inv.total, 24995);
  assert.equal(inv.lines.length, 3);
  assert.equal(inv.lines[0].description, 'OCEAN FREIGHT');
  assert.match(inv.bill_to, /UNLOCKT BRANDS, INC\n14251 FIRESTONE/);
});

test('D/N: debit minus credit; negative balance is a credit note', () => {
  const dn = A.getInvoice(A.saveInvoice({ kind: 'DN', company_id: nsc, agent_ref: 'NSCLGB26080025', lines: [
    { description: 'Customs clearance fee', amount: 450 }, { description: 'Duties', amount: 31498.63 }, { description: 'Trucking charge', rate: 580, qty: 2 },
    { description: 'Ocean freight collected', amount: 1000, side: 'CREDIT' }] }));
  assert.equal(dn.number, 'GBL-DN10001');
  assert.equal(dn.total, 32108.63);
  assert.equal(dn.terms_days, 0);
  const cn = A.getInvoice(A.saveInvoice({ kind: 'DN', company_id: nsc, lines: [{ description: 'Profit share', amount: 120, side: 'CREDIT' }] }));
  assert.equal(cn.total, -120);
});

test('lump-sum payment is applied oldest due first; partial leaves invoice open', () => {
  const a = A.saveInvoice({ kind: 'AR', company_id: ids.heyhae, invoice_date: '2026-08-01', terms_days: 0, lines: [{ description: 'Air freight', amount: 1000 }] });
  const b = A.saveInvoice({ kind: 'AR', company_id: ids.heyhae, invoice_date: '2026-09-01', terms_days: 0, lines: [{ description: 'Air freight', amount: 500 }] });
  const r = A.recordPayment({ company_id: ids.heyhae, direction: 'IN', amount: 1200, method: 'ACH', reference: 'Mercury' });
  assert.equal(r.unapplied, 0);
  assert.equal(A.getInvoice(a).status, 'PAID');
  const ib = A.getInvoice(b);
  assert.equal(ib.status, 'OPEN');
  assert.equal(ib.paid_amount, 200);
  assert.equal(ib.balance, 300);
  const aging = A.arAging({ asOf: '2026-10-15' });
  const h = aging.find((g) => g.company_id === ids.heyhae);
  assert.equal(h.total, 300);
  assert.equal(h.d60, 300); // due 9/1, 44 days past due on 10/15
});

test('agent SOA netting: settle selected items, carry the rest forward', () => {
  const dn1 = A.saveInvoice({ kind: 'DN', company_id: nsc, lines: [{ description: 'Trucking charge', amount: 272.6 }] });
  const ap = A.saveInvoice({ kind: 'AP', company_id: nsc, number: 'NSC-SOA-0920', lines: [{ description: 'Ocean freight prepaid', amount: 1000 }] });
  const before = A.agentStatement(nsc);
  assert.equal(before.net, round(32108.63 - 120 + 272.6 - 1000));
  const r = A.settleNetting({ company_id: nsc, invoice_ids: [dn1, ap], reference: 'WIRE 9/25' });
  assert.equal(r.net, -727.4); // we pay NSC the difference
  assert.equal(A.getInvoice(dn1).status, 'PAID');
  assert.equal(A.getInvoice(ap).status, 'PAID');
  const after = A.agentStatement(nsc);
  assert.equal(after.items.length, 2); // the big D/N and the credit note carried forward
  assert.equal(after.net, round(32108.63 - 120));
});

test('shipment profit: AR revenue minus AP cost', () => {
  const s = S.list({ role: 'staff' }).find((x) => x.mbl_no === 'HDMUPUSA1234567');
  A.saveInvoice({ kind: 'AP', shipment_id: s.id, company_id: ids.ctc, number: 'CTC-7781', lines: [{ description: 'Trucking', amount: 1740 }] });
  const p = A.shipmentProfit(s.id);
  assert.deepEqual(p, { revenue: 24995, cost: 1740, profit: 23255, margin: 93 });
});

function round(v) { return Math.round(v * 100) / 100; }

test('blank terms on the form fall back to the customer default (Unlockt 25 days)', () => {
  const inv = A.getInvoice(A.saveInvoice({ kind: 'AR', company_id: ids.unlockt, invoice_date: '2026-09-11', terms_days: '', due_date: '', lines: [{ description: 'X', amount: 1 }] }));
  assert.equal(inv.terms_days, 25);
  assert.equal(inv.due_date, '2026-10-06');
  const pgp = A.getInvoice(A.saveInvoice({ kind: 'AR', company_id: ids.pgp, invoice_date: '2026-09-11', terms_days: '', lines: [{ description: 'X', amount: 1 }] }));
  assert.equal(pgp.terms_days, 0);
});

test('pay on account: offset D/Ns first, apply cash oldest-first, keep excess on account for the next bill', () => {
  const agent = Number(db.run("INSERT INTO companies (name, type) VALUES ('AGENT X', 'agent')").lastInsertRowid);
  const dn = A.saveInvoice({ kind: 'DN', company_id: agent, invoice_date: '2026-08-05', lines: [{ description: 'Trucking', amount: 300 }] });
  const ap1 = A.saveInvoice({ kind: 'AP', company_id: agent, number: 'X-1', invoice_date: '2026-08-10', lines: [{ description: 'Ocean freight prepaid', amount: 1000 }] });
  const ap2 = A.saveInvoice({ kind: 'AP', company_id: agent, number: 'X-2', invoice_date: '2026-09-02', lines: [{ description: 'Ocean freight prepaid', amount: 2000 }] });
  let soa = A.agentStatement(agent);
  assert.equal(soa.net, -2700);
  assert.deepEqual(soa.months.map((g) => [g.month, g.net, g.guideline]), [['2026-08', -700, '2026-09-15'], ['2026-09', -2000, '2026-10-15']]);
  const r = A.payOnAccount({ company_id: agent, direction: 'OUT', amount: 3000, netFirst: true });
  assert.equal(r.netting, 300);
  assert.equal(r.unapplied, 300); // 700 + 2000 owed after netting; 300 left on account
  assert.equal(A.getInvoice(dn).status, 'PAID');
  assert.equal(A.getInvoice(ap1).status, 'PAID');
  assert.equal(A.getInvoice(ap2).status, 'PAID');
  soa = A.agentStatement(agent);
  assert.equal(soa.paidOnAccount, 300);
  assert.equal(soa.net, 300); // prepaid: agent owes us back / credit on account
  // the next agent bill consumes the on-account money automatically
  const ap3 = A.saveInvoice({ kind: 'AP', company_id: agent, number: 'X-3', invoice_date: '2026-09-20', lines: [{ description: 'Ocean freight prepaid', amount: 500 }] });
  assert.equal(A.getInvoice(ap3).paid_amount, 300);
  soa = A.agentStatement(agent);
  assert.equal(soa.paidOnAccount, 0);
  assert.equal(soa.net, -200);
});

test('GBL numbering: A/R, debit and credit notes each run their own counter; a used number is skipped', () => {
  const company = require('../src/company');
  const db = require('../src/db').db;
  const party = db.get("SELECT id FROM companies WHERE type = 'agent'").id;
  const cn = A.getInvoice(A.saveInvoice({ kind: 'DN', company_id: party, lines: [{ description: 'PROFIT SHARE', amount: 100, side: 'CREDIT' }] }));
  assert.match(cn.number, /^GBL-CN\d{5}$/);
  const next = Number(db.setting('seq_G_INV'));
  db.run("INSERT INTO invoices (number, kind, total, invoice_date) VALUES (?, 'AR', 1, '2026-09-29')", `GBL-INV${next}`);
  assert.equal(company.nextRef('INV', { db, table: 'invoices', column: 'number' }), `GBL-INV${next + 1}`);
});
