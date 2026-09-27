/**
 * HTML → PDF with headless Chromium (playwright-core). Chromium is looked up at CHROMIUM_PATH, the Playwright
 * browser cache, or common system paths. Without Chromium, documents stay HTML (print to PDF from the browser).
 * Install on a server with:  npx playwright install --with-deps chromium
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const config = require('../config');

function findChromium() {
  const candidates = [config.chromiumPath];
  for (const base of [process.env.PLAYWRIGHT_BROWSERS_PATH, '/opt/pw-browsers', path.join(os.homedir(), '.cache', 'ms-playwright')].filter(Boolean)) {
    try {
      for (const d of fs.readdirSync(base).filter((x) => /^chromium-\d+$/.test(x)).sort().reverse()) {
        candidates.push(path.join(base, d, 'chrome-linux', 'chrome'), path.join(base, d, 'chrome-linux64', 'chrome'));
      }
    } catch { /* not present */ }
  }
  candidates.push('/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  return candidates.find((p) => p && fs.existsSync(p)) || null;
}

let browserPromise = null;
let idleTimer = null;
async function browser() {
  const exe = findChromium();
  if (!exe) return null;
  if (!browserPromise) {
    const { chromium } = require('playwright-core');
    browserPromise = chromium.launch({ executablePath: exe, args: ['--no-sandbox'] }).catch((e) => { browserPromise = null; throw e; });
  }
  clearTimeout(idleTimer);
  idleTimer = setTimeout(close, 5 * 60000);
  idleTimer.unref?.();
  return browserPromise;
}

async function close() {
  clearTimeout(idleTimer);
  if (browserPromise) { const b = await browserPromise.catch(() => null); browserPromise = null; await b?.close(); }
}

/** Returns a PDF Buffer, or null when no Chromium is available. */
async function htmlToPdf(html) {
  let b;
  try { b = await browser(); } catch (e) { console.error('PDF: cannot start Chromium:', e.message); return null; }
  if (!b) return null;
  const page = await b.newPage();
  try {
    await page.setContent(html, { waitUntil: 'load' });
    return await page.pdf({ format: 'Letter', printBackground: true, preferCSSPageSize: true });
  } finally {
    await page.close();
  }
}

module.exports = { htmlToPdf, findChromium, close };
