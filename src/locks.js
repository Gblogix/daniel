/**
 * Accounting lock: a finished file can no longer be changed — file fields, containers, P/L, invoices / D/N / C/N /
 * vendor bills (edit, void, new). Memos, documents and emails still work.
 *  - Locks itself when the file is closed (delivered, customer / agent paid) and every vendor bill / C/N is paid too.
 *  - Only an admin locks or unlocks by hand; unlocking needs a reason and is kept in the file history.
 *  - After an admin unlocks, the file stays open for changes until an admin locks it again.
 */
const store = require('./db');

const get = (id, db) => db.get('SELECT id, closed_at, locked_at, locked_by, lock_released_at FROM shipments WHERE id = ?', Number(id));

function isLocked(id, db = store.db) {
  return Boolean(id) && Boolean(get(id, db)?.locked_at);
}

function lockedError() {
  return Object.assign(new Error('This file is locked (accounting finished). Only an admin can unlock it — open the file and use Unlock.'), { status: 423, expose: true, code: 'LOCKED' });
}

function assertUnlocked(id, db = store.db) {
  if (isLocked(id, db)) throw lockedError();
}

/** Closed and nothing left open on the file (A/R, D/N, C/N, vendor bills). */
function ready(id, db = store.db) {
  const s = get(id, db);
  if (!s || !s.closed_at) return false;
  const b = db.get("SELECT COUNT(*) AS n, SUM(CASE WHEN status = 'OPEN' THEN 1 ELSE 0 END) AS open FROM invoices WHERE shipment_id = ? AND status <> 'VOID'", s.id);
  return b.n > 0 && !b.open;
}

function lock(id, { db = store.db, userId = null, auto = false } = {}) {
  const s = get(id, db);
  if (!s || s.locked_at) return false;
  db.run("UPDATE shipments SET locked_at = datetime('now'), locked_by = ?, lock_released_at = NULL, lock_released_by = NULL, lock_release_reason = NULL WHERE id = ?", auto ? null : userId, s.id);
  require('./shipments').addEvent(s.id, 'LOCKED', auto ? 'File locked automatically — accounting finished (all invoices and bills paid)' : 'File locked (accounting finished)', { db, userId, customerVisible: false });
  return true;
}

function unlock(id, { db = store.db, userId = null, reason = '' } = {}) {
  const why = String(reason || '').trim().slice(0, 300);
  if (!why) throw Object.assign(new Error('Enter the reason for unlocking'), { status: 400, expose: true });
  const s = get(id, db);
  if (!s || !s.locked_at) return false;
  db.run("UPDATE shipments SET locked_at = NULL, locked_by = NULL, lock_released_at = datetime('now'), lock_released_by = ?, lock_release_reason = ? WHERE id = ?", userId, why, s.id);
  require('./shipments').addEvent(s.id, 'UNLOCKED', `File unlocked: ${why}`, { db, userId, customerVisible: false });
  return true;
}

/** Lock the file if it just became finished (not when an admin unlocked it on purpose). */
function autoLock(id, { db = store.db } = {}) {
  const s = get(id, db);
  if (!s || s.locked_at || s.lock_released_at || !ready(id, db)) return false;
  return lock(id, { db, auto: true });
}

/** Every closed file that is finished but not locked yet (start-up and hourly). Returns how many were locked. */
function sweep({ db = store.db } = {}) {
  let n = 0;
  for (const r of db.all('SELECT id FROM shipments WHERE closed_at IS NOT NULL AND locked_at IS NULL AND lock_released_at IS NULL')) if (autoLock(r.id, { db })) n++;
  return n;
}

function start() {
  try { sweep(); } catch (e) { console.error('Lock sweep failed:', e.message); }
  setInterval(() => { try { sweep(); } catch (e) { console.error('Lock sweep failed:', e.message); } }, 3600000).unref?.();
}

module.exports = { isLocked, assertUnlocked, lockedError, ready, lock, unlock, autoLock, sweep, start };
