const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { extractRules, isValidContainer, toISODate, detectDocType } = require('../src/extract/rules');
const { extractFile, mergeExtractions } = require('../src/extract');
const { shutdownOcr } = require('../src/extract/pdf');

test.after(() => shutdownOcr());

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
  const r = extractRules('CONTAINER NO: CSQU3054381', { filename: 'mbl.pdf' });
  assert.match(r.warnings[0], /CSQU3054381/);
});

test('fixture PDF (HBL) + XLSX (packing list) merge into one draft', async () => {
  delete process.env.ANTHROPIC_API_KEY;
  const [hbl] = await extractFile({ buffer: fs.readFileSync(fx('HBL_KMHB2410077.pdf')), filename: 'HBL_KMHB2410077.pdf', mime: 'application/pdf' });
  const [pl] = await extractFile({ buffer: fs.readFileSync(fx('PL_HC-2410-07.xlsx')), filename: 'PL_HC-2410-07.xlsx', mime: '' });
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

test('merged PDF (C/I + P/L) is split and table lines are read from the PDF', async () => {
  const parts = await extractFile({ buffer: fs.readFileSync(fx('CI_PL_HC-2410-07.pdf')), filename: 'CI_PL_HC-2410-07.pdf', mime: 'application/pdf' });
  assert.deepEqual(parts.map((p) => [p.doc_type, p.pages]), [['CI', [1]], ['PL', [2]]]);
  const [ci, pl] = parts;
  assert.equal(ci.ci_invoice_no, 'HC-2410-07');
  assert.equal(ci.cargo_value, 90000);
  assert.deepEqual(ci.items.map((i) => [i.description, i.quantity, i.unit, i.amount]), [
    ['Hydrating Toner 200ml', 12000, 'PCS', 25200], ['Vitamin C Serum 30ml', 14400, 'PCS', 50400], ['Sheet Mask (10pk)', 3600, 'BOX', 14400]]);
  assert.deepEqual(pl.items.map((i) => [i.po_no, i.packages, i.weight_kg, i.cbm]), [
    ['PO-6001', 500, 4800.5, 26.1], ['PO-6001', 300, 2650, 15.2], ['PO-6002', 180, 2000, 11]]);
  assert.equal(pl.packages, 980);
  assert.equal(pl.weight_kg, 9450.5); // gross, not the N.W column
  assert.equal(pl.cbm, 52.3);
  assert.deepEqual(pl.warnings, []);
  const d = mergeExtractions(parts);
  assert.equal(d.items[0].amount, 25200); // C/I value joined onto the P/L line
  assert.equal(d.items[0].packages, 500);
});

test('scanned PDF (no text layer) is read with OCR', { timeout: 60000 }, async () => {
  const [hbl] = await extractFile({ buffer: fs.readFileSync(fx('SCAN_HBL_KMHB2410077.pdf')), filename: 'SCAN_HBL.pdf', mime: 'application/pdf' });
  assert.equal(hbl.method, 'ocr');
  assert.equal(hbl.ocr, true);
  assert.equal(hbl.doc_type, 'HBL');
  assert.equal(hbl.hbl_no, 'KMHB2410077');
  assert.equal(hbl.containers[0].container_no, 'CSQU3054383');
  assert.equal(hbl.eta, '2026-10-16');
  assert.equal(hbl.weight_kg, 9450.5);
  assert.ok(hbl.warnings.some((w) => /OCR/.test(w)));
});

test('OCR container misreads are repaired by check digit', () => {
  // O instead of 0 in the serial is repaired; an ambiguous wrong digit is only flagged, never guessed
  const r = extractRules('CONTAINER NO: CSQU3O54383', { filename: 'hbl.pdf' });
  assert.equal(r.containers[0].container_no, 'CSQU3054383');
  assert.match(r.warnings[0], /corrected/);
  const r2 = extractRules('CONTAINER NO: CSQU3054388', { filename: 'hbl.pdf' });
  assert.equal(r2.containers[0].container_no, 'CSQU3054388');
  assert.match(r2.warnings[0], /check digit does not match/);
});

test('arrival-notice fields: firms code, freight location, LFD', () => {
  const r = extractRules(`NOTICE OF ARRIVAL\nFIRMS CODE: Z955\nFREIGHT LOCATION: WFS LAX ATLAS 5761 W IMPERIAL HWY\nLAST FREE DAY: 06/05/2026`, { filename: 'x.pdf' });
  assert.equal(r.doc_type, 'NOA');
  assert.equal(r.firms_code, 'Z955');
  assert.equal(r.freight_location, 'WFS LAX ATLAS 5761 W IMPERIAL HWY');
  assert.equal(r.last_free_day, '2026-06-05');
});

test('National Shipping house numbers: ESSA… = HBL, NSC… = SUB B/L + agent ref', () => {
  const a = extractRules('HOUSE B/L NO. ESSASEL26090859\nSUB B/L NO. NSCLGB26090016\nMASTER B/L NO. SMLMSEL6E2823600', { filename: 'hbl.pdf' });
  assert.deepEqual([a.hbl_no, a.sub_bl_no, a.agent_ref, a.mbl_no], ['ESSASEL26090859', 'NSCLGB26090016', 'NSCLGB26090016', 'SMLMSEL6E2823600']);
  const b = extractRules('B/L NO.: NSCLGB26090012\nMB/L ONEYSELGH6403300', { filename: 'hbl.pdf' });
  assert.deepEqual([b.hbl_no, b.sub_bl_no, b.agent_ref], ['NSCLGB26090012', null, 'NSCLGB26090012']);
});
