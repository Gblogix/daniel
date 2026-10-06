/**
 * Nightly backup (the server PC can fail): a consistent copy of the database (SQLite VACUUM INTO, safe while the app
 * runs) plus new / changed uploaded files, into BACKUP_DIR — point it at a OneDrive / Google Drive folder so the copy
 * also leaves the building. Database copies older than BACKUP_KEEP_DAYS (30) are removed; uploads are mirrored.
 */
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
const store = require('./db');

const dir = () => process.env.BACKUP_DIR || '';
const keepDays = () => Math.max(3, Number(process.env.BACKUP_KEEP_DAYS || 30));

function copyNewer(src, dst) {
  let n = 0;
  if (!fs.existsSync(src)) return 0;
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const a = path.join(src, e.name); const b = path.join(dst, e.name);
    if (e.isDirectory()) { n += copyNewer(a, b); continue; }
    const sa = fs.statSync(a);
    const sb = fs.existsSync(b) ? fs.statSync(b) : null;
    if (!sb || sb.size !== sa.size || sb.mtimeMs < sa.mtimeMs) { fs.copyFileSync(a, b); n += 1; }
  }
  return n;
}

function run({ db = store.db, target = dir(), now = new Date() } = {}) {
  if (!target) throw new Error('BACKUP_DIR is not set in .env');
  fs.mkdirSync(path.join(target, 'database'), { recursive: true });
  const stamp = now.toISOString().slice(0, 10);
  const file = path.join(target, 'database', `gblogix-${stamp}.db`);
  if (fs.existsSync(file)) fs.rmSync(file);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const files = copyNewer(config.uploadDir, path.join(target, 'uploads'));
  // Keep the last N days of database copies.
  const cutoff = now.getTime() - keepDays() * 86400000;
  for (const f of fs.readdirSync(path.join(target, 'database'))) {
    const m = /^gblogix-(\d{4}-\d{2}-\d{2})\.db$/.exec(f);
    if (m && Date.parse(`${m[1]}T00:00:00Z`) < cutoff) fs.rmSync(path.join(target, 'database', f));
  }
  const result = { at: now.toISOString(), file, size: fs.statSync(file).size, files };
  db.setSetting('backup_last', JSON.stringify(result));
  return result;
}

function last(db = store.db) { try { return JSON.parse(db.setting('backup_last') || 'null'); } catch { return null; } }

/** Once a day after 2am (office time), and at start-up if the last one is over a day old. */
function start() {
  if (!dir()) return false;
  const tick = () => {
    const l = last();
    const due = !l || Date.now() - Date.parse(l.at) > 23 * 3600000;
    const hour = require('./alerts').officeNow().hour;
    if (due && (hour >= 2 || !l)) {
      try { const r = run(); console.log(`Backup: ${r.file} (+${r.files} files)`); } catch (e) { console.error('Backup failed:', e.message); store.db.setSetting('backup_error', `${new Date().toISOString()} ${e.message}`); }
    }
  };
  tick();
  setInterval(tick, 30 * 60000).unref?.();
  return true;
}

module.exports = { run, last, start, dir };
