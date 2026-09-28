// C/I + P/L in one file: Excel tabs (or one sheet with both titles) and merged PDFs are split into two documents.
const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { readDocument, sheetType } = require('../src/extract/text');
const { extractFile, mergeExtractions } = require('../src/extract/index');

function ciRows(ws) {
  ws.addRow(['', 'COMMERCIAL INVOICE']);
  ws.addRow(['1. Shipper/Exporter', '', '', '9. No & Date of Invoice']);
  ws.addRow(['BK PLUS TRADING CO., LTD', '', '', '#BSBUS26091601']);
  ws.addRow(['', '', '', 'SEP. 16, 2026']);
  ws.addRow(['DESCRIPTION', 'QTY', 'UNIT PRICE', 'AMOUNT']);
  ws.addRow(['Hair Pack', 1200, 2.5, 3000]);
  ws.addRow(['TOTAL', 1200, '', 3000]);
}
function plRows(ws) {
  ws.addRow(['', 'PACKING LIST']);
  ws.addRow(['1. Shipper/Exporter', '', '', '9. No & Date of Invoice']);
  ws.addRow(['BK PLUS TRADING CO., LTD', '', '', '#BSBUS26091601']);
  ws.addRow(['DESCRIPTION', 'QTY', 'CTNS', 'G.W (KG)', 'CBM']);
  ws.addRow(['Hair Pack', 1200, 40, 480, 2.1]);
  ws.addRow(['TOTAL', 1200, 40, 480, 2.1]);
}
const book = async (fill) => { const wb = new ExcelJS.Workbook(); fill(wb); return Buffer.from(await wb.xlsx.writeBuffer()); };

test('tab names decide the document type', () => {
  assert.equal(sheetType('Invoice'), 'CI');
  assert.equal(sheetType('Packing List'), 'PL');
  assert.equal(sheetType('C.I'), 'CI');
  assert.equal(sheetType('P-L'), 'PL');
  assert.equal(sheetType('Sheet1'), null);
});

test('Excel with "Invoice" and "Packing List" tabs → a C/I and a P/L', async () => {
  const buf = await book((wb) => { ciRows(wb.addWorksheet('Invoice')); plRows(wb.addWorksheet('Packing List')); });
  const { segments } = await readDocument(buf, 'CI PL BK PLUS.xlsx');
  assert.deepEqual(segments.map((s) => [s.sheet, s.docType]), [['Invoice', 'CI'], ['Packing List', 'PL']]);
  const parts = await extractFile({ buffer: buf, filename: 'CI PL BK PLUS.xlsx', docTypeHint: 'AUTO' });
  assert.deepEqual(parts.map((p) => [p.doc_type, p.sheet]), [['CI', 'Invoice'], ['PL', 'Packing List']]);
  assert.equal(parts[0].ci_invoice_no, 'BSBUS26091601');
  const draft = mergeExtractions(parts);
  assert.equal(draft.ci_invoice_no, 'BSBUS26091601');
  assert.equal(draft.packages, 40);
  assert.equal(draft.weight_kg, 480);
});

test('one sheet with C/I on top and P/L below is cut at the PACKING LIST title', async () => {
  const buf = await book((wb) => { const ws = wb.addWorksheet('Sheet1'); ciRows(ws); ws.addRow([]); plRows(ws); });
  const { segments } = await readDocument(buf, 'docs.xlsx');
  assert.deepEqual(segments.map((s) => s.docType), ['CI', 'PL']);
});

test('a one-tab Excel stays one document (the upload line decides its type)', async () => {
  const buf = await book((wb) => plRows(wb.addWorksheet('Sheet1')));
  const parts = await extractFile({ buffer: buf, filename: 'x.xlsx', docTypeHint: 'PL' });
  assert.equal(parts.length, 1);
  assert.equal(parts[0].doc_type, 'PL');
});

test('merged C/I + P/L PDF is split by page title', async () => {
  const buf = require('node:fs').readFileSync(require('node:path').join(__dirname, 'fixtures/CI_PL_HC-2410-07.pdf'));
  const parts = await extractFile({ buffer: buf, filename: 'CI_PL_HC-2410-07.pdf', mime: 'application/pdf', docTypeHint: 'AUTO' });
  assert.deepEqual(parts.map((p) => p.doc_type), ['CI', 'PL']);
});

test('P/L table ends at TOTAL / the next form section — no "PACKING LIST" or "3. NOTIFY PARTY" lines', () => {
  const { itemsFromRows } = require('../src/extract/rules');
  const rows = [
    ['DESCRIPTION', 'QTY', 'UNIT PRICE', 'AMOUNT'],
    ['Shampoo', '1883', '5300', '9979900'],
    ['Hair rinse / Conditioner', '1152', '5300', '6105600'],
    ['PACKING LIST', '', '', ''],
    ['3. NOTIFY PARTY:', '11', '11', '11'],
    ['4. DELIVERY ADDRESS', '', '', ''],
    ['6. FINAL DESTINATION', '12', '12', '12'],
    ['LOS ANGELES, CA USA', '', '', ''],
  ];
  assert.deepEqual(itemsFromRows(rows).items.map((i) => i.description), ['Shampoo', 'Hair rinse / Conditioner']);
  const withTotal = [['DESCRIPTION', 'QTY', 'CTNS'], ['Serum', '100', '5'], ['TOTAL', '100', '5'], ['Shampoo', '1', '1']];
  assert.deepEqual(itemsFromRows(withTotal).items.map((i) => i.description), ['Serum']);
});

test('two P/Ls in one shipment keep their own invoice no. and final buyer (Target / Nordstrom)', async () => {
  const pl = (inv, buyer, item) => [['', 'PACKING LIST'], ['9. No & Date of Invoice', `#${inv}`], ['SHIP TO:', buyer], ['DESCRIPTION', 'QTY', 'CTNS', 'G.W (KG)', 'CBM'], [item, 100, 10, 200, 1.5], ['TOTAL', 100, 10, 200, 1.5]];
  const mk = async (rows) => { const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('PL'); rows.forEach((r) => ws.addRow(r)); return Buffer.from(await wb.xlsx.writeBuffer()); };
  const a = await extractFile({ buffer: await mk(pl('EZVC_TGT_26-09', 'BRIGHT TRADE INC', 'Facial serum')), filename: 'pl1.xlsx', docTypeHint: 'PL' });
  const b = await extractFile({ buffer: await mk(pl('BSBUS26091601', 'NORDSTROM RACK DC 0572', 'Shampoo')), filename: 'pl2.xlsx', docTypeHint: 'PL' });
  const d = mergeExtractions([...a, ...b]);
  assert.deepEqual(d.items.map((i) => [i.buyer, i.invoice_no, i.description]), [['Target', 'EZVC_TGT_26-09', 'Facial serum'], ['Nordstrom Rack', 'BSBUS26091601', 'Shampoo']]);
});

test('Korean exporter CI/PL workbook: merged cells, 2-row header, VOLUME (35ml) is not CBM, gross not net weight, buyer under Terms', async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Packing List');
  const put = (r, c, v, to) => { ws.getCell(r, c).value = v; if (to) ws.mergeCells(r, c, r, to); };
  put(1, 2, 'PACKING LIST', 16);
  put(2, 2, '1. Shipper/Exporter', 6); put(2, 7, '9. No & Date of Invoice', 16);
  put(3, 2, 'Sample Exporter Inc.', 6); put(3, 7, '#BSBUS99990001', 9);
  put(4, 2, '2. Consignee', 6); put(4, 7, '11. Terms & Conditions', 16);
  put(5, 2, 'Bright Brands Inc.', 6); put(5, 7, 'EXPORT STANDARD PACKING', 16);
  put(6, 7, 'Walmart', 16);
  put(7, 2, '13. Description of Goods', 16);
  ['NO', 'SKU', 'HS CODE', 'BARCODE', 'PRODUCT NAME', 'VOLUME', "Q'TY / (pcs)", "CT / Q'ty", 'Pallet', 'Pallet / No.', 'CT SIZE(cm)', 'CT SIZE(cm)', 'CT SIZE(cm)', 'N. WEIGHT / (kg)', 'G. WEIGHT / (kg)']
    .forEach((h, k) => { ws.getCell(8, k + 2).value = h; ws.getCell(9, k + 2).value = h.startsWith('CT SIZE') ? ['W', 'D', 'H'][k - 10] : h; });
  [[1, 'SB1318', '3304.99-9000', '880001', 'Deep Collagen Capsule Cream', '55g', 1680, 56, 1, 1, 35, 22, 13.5, 240.79999999999998, 242.79999999999998],
    [2, 'SB1447', '3304.99-1000', '880002', 'EGF Smoothing Toner', '300ml', 210, 7, 1, 1, 31, 26, 20, 80.5, 82.5]].forEach((r, k) => r.forEach((v, c) => { ws.getCell(10 + k, c + 2).value = v; }));
  ws.getCell(12, 2).value = 'TOTAL'; ws.getCell(12, 8).value = 1890; ws.getCell(12, 9).value = 63; ws.getCell(12, 15).value = 321.3; ws.getCell(12, 16).value = 325.3;
  const buf = Buffer.from(await wb.xlsx.writeBuffer());
  const [pl] = await extractFile({ buffer: buf, filename: 'BSBUS99990001_CIPL.xlsx', docTypeHint: 'PL' });
  assert.equal(pl.ci_invoice_no, 'BSBUS99990001');
  assert.equal(pl.buyer, 'Walmart');
  assert.equal(pl.consignee_name, 'Bright Brands Inc.');
  assert.deepEqual(pl.items.map((i) => [i.po_no, i.quantity, i.unit, i.packages, i.weight_kg, i.cbm, i.buyer]),
    [['SB1318', 1680, 'PCS', 56, 242.8, null, 'Walmart'], ['SB1447', 210, 'PCS', 7, 82.5, null, 'Walmart']]);
  assert.deepEqual([pl.packages, pl.package_unit, pl.weight_kg], [63, 'CTNS', 325.3]);
});
