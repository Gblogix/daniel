// Importing party lists exported from OPUS (made-up names): mapping guesses, roles per sheet, merge with existing parties.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gbl-pi-'));
const store = require('../src/db');
store.db = store.open(':memory:');
require('../src/seed').seedDemo(store.db);
const db = store.db;
const PI = require('../src/partyImport');
const PT = require('../src/partyTypes');
const ExcelJS = require('exceljs');

async function workbook() {
  const wb = new ExcelJS.Workbook();
  const v = wb.addWorksheet('Vendor List');
  v.addRow(['OPUS vendor export']);
  v.addRow([]);
  v.addRow(['Code', 'Vendor Name', 'Address 1', 'City', 'State', 'Zip Code', 'Country', 'Tel', 'Fax', 'E-mail', 'Contact', 'Is Trucker']);
  v.addRow(['V001', 'Sample Drayage LLC', '100 W Sample St', 'Carson', 'CA', '90745', 'UNITED STATES', '310-555-0100', '310-555-0101', 'dispatch@sampledray.example; ar@sampledray.example', 'Kim', 'Y']);
  v.addRow(['V002', 'Example CFS Inc.', '200 Harbor Ave', 'Long Beach', 'CA', '90802', 'USA', '562-555-0200', '', 'ops@examplecfs.example', '', 'N']);
  v.addRow(['', '', '', '', '', '', '', '', '', '', '', '']);
  const f = wb.addWorksheet('Forwarders');
  f.addRow(['Name', 'Address', 'Country', 'Email', 'Type']);
  f.addRow(['Demo Coload Logistics', '1 Test Rd, Gardena, CA', 'US', 'coload@demo.example', 'Co-loader / NVOCC']);
  f.addRow(['Example CFS Inc', '', 'US', '', 'Forwarder']); // same party as on the vendor sheet
  return Buffer.from(await wb.xlsx.writeBuffer());
}

test('reads the sheets, finds the heading row and guesses the columns and the role of each sheet', async () => {
  const sheets = await PI.parse(await workbook(), 'opus-parties.xlsx');
  assert.deepEqual(sheets.map((s) => s.name), ['Vendor List', 'Forwarders']);
  assert.equal(sheets[0].rows.length, 2, 'title rows and empty rows skipped');
  assert.deepEqual(PI.guessMapping(sheets[0]), ['code', 'name', 'address', 'address', 'address', 'address', 'country', 'phone', 'fax', 'emails', 'contact', 'flag:trucker']);
  assert.deepEqual(PI.guessMapping(sheets[1]), ['name', 'address', 'country', 'emails', 'type']);
  assert.equal(PI.sheetRole('Vendor List'), 'vendor');
  assert.equal(PI.sheetRole('Forwarders'), 'forwarder');
  const recs = PI.records(sheets[0], PI.guessMapping(sheets[0]), 'vendor');
  assert.deepEqual(recs[0], {
    code: 'V001', name: 'Sample Drayage LLC', address: '100 W Sample St, Carson, CA, 90745', country: 'US', phone: '310-555-0100', fax: '310-555-0101',
    emails: 'dispatch@sampledray.example, ar@sampledray.example', contact: 'Kim', roles: ['vendor', 'trucker'], terms_days: null,
  });
  assert.deepEqual(recs[1].roles, ['vendor']);
  assert.deepEqual(PI.records(sheets[1], PI.guessMapping(sheets[1]), 'forwarder')[0].roles, ['forwarder']);
});

test('import: new parties added, a party on two sheets gets both roles, existing parties only completed', async () => {
  const sheets = await PI.parse(await workbook(), 'opus-parties.xlsx');
  // Already in the system, typed by hand: keep its phone, add the missing email and the new role.
  const ex = Number(db.run("INSERT INTO companies (name, type, phone) VALUES ('SAMPLE DRAYAGE', 'trucker', '999')").lastInsertRowid);
  const recs = [...PI.records(sheets[0], PI.guessMapping(sheets[0]), 'vendor'), ...PI.records(sheets[1], PI.guessMapping(sheets[1]), 'forwarder')];
  const plan = PI.plan(recs);
  assert.deepEqual(plan.map((p) => p.action), ['update', 'new', 'new', 'duplicate']);
  const r = PI.apply(recs);
  assert.deepEqual(r, { added: 2, updated: 1, unchanged: 0, skipped: 0 });
  const drayage = db.get('SELECT * FROM companies WHERE id = ?', ex);
  assert.equal(drayage.phone, '999', 'existing value kept');
  assert.equal(drayage.emails, 'dispatch@sampledray.example, ar@sampledray.example');
  assert.equal(drayage.code, 'V001');
  assert.deepEqual(PT.of(drayage), ['trucker', 'vendor']);
  const cfs = db.get("SELECT * FROM companies WHERE name = 'Example CFS Inc.'");
  assert.deepEqual(PT.of(cfs), ['forwarder', 'vendor']);
  assert.equal(cfs.address, '200 Harbor Ave, Long Beach, CA, 90802');
  const fw = db.get("SELECT * FROM companies WHERE name = 'Demo Coload Logistics'");
  assert.equal(fw.type, 'forwarder');
  // Running the same file again changes nothing.
  assert.deepEqual(PI.apply(recs), { added: 0, updated: 0, unchanged: 3, skipped: 0 });
});

test('CSV works; .xls is refused with a clear message', async () => {
  const sheets = await PI.parse(Buffer.from('﻿Company Name,Phone,Email\n"Test Broker, Inc.",213-555-0300,entry@testbroker.example\n'), 'brokers.csv');
  assert.equal(sheets[0].rows[0][0], 'Test Broker, Inc.');
  assert.equal(PI.sheetRole(sheets[0].name, 'brokers.csv'), 'broker');
  await assert.rejects(PI.parse(Buffer.from('x'), 'old.xls'), /Save As/);
});

test('forwarder is a party role', () => {
  assert.ok(PT.LABELS.forwarder);
  assert.deepEqual(PT.fromForm({ types: ['forwarder', 'vendor'], type: 'forwarder' }), { type: 'forwarder', types: 'forwarder,vendor' });
});

test('import screen: upload → check the mapping → import', async () => {
  const { createApp } = require('../src/server');
  const server = createApp().listen(0); await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    let cookie = '';
    const keep = (res) => { const c = res.headers.getSetCookie?.() || []; if (c.length) cookie = c.map((x) => x.split(';')[0]).join('; '); return res; };
    const tok = async (p) => /name="_csrf" value="([^"]+)"/.exec(await keep(await fetch(base + p, { headers: { cookie } })).text())[1];
    let t = await tok('/login');
    keep(await fetch(`${base}/login`, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: t, email: 'admin@gblogix.com', password: 'changeme123' }) }));
    t = await tok('/companies/import');
    const fd = new FormData();
    fd.append('file', new Blob([Buffer.from('Vendor Name,Phone\nScreen Test Terminal,562-555-0400\n')]), 'vendors.csv');
    const up = await fetch(`${base}/companies/import?_csrf=${t}`, { method: 'POST', body: fd, redirect: 'manual', headers: { cookie } });
    const loc = up.headers.get('location');
    assert.match(loc, /^\/companies\/import\/[a-f0-9]{24}$/);
    const page = await (await fetch(base + loc, { headers: { cookie } })).text();
    assert.match(page, /Screen Test Terminal/);
    assert.match(page, /1 new/);
    t = /name="_csrf" value="([^"]+)"/.exec(page)[1];
    const go = await fetch(base + loc, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: t, include_0: '1', role_0: 'vendor', map_0_0: 'name', map_0_1: 'phone', go: 'import' }) });
    assert.equal(go.headers.get('location'), '/companies');
    const c = db.get("SELECT * FROM companies WHERE name = 'Screen Test Terminal'");
    assert.equal(c.phone, '562-555-0400');
    assert.equal(c.type, 'vendor');
  } finally { server.close(); }
});
