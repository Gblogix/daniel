/**
 * Company profile printed on documents. Defaults come from the current forms; admin edits are stored in the
 * settings table (bank / remittance details are kept only in the database, never in source control).
 */
const store = require('./db');

const DEFAULTS = {
  name: 'GLOBALBRIDGE LOGISTICS',
  legal_name: 'GLOBALBRIDGE LOGISTICS INC',
  address: '1101 LINDENDALE AVE, FULLERTON, CA 92831',
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

module.exports = { get, set, nextNumber, DEFAULTS, FIELDS };
