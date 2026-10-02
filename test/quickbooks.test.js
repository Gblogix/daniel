// QuickBooks Online sync against a fake QBO API (names / numbers made up).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gbl-qbo-'));
process.env.QBO_CLIENT_ID = 'cid';
process.env.QBO_CLIENT_SECRET = 'secret';
process.env.QBO_ENV = 'sandbox';
const store = require('../src/db');
store.db = store.open(':memory:');
const db = store.db;
const A = require('../src/accounting');
const S = require('../src/shipments');
const Q = require('../src/quickbooks');

const calls = [];
const ids = { n: 100 };
const live = {};
let refreshes = 0;
Q.setFetch(async (url, opts = {}) => {
  const u = new URL(url);
  const body = opts.body ? (/json/.test(opts.headers?.['Content-Type'] || '') ? JSON.parse(opts.body) : Object.fromEntries(new URLSearchParams(opts.body))) : null;
  calls.push({ method: opts.method || 'GET', path: u.pathname, query: Object.fromEntries(u.searchParams), body });
  const ok = (data) => ({ ok: true, status: 200, json: async () => data });
  if (u.hostname === 'oauth.platform.intuit.com') {
    refreshes += 1;
    return ok({ access_token: `at${refreshes}`, refresh_token: `rt${refreshes}`, expires_in: 3600, x_refresh_token_expires_in: 8640000 });
  }
  assert.equal(u.hostname, 'sandbox-quickbooks.api.intuit.com');
  const p = u.pathname.replace(/^\/v3\/company\/\d+/, '');
  if (p === '/query') {
    const q = u.searchParams.get('query');
    if (/from Item where Name/.test(q)) return ok({ QueryResponse: { Item: [{ Id: 'IT1' }] } });
    if (/from Account/.test(q)) return ok({ QueryResponse: { Account: [{ Id: 'AC80', Name: 'Cost of Goods Sold', AccountType: 'Cost of Goods Sold' }] } });
    if (/from Vendor where DisplayName = 'SAMPLE CONSOL KOREA'/.test(q)) return ok({ QueryResponse: {} });
    return ok({ QueryResponse: {} });
  }
  if (/^\/companyinfo\//.test(p)) return ok({ CompanyInfo: { CompanyName: 'Sample Books Co' } });
  const m = /^\/(\w+)(?:\/(\w+))?$/.exec(p);
  const T = { customer: 'Customer', vendor: 'Vendor', invoice: 'Invoice', bill: 'Bill', payment: 'Payment', billpayment: 'BillPayment', item: 'Item' }[m[1]];
  if ((opts.method || 'GET') === 'GET') return ok({ [T]: live[`${T}:${m[2]}`] });
  if (u.searchParams.get('operation')) { live[`${T}:${body.Id}`].gone = u.searchParams.get('operation'); return ok({ [T]: { Id: body.Id, status: 'Voided' } }); }
  const id = body.Id || `${T[0]}${(ids.n += 1)}`;
  live[`${T}:${id}`] = { ...body, Id: id, SyncToken: String(Number(live[`${T}:${id}`]?.SyncToken || -1) + 1) };
  return ok({ [T]: live[`${T}:${id}`] });
});

const party = (name, type) => Number(db.run('INSERT INTO companies (name, type, address, billing_emails) VALUES (?, ?, ?, ?)', name, type, '100 W SAMPLE AVE\nFULLERTON, CA 92833', 'ap@sample.example').lastInsertRowid);
const last = (method, re) => calls.filter((c) => c.method === method && re.test(c.path)).pop();

test('connect: state checked, tokens stored, refresh token rotation kept', async () => {
  assert.equal(Q.connected(), false);
  const url = new URL(Q.authorizeUrl());
  assert.equal(url.searchParams.get('scope'), 'com.intuit.quickbooks.accounting');
  await assert.rejects(Q.handleCallback({ code: 'x', realmId: '123', state: 'wrong' }), /expired/);
  await Q.handleCallback({ code: 'abc', realmId: '9130350000000001', state: url.searchParams.get('state') });
  assert.equal(Q.connected(), true);
  assert.equal(Q.opt('company_name'), 'Sample Books Co');
  assert.equal(Q.tokens().refresh_token, 'rt1');
  db.setSetting('qbo_tokens', JSON.stringify({ ...Q.tokens(), access_expires: 0 }));
  await Q.companyInfo();
  assert.equal(Q.tokens().refresh_token, 'rt2', 'newest refresh token saved');
});

test('A/R invoice → QBO invoice with customer created; unchanged on re-sync; edit → update; void → void', async () => {
  const cust = party("HARBOR O'NEIL TRADE INC", 'customer');
  const sid = S.create({ mode: 'AIR', status: 'BOOKED', mbl_no: '180-10000001', hbl_no: 'NSCXA2600001' });
  const id = A.saveInvoice({ kind: 'AR', company_id: cust, shipment_id: sid, invoice_date: '2026-10-01', lines: [
    { description: 'Air freight', rate: '2.5', qty: '100' }, { description: 'Handling charge', amount: '65' }] });
  A.setReviewed(id, true);
  let r = await Q.syncAll();
  assert.deepEqual([r.created, r.errors], [1, []]);
  assert.match(last('GET', /query/).query.query, /O\\'NEIL/, 'quote escaped in QBO query');
  const cust1 = last('POST', /\/customer$/).body;
  assert.equal(cust1.DisplayName, "HARBOR O'NEIL TRADE INC");
  assert.equal(cust1.BillAddr.Line2, 'FULLERTON, CA 92833');
  const inv = last('POST', /\/invoice$/).body;
  assert.equal(inv.DocNumber, A.getInvoice(id).number);
  assert.equal(inv.Line.length, 2);
  assert.deepEqual([inv.Line[0].Amount, inv.Line[0].SalesItemLineDetail.Qty, inv.Line[0].SalesItemLineDetail.UnitPrice, inv.Line[0].SalesItemLineDetail.ItemRef.value], [250, 100, 2.5, 'IT1']);
  assert.match(inv.PrivateNote, /File GBL-AI\d+ · HBL NSCXA2600001 · MBL 180-10000001/);
  const qid = A.getInvoice(id).qbo_id;
  assert.ok(qid);
  r = await Q.syncAll();
  assert.equal(r.created + r.updated, 0, 'nothing re-sent');
  A.saveInvoice({ kind: 'AR', company_id: cust, shipment_id: sid, invoice_date: '2026-10-01', lines: [{ description: 'Air freight', amount: '300' }] }, { id });
  A.setReviewed(id, true);
  r = await Q.syncAll();
  assert.equal(r.updated, 1);
  const upd = last('POST', /\/invoice$/).body;
  assert.deepEqual([upd.Id, upd.SyncToken, upd.Line.length], [qid, '0', 1]);
  A.voidInvoice(id);
  r = await Q.syncAll();
  assert.equal(r.voided, 1);
  assert.equal(last('POST', /\/invoice$/).query.operation, 'void');
  assert.equal(A.getInvoice(id).qbo_id, null);
});

test('D/N → invoice to the agent; C/N (net due to the agent) → bill; mixed lines posted as one net line', async () => {
  const ag = party('SAMPLE CONSOL KOREA', 'agent');
  const dn = A.saveInvoice({ kind: 'DN', company_id: ag, invoice_date: '2026-10-02', lines: [
    { description: 'Ocean freight', amount: '900', side: 'DEBIT' }, { description: 'Profit share', amount: '150', side: 'CREDIT' }] });
  const cn = A.saveInvoice({ kind: 'DN', company_id: ag, invoice_date: '2026-10-02', lines: [{ description: 'Handling refund', amount: '80', side: 'CREDIT' }] });
  A.setReviewed(dn, true); A.setReviewed(cn, true);
  const r = await Q.syncAll();
  assert.deepEqual(r.errors, []);
  assert.equal(A.getInvoice(dn).qbo_type, 'Invoice');
  const dnBody = live[`Invoice:${A.getInvoice(dn).qbo_id}`];
  assert.equal(dnBody.Line.length, 1);
  assert.equal(dnBody.Line[0].Amount, 750);
  assert.match(dnBody.Line[0].Description, /OCEAN FREIGHT 900\.00, PROFIT SHARE -150\.00/);
  assert.equal(A.getInvoice(cn).qbo_type, 'Bill');
  const bill = live[`Bill:${A.getInvoice(cn).qbo_id}`];
  assert.deepEqual([bill.Line[0].Amount, bill.Line[0].AccountBasedExpenseLineDetail.AccountRef.value], [80, 'AC80']);
  assert.ok(db.get('SELECT qbo_customer_id, qbo_vendor_id FROM companies WHERE id = ?', ag).qbo_vendor_id, 'agent is customer and vendor');
});

test('vendor bill + payments: received → Payment, paid → Bill Payment from the chosen bank, only the synced part', async () => {
  const v = party('SAMPLE CFS CARSON', 'vendor');
  const ap = A.saveInvoice({ kind: 'AP', number: 'CFS-7781', company_id: v, invoice_date: '2026-10-03', lines: [{ description: 'CFS charge', amount: '420' }] });
  await Q.syncAll();
  assert.ok(A.getInvoice(ap).qbo_id);
  A.recordPayment({ company_id: v, direction: 'OUT', amount: 420, paid_on: '2026-10-05', method: 'ACH', reference: 'ACH-1', allocations: [{ invoice_id: ap, amount: 420 }] });
  let r = await Q.syncAll();
  assert.equal(r.payments, 0);
  assert.match(r.errors.join(), /bank account/);
  Q.setOpt('bank_account', 'BK35');
  r = await Q.syncAll();
  assert.equal(r.payments, 1);
  const bp = last('POST', /\/billpayment$/).body;
  assert.deepEqual([bp.TotalAmt, bp.CheckPayment.BankAccountRef.value, bp.Line[0].LinkedTxn[0].TxnType], [420, 'BK35', 'Bill']);
  // A payment for a document QBO doesn't have yet (not reviewed) waits.
  const cust = party('NEW BUYER LLC', 'customer');
  const ar = A.saveInvoice({ kind: 'AR', company_id: cust, invoice_date: '2026-10-03', lines: [{ description: 'Freight', amount: '100' }] });
  A.recordPayment({ company_id: cust, direction: 'IN', amount: 100, paid_on: '2026-10-06', allocations: [{ invoice_id: ar, amount: 100 }] });
  r = await Q.syncAll();
  assert.equal(r.payments, 0);
  A.setReviewed(ar, true);
  r = await Q.syncAll();
  assert.equal(r.payments, 1);
  assert.equal(last('POST', /\/payment$/).body.Line[0].LinkedTxn[0].TxnId, A.getInvoice(ar).qbo_id);
});
