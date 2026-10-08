/**
 * Type-ahead suggestions for text fields: values used before on other files, most used first.
 * Only whitelisted fields → fixed table / column pairs reach the SQL.
 */
const store = require('./db');

const S = (...cols) => cols.map((c) => ['shipments', c]);
const SM = (c) => [['shipments', c], ['masters', c]];
const FIELDS = {
  shipper_name: S('shipper_name'), consignee_name: S('consignee_name'), notify_party: S('notify_party'),
  pol: SM('pol'), pod: SM('pod'), place_of_delivery: SM('place_of_delivery'), final_destination: S('final_destination', 'place_of_delivery'),
  vessel: SM('vessel'), carrier: SM('carrier'), scac: SM('scac'), commodity: S('commodity'), package_unit: S('package_unit'),
  cfs_location: S('cfs_location'), devan_location: S('devan_location', 'cfs_location'), delivery_address: S('delivery_address'),
  firms_code: S('firms_code'), freight_location_tel: S('freight_location_tel'), it_place: S('it_place'), service_term: S('service_term'),
  ctn_size: [['containers', 'size_type']],
  item_buyer: [['cargo_items', 'buyer']], item_desc: [['cargo_items', 'description']], item_unit: [['cargo_items', 'unit']], item_hs: [['cargo_items', 'hs_code']],
  l_desc: [['invoice_lines', 'description']], memo: [['invoices', 'memo']],
  country: [['companies', 'country']], new_party_name: [['companies', 'name']],
};

function suggest(field, q, { db = store.db, limit = 8 } = {}) {
  const src = FIELDS[field];
  const term = String(q || '').trim();
  if (!src || term.length < 1) return [];
  const like = term.replace(/[\\%_]/g, (c) => `\\${c}`);
  const counts = new Map();
  for (const [table, col] of src) {
    let rows;
    try {
      rows = db.all(`SELECT ${col} AS v, COUNT(*) AS n FROM ${table} WHERE ${col} LIKE ? ESCAPE '\\' AND TRIM(${col}) <> '' GROUP BY ${col} ORDER BY n DESC LIMIT 40`, `%${like}%`);
    } catch { continue; } // a column not in this database yet
    for (const r of rows) counts.set(r.v, (counts.get(r.v) || 0) + r.n);
  }
  const t = term.toLowerCase();
  return [...counts.entries()]
    .sort((a, b) => Number(!String(a[0]).toLowerCase().startsWith(t)) - Number(!String(b[0]).toLowerCase().startsWith(t)) || b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .slice(0, limit).map(([v]) => v);
}

module.exports = { FIELDS, suggest };
