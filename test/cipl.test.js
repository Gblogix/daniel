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
