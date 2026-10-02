/**
 * Customer portal: where every active shipment stands (phase counts), what arrives this week (calendar), and which
 * details a customer should not see (set per customer on Parties — e.g. empty return, LFD).
 */
const store = require('./db');

const PHASES = [
  { key: 'pickup', label: 'Pickup', statuses: ['BOOKED'] },
  { key: 'ready', label: 'Ready for departure', statuses: ['CARGO_READY'] },
  { key: 'transit', label: 'International transit', statuses: ['DEPARTED', 'IN_TRANSIT'] },
  { key: 'port', label: 'Arrived at port', statuses: ['ARRIVED', 'CUSTOMS_CLEARED'] },
  { key: 'gateout', label: 'Gate out', statuses: ['OUT_FOR_DELIVERY'] },
  { key: 'delivered', label: 'Delivered', statuses: ['DELIVERED'] },
];
const phaseOf = (s) => PHASES.find((p) => p.statuses.includes(s.status))?.key || 'pickup';

// What a customer can be kept from seeing.
const HIDE_OPTIONS = { empty: 'Empty container return', lfd: 'LFD / storage and pick-up appointment', vessel: 'Vessel position (map)', pickup: 'Pick-up location (terminal / CFS)' };

function hiddenFor(companyId, db = store.db) {
  if (!companyId) return new Set();
  const v = db.get('SELECT portal_hide FROM companies WHERE id = ?', companyId)?.portal_hide || '';
  return new Set(v.split(',').filter((k) => HIDE_OPTIONS[k]));
}

/** Phase counts over the files shown (delivered: last 30 days only). */
function phases(rows, now = new Date()) {
  const since = new Date(now.getTime() - 30 * 86400000).toISOString().slice(0, 10);
  const live = rows.filter((s) => s.status !== 'DELIVERED' || (s.delivery_date || s.ata || s.eta || '') >= since);
  const counts = PHASES.map((p) => ({ ...p, n: live.filter((s) => phaseOf(s) === p.key).length }));
  return { counts, active: live.filter((s) => s.status !== 'DELIVERED').length, total: live.length };
}

/** Seven days from Monday of the week `offset` weeks from now, with the shipments arriving each day. */
function week(rows, offset = 0, now = new Date()) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const monday = new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * 86400000 + offset * 7 * 86400000);
  return Array.from({ length: 7 }, (_, i) => {
    const day = new Date(monday.getTime() + i * 86400000).toISOString().slice(0, 10);
    return { day, list: rows.filter((s) => (s.ata || s.eta) === day) };
  });
}

module.exports = { PHASES, HIDE_OPTIONS, phaseOf, hiddenFor, phases, week };
