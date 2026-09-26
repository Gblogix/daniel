const path = require('node:path');

/** Returns { text, rows } for a file. `rows` is a 2D array for spreadsheets (used for packing-list lines). */
async function readDocument(buffer, filename, mime = '') {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.pdf' || mime === 'application/pdf') return { text: await pdfText(buffer), rows: null };
  if (ext === '.xlsx' || mime.includes('spreadsheetml')) return xlsx(buffer);
  if (ext === '.csv') {
    const text = buffer.toString('utf8');
    return { text, rows: text.split(/\r?\n/).map((l) => splitCsv(l)) };
  }
  if (['.txt', '.eml', '.edi', ''].includes(ext) || mime.startsWith('text/')) return { text: buffer.toString('utf8'), rows: null };
  return { text: '', rows: null };
}

async function pdfText(buffer) {
  const { PDFParse } = require('pdf-parse');
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    const res = await parser.getText();
    return res.text || '';
  } finally {
    await parser.destroy();
  }
}

async function xlsx(buffer) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const rows = [];
  wb.eachSheet((ws) => {
    ws.eachRow({ includeEmpty: false }, (row) => {
      const vals = [];
      row.eachCell({ includeEmpty: true }, (cell, col) => { vals[col - 1] = cellText(cell.value); });
      rows.push(Array.from(vals, (v) => v ?? ''));
    });
  });
  return { text: rows.map((r) => r.join('  ')).join('\n'), rows };
}

function cellText(v) {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if ('result' in v) return cellText(v.result);
    if ('richText' in v) return v.richText.map((t) => t.text).join('');
    if ('text' in v) return String(v.text);
  }
  return String(v);
}

function splitCsv(line) {
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

module.exports = { readDocument };
