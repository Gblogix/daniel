const path = require('node:path');

const { detectDocType } = require('./rules');

/**
 * Read an uploaded file into one or more "segments" (logical documents).
 * A merged PDF (e.g. MBL + HBL + P/L in one file) is split by detecting the document type page by page.
 * Segment: { text, rows (2D table or null), pages: [n], ocr: bool, ocrConfidence, docType }
 */
async function readDocument(buffer, filename, mime = '') {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.pdf' || mime === 'application/pdf') return readPdfSegments(buffer);
  if (['.jpg', '.jpeg', '.png'].includes(ext) || mime.startsWith('image/')) {
    const { ocrImage, extractTable } = require('./pdf');
    const page = await ocrImage(buffer);
    return { segments: [{ text: page.text, rows: extractTable(page.items), pages: [1], ocr: true, ocrConfidence: page.ocrConfidence }] };
  }
  if (ext === '.xlsx' || mime.includes('spreadsheetml')) return { segments: await xlsx(buffer) };
  if (ext === '.csv') {
    const text = buffer.toString('utf8');
    return { segments: [{ text, rows: text.split(/\r?\n/).map((l) => splitCsv(l)) }] };
  }
  if (['.txt', '.eml', '.edi', ''].includes(ext) || mime.startsWith('text/')) return { segments: [{ text: buffer.toString('utf8'), rows: null }] };
  return { segments: [{ text: '', rows: null }] };
}

async function readPdfSegments(buffer) {
  const { readPdf, extractTable } = require('./pdf');
  const pdf = await readPdf(buffer);
  const segments = [];
  for (const p of pdf.pages) {
    const type = detectDocType(p.text.split('\n').slice(0, 12).join('\n'));
    const prev = segments[segments.length - 1];
    // A page without its own title continues the previous document (multi-page B/L, P/L continuation sheets).
    if (prev && (type === 'OTHER' || type === prev.docType)) {
      prev.pages.push(p.num); prev.parts.push(p);
    } else {
      segments.push({ docType: type, pages: [p.num], parts: [p] });
    }
  }
  return {
    segments: segments.map((s) => {
      const tables = s.parts.map((p) => extractTable(p.items)).filter(Boolean);
      // Continuation pages repeat the header: keep the first header, append the data rows.
      const rows = tables.length ? [tables[0][0], ...tables.flatMap((t) => t.slice(1))] : null;
      const ocrParts = s.parts.filter((p) => p.ocr);
      return {
        docType: s.docType, pages: s.pages, text: s.parts.map((p) => p.text).join('\n'), rows,
        ocr: ocrParts.length > 0,
        ocrConfidence: ocrParts.length ? Math.round(ocrParts.reduce((a, p) => a + (p.ocrConfidence || 0), 0) / ocrParts.length) : null,
      };
    }),
  };
}

/**
 * Excel: one segment per tab ("Invoice" / "Packing List" tabs of a combined C/I + P/L file become two documents),
 * typed by the tab name or the title on the sheet. A single sheet holding both (C/I on top, P/L below) is cut at the
 * second title. Hidden and empty tabs are skipped.
 */
async function xlsx(buffer) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const sheets = [];
  wb.eachSheet((ws) => {
    if (ws.state && ws.state !== 'visible') return;
    const rows = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      const vals = [];
      row.eachCell({ includeEmpty: true }, (cell, col) => { vals[col - 1] = cellText(cell.value); });
      const r = Array.from(vals, (v) => v ?? '');
      if (r.some((v) => String(v).trim())) rows.push(r);
    });
    if (rows.length) sheets.push({ name: ws.name, rows });
  });
  const segs = [];
  for (const sh of sheets) {
    for (const part of splitByTitle(sh.rows)) {
      const text = part.map((r) => r.join('  ')).join('\n');
      const type = sheetType(sh.name) || detectDocType(part.slice(0, 15).map((r) => r.join('  ')).join('\n'));
      segs.push({ text, rows: part, sheet: sh.name, docType: type });
    }
  }
  if (!segs.length) return [{ text: '', rows: [] }];
  // One document only: behave as before (the upload slot / file name decides the type).
  if (segs.length === 1) return [{ text: segs[0].text, rows: segs[0].rows }];
  return segs;
}

function sheetType(name) {
  const n = String(name || '').toUpperCase();
  if (/PACKING|\bP\s*[/.-]?\s*L\b|^PL\b/.test(n)) return 'PL';
  if (/INVOICE|\bC\s*[/.-]?\s*I\b|^CI\b/.test(n)) return 'CI';
  if (/\bISF\b/.test(n)) return 'ISF';
  if (/\bHBL\b|HOUSE/.test(n)) return 'HBL';
  if (/\bMBL\b|MASTER/.test(n)) return 'MBL';
  return null;
}

/** Rows of one sheet → one part per document title (COMMERCIAL INVOICE, then PACKING LIST further down). */
function splitByTitle(rows) {
  const TITLE = /^\s*(COMMERCIAL\s+INVOICE|PACKING\s+LIST)\s*$/i;
  const starts = [];
  rows.forEach((r, i) => { if (r.some((c) => TITLE.test(String(c)))) starts.push(i); });
  if (starts.length < 2) return [rows];
  const parts = [];
  starts.forEach((s, k) => parts.push(rows.slice(k === 0 ? 0 : s, starts[k + 1] ?? rows.length)));
  return parts;
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

module.exports = { readDocument, sheetType, splitByTitle };
