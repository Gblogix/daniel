/**
 * A party can play more than one role (e.g. a customer that is also our overseas agent, a warehouse that also trucks).
 * `companies.type` stays the main role; `companies.types` lists every role (comma separated). Rows written before
 * `types` existed fall back to `type`.
 */
const LABELS = {
  customer: 'Customer (CNEE / bill-to)', agent: 'Overseas agent', forwarder: 'Forwarder (co-loader / NVOCC / other forwarder)', broker: 'Customs broker', trucker: 'Trucker', importer: 'Importer of record (consignee)',
  delivery: 'Delivery location / warehouse', shipper: 'Shipper / factory', vendor: 'Vendor (CFS / carrier / terminal / other)',
};
const SHORT = { customer: 'Customer', agent: 'Agent', forwarder: 'Forwarder', broker: 'Broker', trucker: 'Trucker', importer: 'Importer', delivery: 'Delivery', shipper: 'Shipper', vendor: 'Vendor' };

/** All roles of a party row, main role first. */
function of(c) {
  if (!c) return [];
  const list = String(c.types || '').split(',').map((t) => t.trim()).filter((t) => LABELS[t]);
  return [...new Set([c.type, ...list].filter(Boolean))];
}

const has = (c, t) => of(c).includes(t);

/** SQL condition: the party (table alias `a`) has any of these roles. Only known role names reach the SQL. */
function sql(types, a = '') {
  const p = a ? `${a}.` : '';
  const ok = [].concat(types).filter((t) => LABELS[t]);
  if (!ok.length) return '0';
  return `(${ok.map((t) => `(',' || COALESCE(NULLIF(${p}types, ''), ${p}type) || ',') LIKE '%,${t},%'`).join(' OR ')})`;
}

/** From a form: checked roles (array or single), main role = `type` if still checked, else the first checked. */
function fromForm(body, current = null) {
  const picked = [].concat(body.types || []).filter((t) => LABELS[t]);
  if (!picked.length && LABELS[body.type]) picked.push(body.type);
  if (!picked.length) return null;
  const order = Object.keys(LABELS);
  picked.sort((x, y) => order.indexOf(x) - order.indexOf(y));
  const main = (LABELS[body.type] && picked.includes(body.type) && body.type) || (current && picked.includes(current) && current) || picked[0];
  return { type: main, types: [main, ...picked.filter((t) => t !== main)].join(',') };
}

const label = (c) => of(c).map((t) => SHORT[t] || t).join(' · ');

module.exports = { LABELS, SHORT, of, has, sql, fromForm, label };
