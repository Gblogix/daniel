// Vendor / CFS invoices: read number, date, terms, lines and total; match vendor and file; review and book as A/P.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gbl-vinv-'));
const store = require('../src/db');
store.db = store.open(':memory:');
test.after(async () => { await require('../src/docs/pdf').close(); await require('../src/extract/pdf').shutdownOcr?.(); });
const { seedDemo } = require('../src/seed');
const S = require('../src/shipments');
const A = require('../src/accounting');
const V = require('../src/vendorbills');
const { parseVendorInvoice } = require('../src/extract/vendorInvoice');
const ids = seedDemo(store.db);
const db = store.db;

const CFS = `PACIFIC CFS, INC.
2250 E. CARSON ST, CARSON CA 90810   TEL 310-555-0100   billing@pacificcfs.com
INVOICE
Invoice No: PCF-260915-03        Invoice Date: 09/15/2026
Bill To: GLOBALBRIDGE LOGISTICS INC          Terms: NET 15
MBL: ONEYSELA0098812   HBL: KMHB2409014   Container: MSKU7654321
DESCRIPTION                          QTY      RATE        AMOUNT
CFS HANDLING CHARGE                  21.4     25.00       535.00
DEVANNING                             1       350.00      350.00
STORAGE (9/12-9/15)                   4        45.00      180.00
DOCUMENT FEE                                               35.00
SUBTOTAL                                                1,100.00
TOTAL DUE                                              $1,100.00`;

const TRUCK = `CTC LOGISTICS
dispatch@ctc.example
Invoice #  CTC-7781
Date: Sep 18, 2026         Due Date: Oct 18, 2026
Container EWLU7068201   Pick up: FENIX MARINE   Deliver: NEXTRADE SOUTH GATE
Description                                     Amount
Drayage FMS - South Gate                        $650.00
Fuel surcharge 18%                              $117.00
Chassis 3 days @ 45.00                          $135.00
Pre-pull                                        $150.00
Balance Due                                     $1,052.00`;

test('reads a CFS invoice: number, date, terms → due date, lines with qty × rate, total', () => {
  db.run("INSERT INTO companies (name, type, emails) VALUES ('Pacific CFS, Inc.', 'vendor', 'billing@pacificcfs.com')");
  const companies = db.all('SELECT * FROM companies');
  const r = parseVendorInvoice(CFS, { companies, ownName: 'GLOBALBRIDGE LOGISTICS' });
  assert.equal(r.number, 'PCF-260915-03');
  assert.equal(r.invoice_date, '2026-09-15');
  assert.equal(r.terms_days, 15);
  assert.equal(r.due_date, '2026-09-30');
  assert.equal(r.total, 1100);
  assert.deepEqual(r.lines.map((l) => [l.description, l.qty, l.rate, l.amount]), [
    ['CFS HANDLING CHARGE', 21.4, 25, 535], ['DEVANNING', 1, 350, 350], ['STORAGE (9/12-9/15)', 4, 45, 180], ['DOCUMENT FEE', null, null, 35]]);
  assert.equal(r.vendor.name, 'Pacific CFS, Inc.');
  assert.deepEqual(r.warnings, []);
});

test('reads a trucker invoice with $ amounts and word dates', () => {
  const r = parseVendorInvoice(TRUCK, { companies: db.all('SELECT * FROM companies'), ownName: 'GLOBALBRIDGE LOGISTICS' });
  assert.equal(r.number, 'CTC-7781');
  assert.equal(r.invoice_date, '2026-09-18');
  assert.equal(r.due_date, '2026-10-18');
  assert.equal(r.terms_days, 30);
  assert.equal(r.total, 1052);
  assert.equal(r.lines.length, 4);
  assert.equal(r.lines.reduce((a, l) => a + l.amount, 0), 1052);
  assert.equal(r.vendor.id, ids.ctc);
  assert.ok(r.refs.containers.includes('EWLU7068201'));
});

test('flags a total that does not match the lines, and a missing number', () => {
  const r = parseVendorInvoice('ACME\nDate: 2026-09-01\nHandling 100.00\nTotal 150.00', {});
  assert.ok(r.warnings.some((w) => /add up to 100.00/.test(w)));
  assert.ok(r.warnings.some((w) => /Invoice number not found/.test(w)));
});

test('upload a PDF → matched to the file by container / B/L → book as A/P with the PDF linked', async () => {
  const html = `<html><body><pre style="font:12px monospace">${CFS.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</pre></body></html>`;
  const pdf = await require('../src/docs/pdf').htmlToPdf(html);
  const buffer = pdf || Buffer.from(CFS);
  const s = S.list({ role: 'staff' }).find((x) => x.mbl_no === 'ONEYSELA0098812');
  const docId = await V.receive({ buffer, filename: pdf ? 'PCF-260915-03.pdf' : 'PCF.txt', mime: pdf ? 'application/pdf' : 'text/plain', userId: 1 });
  const d = V.get(docId);
  assert.equal(d.shipment_id, s.id, 'matched to the LCL file');
  assert.equal(d.ex.number, 'PCF-260915-03');
  assert.equal(d.ex.total, 1100);
  assert.equal(S.costState(S.find(s.id, null) && S.list({ role: 'staff' }).find((x) => x.id === s.id)).code, 'to_book');
  assert.equal(V.pending().length, 1);
  const id = V.book(docId, { shipment_id: s.id, company_id: d.company_id, number: d.ex.number, invoice_date: d.ex.invoice_date, terms_days: d.ex.terms_days, lines: d.ex.lines });
  const inv = A.getInvoice(id);
  assert.equal(inv.kind, 'AP');
  assert.equal(inv.total, 1100);
  assert.equal(inv.due_date, '2026-09-30');
  assert.equal(inv.document_id, docId);
  assert.equal(V.pending().length, 0);
  assert.equal(A.shipmentProfit(s.id).cost, 1100);
  // Same invoice again → flagged as a possible duplicate.
  const again = V.get(await V.receive({ buffer, filename: 'dup.pdf', mime: pdf ? 'application/pdf' : 'text/plain' }));
  assert.equal(again.ex.duplicate, id);
});

test('delivered file with no vendor cost is flagged; email senders map to vendors', () => {
  const s = S.list({ role: 'staff' }).find((x) => x.mbl_no === '180-12345675');
  S.update(s.id, { status: 'DELIVERED' });
  assert.equal(S.costState(S.list({ role: 'staff' }).find((x) => x.id === s.id)).code, 'no_cost');
  const { vendorForSender, agentForSender } = require('../src/mailin');
  assert.equal(vendorForSender('ar@pacificcfs.com').name, 'Pacific CFS, Inc.');
  assert.equal(vendorForSender('someone@unknown.com'), undefined ?? null);
  assert.equal(agentForSender('ar@pacificcfs.com'), null);
});
