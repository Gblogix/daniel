/**
 * Pick-up locations (terminal / CFS / CES / airline warehouse) and their FIRMS code. Learned from every saved file
 * (the latest file wins for the code, address and tel) and editable on Admin › Pickup locations. Typing a location
 * name or a FIRMS code in a file finds the other.
 */
const store = require('./db');

const clean = (v) => String(v ?? '').trim();
const code = (v) => clean(v).toUpperCase().replace(/\s+/g, '');

/** Remember (or refresh) a location from a file. */
function learn({ name, firms_code: firms, address, tel, mode } = {}, { db = store.db } = {}) {
  const n = clean(name);
  if (!n || n.length < 2) return null;
  const cur = db.get('SELECT * FROM pickup_locations WHERE name = ?', n);
  mode = mode === 'AIR' ? 'AIR' : ['FCL', 'LCL', 'OCEAN'].includes(mode) ? 'OCEAN' : null;
  const f = code(firms) || null; const a = clean(address) || null; const t = clean(tel) || null;
  if (!cur) {
    const r = db.run('INSERT INTO pickup_locations (name, firms_code, address, tel, mode, uses) VALUES (?, ?, ?, ?, ?, 1)', n, f, a, t, mode || null);
    return Number(r.lastInsertRowid);
  }
  db.run(`UPDATE pickup_locations SET firms_code = COALESCE(?, firms_code), address = COALESCE(?, address), tel = COALESCE(?, tel),
    mode = COALESCE(mode, ?), uses = uses + 1, updated_at = datetime('now') WHERE id = ?`, f, a, t, mode || null, cur.id);
  return cur.id;
}

/** Name or FIRMS code → best matches (exact code, then names / codes starting with the text, then containing it). */
function search(q, { db = store.db, mode = '', limit = 10 } = {}) {
  const t = clean(q);
  const rows = t
    ? db.all("SELECT * FROM pickup_locations WHERE name LIKE ? ESCAPE '\\' OR firms_code LIKE ? ESCAPE '\\'", `%${t.replace(/[\\%_]/g, (c) => `\\${c}`)}%`, `${code(t).replace(/[\\%_]/g, (c) => `\\${c}`)}%`)
    : db.all('SELECT * FROM pickup_locations');
  const tl = t.toLowerCase(); const tc = code(t);
  const air = mode === 'AIR';
  const rank = (r) => (tc && r.firms_code === tc ? 0 : r.name.toLowerCase() === tl ? 1 : r.name.toLowerCase().startsWith(tl) || (tc && String(r.firms_code || '').startsWith(tc)) ? 2 : 3)
    + (mode && r.mode && (r.mode === 'AIR') !== air ? 2 : 0); // the other mode's places last
  return rows.sort((a, b) => rank(a) - rank(b) || b.uses - a.uses || a.name.localeCompare(b.name)).slice(0, limit);
}

/** One-time: learn every location already on files. */
function backfill({ db = store.db } = {}) {
  let n = 0;
  for (const s of db.all("SELECT cfs_location, firms_code, cfs_address, freight_location_tel, mode FROM shipments WHERE cfs_location IS NOT NULL AND TRIM(cfs_location) <> '' ORDER BY id")) {
    if (learn({ name: s.cfs_location, firms_code: s.firms_code, address: s.cfs_address, tel: s.freight_location_tel, mode: s.mode }, { db })) n++;
  }
  return n;
}

const list = ({ db = store.db } = {}) => db.all('SELECT * FROM pickup_locations ORDER BY name COLLATE NOCASE');

function save(id, b, { db = store.db } = {}) {
  const v = [clean(b.name), code(b.firms_code) || null, clean(b.address) || null, clean(b.tel) || null, ['AIR', 'OCEAN'].includes(b.mode) ? b.mode : null];
  if (!v[0]) throw new Error('Enter the location name');
  if (id) db.run("UPDATE pickup_locations SET name = ?, firms_code = ?, address = ?, tel = ?, mode = ?, updated_at = datetime('now') WHERE id = ?", ...v, id);
  else db.run('INSERT INTO pickup_locations (name, firms_code, address, tel, mode) VALUES (?, ?, ?, ?, ?)', ...v);
}

const remove = (id, { db = store.db } = {}) => db.run('DELETE FROM pickup_locations WHERE id = ?', id);

module.exports = { learn, search, backfill, list, save, remove };
