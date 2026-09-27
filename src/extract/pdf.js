/**
 * PDF reader for shipping documents.
 *  - Text layer via pdf.js, with x/y positions (so tables can be rebuilt row by row).
 *  - Pages without a text layer (scans / photos) are rendered and OCR'd offline with Tesseract.
 *  - Output per page: { num, text, items, ocr } where items are {str, x, y, w, h} in top-down coordinates.
 */
const path = require('node:path');

const OCR_MIN_CHARS = 25;        // a page with less text than this is treated as scanned
const OCR_SCALE = Number(process.env.OCR_SCALE || 3);
const OCR_LANGS = process.env.OCR_LANGS || 'eng';

let pdfjsPromise;
function pdfjs() {
  if (!pdfjsPromise) pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjsPromise;
}

async function readPdf(buffer, { ocr = process.env.OCR !== 'off' } = {}) {
  const lib = await pdfjs();
  const doc = await lib.getDocument({ data: new Uint8Array(buffer), isEvalSupported: false, useSystemFonts: true, verbosity: 0 }).promise;
  const pages = [];
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const { height } = page.getViewport({ scale: 1 });
      const tc = await page.getTextContent();
      const items = tc.items
        .filter((it) => it.str && it.str.trim())
        .map((it) => {
          const h = Math.abs(it.transform[3]) || it.height || 10;
          return { str: it.str, x: it.transform[4], y: height - it.transform[5] - h, w: it.width, h };
        });
      pages.push({ num: n, items, ocr: false });
    }
  } finally {
    await doc.destroy();
  }
  const scanned = pages.filter((p) => charCount(p.items) < OCR_MIN_CHARS);
  if (ocr && scanned.length) await ocrPages(buffer, scanned);
  for (const p of pages) p.text = linesToText(groupLines(p.items));
  return { pages, text: pages.map((p) => p.text).join('\n\f\n'), ocrPages: pages.filter((p) => p.ocr).map((p) => p.num) };
}

const charCount = (items) => items.reduce((a, i) => a + i.str.replace(/\s/g, '').length, 0);

let workerPromise;
function ocrWorker() {
  if (!workerPromise) {
    const Tesseract = require('tesseract.js');
    const langs = OCR_LANGS.split('+');
    // Language data ships with the @tesseract.js-data packages, so OCR works without internet access.
    const langPath = path.join(path.dirname(require.resolve(`@tesseract.js-data/${langs[0]}/package.json`)), '4.0.0_best_int');
    workerPromise = Tesseract.createWorker(langs, 1, {
      langPath, gzip: true, cachePath: path.join(require('node:os').tmpdir(), 'gbl-tesseract'),
    }).then(async (w) => { await w.setParameters({ preserve_interword_spaces: '1' }); return w; });
  }
  return workerPromise;
}

async function ocrPages(buffer, pages) {
  const { PDFParse } = require('pdf-parse');
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  let shots;
  try {
    shots = await parser.getScreenshot({ scale: OCR_SCALE, partial: pages.map((p) => p.num) });
  } finally {
    await parser.destroy();
  }
  for (const p of pages) {
    const shot = shots.pages.find((s) => s.pageNumber === p.num);
    if (!shot) continue;
    Object.assign(p, await ocrBuffer(Buffer.from(shot.data), OCR_SCALE));
  }
}

/** OCR an image; returns positioned word items in PDF points (image pixels / scale). */
async function ocrBuffer(image, scale = 1) {
  const worker = await ocrWorker();
  const { data } = await worker.recognize(image, {}, { blocks: true, text: true });
  const items = [];
  for (const b of data.blocks || []) for (const para of b.paragraphs || []) for (const line of para.lines || []) {
    for (const w of line.words || []) {
      if (!w.text.trim() || w.confidence < 20) continue;
      const { x0, y0, x1, y1 } = w.bbox;
      items.push({ str: w.text, x: x0 / scale, y: y0 / scale, w: (x1 - x0) / scale, h: (y1 - y0) / scale, conf: w.confidence });
    }
  }
  return { items, ocr: true, ocrConfidence: Math.round(data.confidence) };
}

/** OCR a photo / image upload (JPG, PNG). */
async function ocrImage(buffer) {
  const page = { num: 1, ...(await ocrBuffer(buffer, 1)) };
  page.text = linesToText(groupLines(page.items));
  return page;
}

async function shutdownOcr() {
  if (workerPromise) { const w = await workerPromise; workerPromise = null; await w.terminate(); }
}

/** Group positioned items into visual lines (top to bottom), each sorted left to right. */
function groupLines(items) {
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  const lines = [];
  for (const it of sorted) {
    const mid = it.y + it.h / 2;
    const line = lines.find((l) => Math.abs(l.mid - mid) < Math.max(3, Math.min(l.h, it.h) * 0.5));
    if (line) { line.items.push(it); line.mid = (line.mid * (line.items.length - 1) + mid) / line.items.length; }
    else lines.push({ mid, h: it.h, items: [it] });
  }
  lines.sort((a, b) => a.mid - b.mid);
  for (const l of lines) l.items.sort((a, b) => a.x - b.x);
  return lines;
}

/** Join items of a line; a wide horizontal gap becomes a double space (a column break the regexes can see). */
function linesToText(lines) {
  return lines.map((l) => {
    let out = '';
    let prev;
    for (const it of l.items) {
      if (prev) {
        const gap = it.x - (prev.x + prev.w);
        const charW = prev.w / Math.max(1, prev.str.length);
        out += gap > charW * 2.5 ? '  ' : gap > charW * 0.2 ? ' ' : '';
      }
      out += it.str.trim();
      prev = it;
    }
    return out;
  }).join('\n');
}

const HEADER_RE = /DESCRIPTION|COMMODITY|ITEM|GOODS|PRODUCT|품명|품목/i;
const NUMERIC_RE = /^[\d,]+(\.\d+)?(\s*[A-Z]{1,5})?$/i;

/**
 * Rebuild a table (packing list / invoice lines) from positioned items.
 * Columns come from the header row; rows are anchored on the numeric column that has one value per row,
 * and wrapped cell text is attached to the nearest anchor. Returns a 2D array: [header, ...rows].
 */
function extractTable(items) {
  const lines = groupLines(items);
  const hIdx = lines.findIndex((l) => l.items.some((i) => HEADER_RE.test(i.str)) && l.items.length >= 3);
  if (hIdx < 0) return null;
  // Header cells may wrap onto a second line ("N.W" / "(KG)") — include lines just below that sit between columns.
  const header = lines[hIdx];
  const headerItems = [...header.items];
  const lh = header.h || 10;
  for (let j = hIdx + 1; j < lines.length && lines[j].mid - header.mid < lh * 1.3; j++) {
    if (lines[j].items.every((i) => !NUMERIC_RE.test(i.str.trim()) || /\(|KG|CBM|M3/i.test(i.str))) headerItems.push(...lines[j].items);
  }
  // Also the line just above (wrapped headers are often vertically centred).
  if (hIdx > 0 && header.mid - lines[hIdx - 1].mid < lh * 1.3) headerItems.push(...lines[hIdx - 1].items.filter((i) => i.str.length < 12));
  const cols = [];
  for (const it of headerItems.sort((a, b) => a.x - b.x)) {
    const c = cols.find((k) => it.x < k.x1 + 4 && it.x + it.w > k.x0 - 4);
    if (c) { c.x0 = Math.min(c.x0, it.x); c.x1 = Math.max(c.x1, it.x + it.w); c.parts.push(it); }
    else cols.push({ x0: it.x, x1: it.x + it.w, parts: [it] });
  }
  if (cols.length < 3) return null;
  cols.sort((a, b) => a.x0 - b.x0);
  for (const c of cols) c.label = c.parts.sort((a, b) => a.y - b.y || a.x - b.x).map((p) => p.str.trim()).join(' ');
  const bounds = cols.slice(1).map((c, i) => (cols[i].x1 + c.x0) / 2);
  const colOf = (it) => { const cx = it.x + it.w / 2; let k = 0; while (k < bounds.length && cx > bounds[k]) k++; return k; };

  const bodyTop = Math.max(...headerItems.map((i) => i.y + i.h));
  let body = items.filter((i) => i.y >= bodyTop - 1);
  const totalItem = body.filter((i) => /^(TOTAL|SUB\s*-?TOTAL|G(RAND)?\.?\s*TOTAL|합계)/i.test(i.str.trim())).sort((a, b) => a.y - b.y)[0];
  // The TOTAL row (and its wrapped cells) is excluded from the lines and returned separately.
  const totalMid = totalItem ? totalItem.y + totalItem.h / 2 : Infinity;
  const inTotalRow = (i) => Math.abs(i.y + i.h / 2 - totalMid) < lh * 1.1;
  body = body.filter((i) => i.y + i.h / 2 < totalMid && !inTotalRow(i));
  if (!body.length) return null;

  const numericCols = cols.map((c, k) => ({ k, vals: body.filter((i) => colOf(i) === k && NUMERIC_RE.test(i.str.trim())) }))
    .filter((c) => c.vals.length && !HEADER_RE.test(cols[c.k].label));
  if (!numericCols.length) return null;
  // Anchor = rightmost numeric column (usually CBM / amount); its values are single-line.
  const anchor = numericCols[numericCols.length - 1];
  const anchors = anchor.vals.map((v) => v.y + v.h / 2).sort((a, b) => a - b)
    .filter((y, i, arr) => i === 0 || y - arr[i - 1] > 2);
  const rowOf = (it) => {
    const mid = it.y + it.h / 2;
    let best = 0;
    for (let r = 1; r < anchors.length; r++) if (Math.abs(anchors[r] - mid) < Math.abs(anchors[best] - mid)) best = r;
    return best;
  };
  const grid = anchors.map(() => cols.map(() => []));
  for (const it of body) grid[rowOf(it)][colOf(it)].push(it);
  const cellText = (parts) => parts.sort((a, b) => a.y - b.y || a.x - b.x)
    .reduce((s, p) => (s && !s.endsWith('-') ? `${s} ${p.str.trim()}` : s + p.str.trim()), '');
  const rows = grid.map((r) => r.map(cellText));
  const out = [cols.map((c) => c.label), ...rows];
  if (totalItem) {
    const tot = cols.map(() => []);
    for (const it of items.filter(inTotalRow)) tot[colOf(it)].push(it);
    out.push(tot.map(cellText));
  }
  return out;
}

module.exports = { readPdf, ocrImage, extractTable, groupLines, linesToText, shutdownOcr };
