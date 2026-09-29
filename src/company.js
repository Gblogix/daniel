/**
 * Company profile printed on documents. Defaults come from the current forms; admin edits are stored in the
 * settings table (bank / remittance details are kept only in the database, never in source control).
 */
const store = require('./db');

const DEFAULTS = {
  name: 'GLOBALBRIDGE LOGISTICS',
  legal_name: 'GLOBALBRIDGE LOGISTICS INC',
  address: '1661 N. RAYMOND AVE., SUITE 140F, ANAHEIM, CA 92801',
  tel: '213-477-0567',
  fax: '213-282-6612',
  email: process.env.COMPANY_EMAIL || 'info@gblogix.com',
  accounting_email: 'Accounting@gblogix.com',
  accounting_tel: '213-247-2437',
  dot: '4406045',
  remit: '',        // DOMESTIC/ACH + INTERNATIONAL/WIRE payment info (multi-line)
};
const FIELDS = Object.keys(DEFAULTS);

function get(db = store.db) {
  const out = { ...DEFAULTS };
  for (const f of FIELDS) {
    const v = db.setting(`company_${f}`);
    if (v != null && v !== '') out[f] = v;
  }
  return out;
}

function set(values, db = store.db) {
  for (const f of FIELDS) if (f in values) db.setSetting(`company_${f}`, String(values[f] ?? '').trim());
}

/** Take the next number of a sequence (OI, AI, OTH, INV, DCN) atomically. */
function nextNumber(seq, db = store.db) {
  return db.tx(() => {
    const n = Number(db.setting(`seq_${seq}`) || 1);
    db.setSetting(`seq_${seq}`, n + 1);
    return n;
  });
}

/**
 * System reference numbers: prefix + code + running number — GBL-OI10001 (ocean file), GBL-AI10001 (air),
 * GBL-OT10001 (trucking / other), GBL-INV10001 (A/R invoice), GBL-DN10001 (debit note), GBL-CN10001 (credit note).
 * Each code has its own counter (Admin › Company); a number already used is skipped, so a ref is never repeated.
 */
const NUMBERING = [['OI', 'Ocean file'], ['AI', 'Air file'], ['OT', 'Trucking / other file'], ['INV', 'A/R invoice'], ['DN', 'Debit note'], ['CN', 'Credit note']];
function nextRef(code, { db = store.db, table = null, column = null } = {}) {
  const prefix = db.setting('num_prefix') ?? 'GBL-';
  for (;;) {
    const ref = `${prefix}${code}${nextNumber(`G_${code}`, db)}`;
    if (!table || !db.get(`SELECT 1 FROM ${table} WHERE ${column} = ?`, ref)) return ref;
  }
}

module.exports = { get, set, nextNumber, nextRef, NUMBERING, DEFAULTS, FIELDS };
