/**
 * ShipsGo v2 — ocean (container / B/L) and air (AWB) tracking.
 * Auth header: X-Shipsgo-User-Token. 1 credit per shipment created.
 * Field names follow ShipsGo v2 (movements with event codes + EST/ACT status); verify against
 * api.shipsgo.com/docs/v2 when the account is opened — the mapping below is defensive about missing fields.
 */
const BASE = 'https://api.shipsgo.com/v2';
const day = (iso) => (iso ? String(iso).slice(0, 10) : null);

function create({ apiKey, fetchImpl = fetch }) {
  async function call(path, { method = 'GET', body } = {}) {
    const res = await fetchImpl(BASE + path, {
      method,
      headers: { 'X-Shipsgo-User-Token': apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`ShipsGo: ${data.message || data.error || `HTTP ${res.status}`}`);
    return data;
  }

  return {
    name: 'shipsgo',
    modes: ['AIR', 'FCL', 'LCL'],

    async register(s, { scac, awb }) {
      if (s.mode === 'AIR') {
        const data = await call('/air/shipments', { method: 'POST', body: { awb_number: awb.prefix + awb.serial, reference: s.ref_no } });
        return { ref: `air:${(data.shipment || data).id}`, status: 'pending' };
      }
      const body = { booking_number: s.mbl_no, reference: s.ref_no, ...(scac ? { carrier: scac } : {}) };
      if (s.containers?.[0]) body.container_number = s.containers[0].container_no;
      const data = await call('/ocean/shipments', { method: 'POST', body });
      return { ref: `ocean:${(data.shipment || data).id}`, status: 'pending' };
    },

    async fetch(s) {
      const [kind, id] = String(s.tracking_ref || '').split(':');
      if (!id) return { status: 'failed', error: 'No ShipsGo reference', ref: s.tracking_ref };
      const data = await call(`/${kind === 'air' ? 'air' : 'ocean'}/shipments/${id}`);
      const sh = data.shipment || data;
      return { ...(kind === 'air' ? mapAir(sh) : mapOcean(sh)), ref: s.tracking_ref };
    },
  };
}

/** Pick the first/last movement matching event codes and status. */
function pick(moves, events, status, last = false) {
  const list = moves.filter((m) => events.includes(m.event) && (!status || m.status === status))
    .sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
  return last ? list[list.length - 1] : list[0];
}

function mapOcean(sh) {
  const containers = sh.containers || [];
  const moves = containers.flatMap((c) => (c.movements || []).map((m) => ({ ...m, container_no: c.number })));
  const dep = (st) => pick(moves, ['DEPA', 'LOAD'], st);
  const arr = (st) => pick(moves, ['ARRV', 'DISC'], st, true);
  const route = sh.route || {};
  const atd = dep('ACT'); const ata = arr('ACT');
  const vesselMove = pick(moves, ['DEPA', 'LOAD', 'ARRV', 'DISC'], null, true);
  return {
    status: ['DELIVERED', 'EMPTY_RETURNED'].includes(sh.status) ? 'finished' : 'tracking',
    pol: route.port_of_loading?.location?.name || null,
    pod: route.port_of_discharge?.location?.name || null,
    atd: day(atd?.timestamp),
    etd: day(dep('EST')?.timestamp || route.port_of_loading?.date_of_loading),
    ata: day(ata?.timestamp),
    eta: day(arr('EST')?.timestamp || route.port_of_discharge?.date_of_discharge),
    original_eta: day(route.port_of_discharge?.date_of_discharge_initial),
    vessel: vesselMove?.vessel?.name || null, vessel_imo: vesselMove?.vessel?.imo ? String(vesselMove.vessel.imo) : null,
    voyage: vesselMove?.voyage || null,
    containers: containers.map((c) => {
      const mv = c.movements || [];
      const gateOut = pick(mv, ['GTOT'], 'ACT', true);
      const empty = pick(mv, ['EMRT'], 'ACT', true);
      const disc = pick(mv, ['DISC'], 'ACT', true);
      return { container_no: c.number, discharged_at: day(disc?.timestamp), full_out_at: day(gateOut?.timestamp), empty_returned_at: day(empty?.timestamp), current_status: c.status || null };
    }),
    events: moves.map((m) => ({ container_no: m.container_no, event: m.event, classifier: m.status, event_time: m.timestamp, location: m.location?.name || m.location?.code || null, vessel: m.vessel?.name || null, voyage: m.voyage || null })),
  };
}

function mapAir(sh) {
  const route = sh.route || {};
  const moves = sh.movements || [];
  const dep = pick(moves, ['DEP'], 'ACT'); const arr = pick(moves, ['ARR', 'RCF'], 'ACT', true);
  return {
    status: sh.status === 'DELIVERED' ? 'finished' : 'tracking',
    carrier: sh.airline?.name || null,
    pol: route.origin?.location?.code || null, pod: route.destination?.location?.code || null,
    atd: day(dep?.timestamp), etd: day(pick(moves, ['DEP'], 'EST')?.timestamp || route.origin?.date_of_dep),
    ata: day(arr?.timestamp), eta: day(pick(moves, ['ARR', 'RCF'], 'EST', true)?.timestamp || route.destination?.date_of_rcf),
    flight_no: (dep || moves.find((m) => m.flight))?.flight || null,
    containers: [],
    events: moves.map((m) => ({ container_no: null, event: m.event, classifier: m.status, event_time: m.timestamp, location: m.location?.code || m.location?.name || null, vessel: m.flight || null, voyage: null })),
  };
}

module.exports = { create, mapOcean, mapAir };
