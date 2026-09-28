// Party statements (by invoice date / ETA), aging summary across A/R · D/N · C/N · A/P, review-before-send.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gbl-soa-'));
const store = require('../src/db');
store.db = store.open(':memory:');
test.after(() => require('../src/docs/pdf').close());
const { seedDemo } = require('../src/seed');
const S = require('../src/shipments');
const A = require('../src/accounting');
const I = require('../src/invoicing');
const ids = seedDemo(store.db);
const db = store.db;
const ship = (mbl) => S.list({ role: 'staff' }).find((x) => x.mbl_no === mbl);

let ar1; let ar2; let dn; let cn; let ap;
test('setup: invoices, notes and a vendor bill on two files', () => {
  const a = ship('HDMUPUSA1234567'); const b = ship('CMDUSHZ8105615');
  db.run("UPDATE shipments SET eta = '2026-08-20' WHERE id = ?", a.id);
  db.run("UPDATE shipments SET eta = '2026-09-25' WHERE id = ?", b.id);
  ar1 = A.saveInvoice({ kind: 'AR', shipment_id: a.id, company_id: ids.unlockt, invoice_date: '2026-09-01', terms_days: 0, lines: [{ description: 'OCEAN FREIGHT', amount: 1000 }] });
  ar2 = A.saveInvoice({ kind: 'AR', shipment_id: b.id, company_id: ids.unlockt, invoice_date: '2026-09-20', terms_days: 25, lines: [{ description: 'D/O FEE', amount: 200 }] });
  dn = A.saveInvoice({ kind: 'DN', shipment_id: a.id, company_id: ids.kukmin, invoice_date: '2026-07-01', terms_days: 0, lines: [{ description: 'HANDLING', amount: 500 }] });
  cn = A.saveInvoice({ kind: 'DN', shipment_id: b.id, company_id: ids.kukmin, invoice_date: '2026-09-10', terms_days: 0, lines: [{ description: 'PROFIT SHARE', amount: 300, side: 'CREDIT' }] });
  ap = A.saveInvoice({ kind: 'AP', shipment_id: a.id, company_id: ids.kukmin, number: 'NSC-77', invoice_date: '2026-09-05', terms_days: 0, lines: [{ description: 'O/F', amount: 150 }] });
});

test('statement by invoice date and by ETA, with running balance and aging', () => {
  const all = A.partyStatement(ids.kukmin, { asOf: '2026-09-28' });
  assert.deepEqual(all.items.map((i) => i.number), [A.getInvoice(dn).number, 'NSC-77', A.getInvoice(cn).number]);
  assert.deepEqual(all.totals, { debit: 500, credit: 450, paid: 0, open: 50 });
  assert.equal(all.items.at(-1).running, 50);
  assert.equal(all.aging.d90, 500); // D/N from 7/1 is 89 days past due
  assert.equal(all.aging.d30, -450);
  const sept = A.partyStatement(ids.kukmin, { basis: 'invoice', from: '2026-09-01', to: '2026-09-30' });
  assert.equal(sept.items.length, 2);
  const byEta = A.partyStatement(ids.unlockt, { basis: 'eta', from: '2026-09-01', to: '2026-09-30' });
  assert.deepEqual(byEta.items.map((i) => i.id), [ar2]); // ar1's file arrived in August
  A.settleSelected({ company_id: ids.unlockt, items: [{ invoice_id: ar1 }] });
  assert.equal(A.partyStatement(ids.unlockt).items.length, 1);
  assert.equal(A.partyStatement(ids.unlockt, { status: 'all' }).items.length, 2);
});

test('aging summary: A/R, Debit, Credit, A/P side by side per party, net and buckets', () => {
  const r = A.agingSummary({ asOf: '2026-09-28' });
  const nsc = r.parties.find((g) => g.company_id === ids.kukmin);
  assert.deepEqual({ ar: nsc.ar, debit: nsc.debit, credit: nsc.credit, ap: nsc.ap, net: nsc.net }, { ar: 0, debit: 500, credit: 300, ap: 150, net: 50 });
  assert.equal(nsc.current + nsc.d30 + nsc.d60 + nsc.d90 + nsc.d90p, 50);
  const unl = r.parties.find((g) => g.company_id === ids.unlockt);
  assert.equal(unl.ar, 200);
  assert.equal(unl.current, 200);
  assert.ok(A.agingSummary({ side: 'ap' }).parties.every((g) => g.ap + g.credit > 0));
});

test('statement renders as a document and an Excel workbook', async () => {
  const party = db.get('SELECT * FROM companies WHERE id = ?', ids.kukmin);
  const st = A.partyStatement(ids.kukmin, { asOf: '2026-09-28' });
  const html = I.statementHtml(party, st);
  assert.match(html, /STATEMENT OF ACCOUNT/);
  assert.match(html, /BALANCE DUE TO/);
  const buf = await I.statementWorkbook(party, st);
  assert.ok(buf.length > 1000);
});

test('only reviewed items are emailed; editing clears the review', async () => {
  db.run("UPDATE companies SET billing_emails = 'ap@nsc.example' WHERE id = ?", ids.kukmin);
  let r = await I.send([dn, ap]);
  assert.deepEqual(r.skipped.map((x) => x.reason).sort(), ['not reviewed', 'vendor bill (not sent)']);
  assert.equal(r.sent.length, 0);
  A.setReviewed(dn, true, { userId: 1 });
  r = await I.send([dn]);
  assert.equal(r.sent.length, 1);
  assert.ok(A.getInvoice(dn).sent_at);
  assert.ok(db.get("SELECT 1 FROM emails WHERE kind = 'DEBIT_NOTE' AND to_addr = 'ap@nsc.example'"));
  A.setReviewed(cn, true, { userId: 1 });
  A.saveInvoice({ kind: 'DN', company_id: ids.kukmin, lines: [{ description: 'PROFIT SHARE', amount: 310, side: 'CREDIT' }] }, { id: cn });
  assert.equal(A.getInvoice(cn).reviewed_at, null);
});
