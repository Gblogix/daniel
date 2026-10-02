/**
 * Container journey in 12 stages (GoFreight "My Containers"): what is done, with its date, worked out from the file and
 * the tracking data — nobody ticks them by hand.
 *   1 Gate in · 2 ETD · 3 ETA · 4 ATA · 5 Unloaded from vessel · 6 LFD · 7 Appointment · 8 Gate out · 9 ETA door ·
 *   10 ATA door · 11 Empty returned · 12 Complete
 * LCL and air have no empty return; air has no vessel discharge.
 */
const S = require('./shipments');

const today = () => new Date().toISOString().slice(0, 10);
const past = (d) => Boolean(d) && String(d).slice(0, 10) <= today();

function stages(s, c = {}) {
  const idx = S.STATUS_INDEX[s.status] ?? 0;
  const air = s.mode === 'AIR';
  const fcl = s.mode === 'FCL';
  const lfd = c.pickup_lfd || s.last_free_day;
  const delivered = s.status === 'DELIVERED' || Boolean(s.pod_received);
  const gateOut = c.full_out_at || s.picked_up_at;
  const list = [
    { key: 'gate_in', label: air ? 'Received at origin' : 'Gate in', done: idx >= S.STATUS_INDEX.CARGO_READY || Boolean(s.atd), date: null },
    { key: 'etd', label: 'ETD', done: Boolean(s.atd) || idx >= S.STATUS_INDEX.DEPARTED, date: s.atd || s.etd },
    { key: 'eta', label: 'ETA', done: Boolean(s.eta) && (Boolean(s.atd) || idx >= S.STATUS_INDEX.DEPARTED), date: s.eta },
    { key: 'ata', label: 'ATA', done: Boolean(s.ata) || idx >= S.STATUS_INDEX.ARRIVED, date: s.ata },
    !air && { key: 'unloaded', label: 'Unloaded from vessel', done: Boolean(c.discharged_at) || c.available === 1 || Boolean(gateOut), date: c.discharged_at },
    { key: 'lfd', label: 'LFD', done: Boolean(lfd), date: lfd },
    { key: 'appt', label: 'Appointment', done: Boolean(s.pickup_appt) || Boolean(gateOut), date: s.pickup_appt },
    { key: 'gate_out', label: air ? 'Picked up' : 'Gate out', done: Boolean(gateOut) || idx >= S.STATUS_INDEX.OUT_FOR_DELIVERY, date: gateOut },
    { key: 'eta_door', label: 'ETA door', done: Boolean(s.delivery_date) || delivered, date: s.delivery_date },
    { key: 'ata_door', label: 'ATA door', done: delivered, date: delivered && past(s.delivery_date) ? s.delivery_date : null },
    fcl && { key: 'empty', label: 'Empty returned', done: Boolean(c.empty_returned_at || s.empty_returned_at), date: c.empty_returned_at || s.empty_returned_at },
  ].filter(Boolean);
  list.push({ key: 'complete', label: 'Complete', done: list.every((x) => x.done), date: null });
  // The current stage: the furthest one reached (some, like LFD, can be known early).
  let at = -1;
  list.forEach((x, i) => { if (x.done) at = i; });
  const current = list[at] || null;
  return { list, n: at + 1, total: list.length, current: current ? current.label : 'Not started', next: list.find((x) => !x.done)?.label || null };
}

/** Container lists: overdue = LFD passed and not out; to pick up = discharged / available and not out yet. */
function flags(s, c = {}) {
  const lfd = c.pickup_lfd || s.last_free_day;
  const out = Boolean(c.full_out_at || s.picked_up_at) || s.status === 'DELIVERED';
  const ready = Boolean(c.discharged_at) || c.available === 1 || s.available_for_pickup === 1 || S.STATUS_INDEX[s.status] >= S.STATUS_INDEX.ARRIVED;
  const emptyLate = s.mode === 'FCL' && out && !c.empty_returned_at && c.full_out_at && (Date.now() - Date.parse(c.full_out_at)) / 86400000 > 5;
  return { overdue: (!out && lfd && lfd < today()) || emptyLate, toPickUp: !out && ready, emptyLate };
}

module.exports = { stages, flags };
