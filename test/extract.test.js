const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { extractRules, isValidContainer, toISODate, detectDocType } = require('../src/extract/rules');
const { extractFile, mergeExtractions } = require('../src/extract');

const fx = (f) => path.join(__dirname, 'fixtures', f);

test('ISO 6346 container check digit', () => {
  assert.equal(isValidContainer('CSQU3054383'), true);
  assert.equal(isValidContainer('CSQU3054384'), false);
  assert.equal(isValidContainer('CSQ3054383'), false);
});

test('date formats normalise to YYYY-MM-DD', () => {
  assert.equal(toISODate('02-OCT-2026'), '2026-10-02');
  assert.equal(toISODate('Oct 2, 2026'), '2026-10-02');
  assert.equal(toISODate('2026.10.02'), '2026-10-02');
  assert.equal(toISODate('10/02/2026'), '2026-10-02');
  assert.equal(toISODate('2nd OCT 26'), '2026-10-02');
});

test('doc type detection by filename and content', () => {
  assert.equal(detectDocType('', 'HBL_123.pdf'), 'HBL');
  assert.equal(detectDocType('PACKING LIST', 'scan.pdf'), 'PL');
  assert.equal(detectDocType('COMMERCIAL INVOICE', 'x.pdf'), 'CI');
  assert.equal(detectDocType('IMPORTER SECURITY FILING', 'x.pdf'), 'ISF');
});

test('B/L text: numbers, container/seal, totals', () => {
  const text = `HOUSE BILL OF LADING
B/L NO.: GBL123456
MASTER B/L NO: ONEYSELA1234567
OCEAN VESSEL / VOY. NO.: ONE HARMONY 112E
PORT OF LOADING: BUSAN
PORT OF DISCHARGE: LONG BEACH
CONTAINER / SEAL: CSQU3054383/SL778899 20'GP
ETA: 2026-11-03
36 PLTS  GROSS WEIGHT 5,210.00 KGS  MEASUREMENT 21.400 CBM`;
  const r = extractRules(text, { filename: 'hbl.pdf' });
  assert.equal(r.doc_type, 'HBL');
  assert.equal(r.hbl_no, 'GBL123456');
  assert.equal(r.mbl_no, 'ONEYSELA1234567');
  assert.equal(r.vessel, 'ONE HARMONY');
  assert.equal(r.voyage, '112E');
  assert.deepEqual(r.containers.map((c) => [c.container_no, c.seal_no, c.size_type]), [['CSQU3054383', 'SL778899', '20GP']]);
  assert.equal(r.weight_kg, 5210);
  assert.equal(r.cbm, 21.4);
  assert.equal(r.packages, 36);
  assert.equal(r.package_unit, 'PLTS');
  assert.equal(r.eta, '2026-11-03');
  assert.deepEqual(r.warnings, []);
});

test('invalid container check digit produces a warning', () => {
  const r = extractRules('CONTAINER NO: CSQU3054384', { filename: 'mbl.pdf' });
  assert.match(r.warnings[0], /CSQU3054384/);
});

test('fixture PDF (HBL) + XLSX (packing list) merge into one draft', async () => {
  delete process.env.ANTHROPIC_API_KEY;
  const hbl = await extractFile({ buffer: fs.readFileSync(fx('HBL_KMHB2410077.pdf')), filename: 'HBL_KMHB2410077.pdf', mime: 'application/pdf' });
  const pl = await extractFile({ buffer: fs.readFileSync(fx('PL_HC-2410-07.xlsx')), filename: 'PL_HC-2410-07.xlsx', mime: '' });
  assert.equal(hbl.hbl_no, 'KMHB2410077');
  assert.equal(hbl.mbl_no, 'HDMUPUSA7788990');
  assert.equal(hbl.etd, '2026-10-02');
  assert.equal(pl.doc_type, 'PL');
  assert.equal(pl.items.length, 3);
  const d = mergeExtractions([hbl, pl]);
  assert.equal(d.mode, 'FCL');
  assert.equal(d.containers[0].container_no, 'CSQU3054383');
  assert.equal(d.containers[0].seal_no, 'HD991203');
  assert.equal(d.containers[0].size_type, '40HC');
  assert.equal(d.weight_kg, 9450.5);
  assert.equal(d.cbm, 52.3);
  assert.equal(d.items[0].description, 'Hydrating Toner 200ml');
  assert.deepEqual(d.warnings, []);
});

test('conflicting values between documents are flagged', () => {
  const d = mergeExtractions([
    { doc_type: 'HBL', hbl_no: 'A1', weight_kg: 100, containers: [], items: [], warnings: [] },
    { doc_type: 'PL', hbl_no: null, weight_kg: 120, containers: [], items: [], warnings: [] },
  ]);
  assert.equal(d.weight_kg, 100);
  assert.match(d.warnings[0], /weight_kg differs/);
});
