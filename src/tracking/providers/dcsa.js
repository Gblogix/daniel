/**
 * Direct carrier APIs using the DCSA Track & Trace 2.2 standard (GET /v2/events).
 * Each carrier needs its own developer-portal credentials. Configure with DCSA_CARRIERS, e.g.
 *   DCSA_CARRIERS='{"HLCU":{"baseUrl":"https://api.hlag.com/hlag/external","headers":{"X-IBM-Client-Id":"...","X-IBM-Client-Secret":"..."}},
 *                   "MAEU":{"baseUrl":"https://api.maersk.com/track-and-trace-private","headers":{"Consumer-Key":"..."},"path":"/events"}}'
 * Event mapping: DEPA / ARRI transport events with eventClassifierCode PLN|EST|ACT.
 */
const day = (iso) => (iso ? String(iso).slice(0, 10) : null);

function create({ carriers, fetchImpl = fetch }) {
  return {
    name: 'dcsa',
    modes: ['FCL', 'LCL'],
    supports: (scac) => Boolean(scac && carriers[scac]),

    // DCSA has no registration step: events are queried by transport document (B/L) reference.
    async register(s, { scac }) { return { ref: `${scac}:${s.mbl_no}`, status: 'tracking' }; },

    async fetch(s) {
      const [scac, bl] = String(s.tracking_ref || '').split(/:(.+)/);
      const c = carriers[scac];
      if (!c) return { status: 'failed', error: `No DCSA credentials for ${scac}`, ref: s.tracking_ref };
      const events = [];
      // Some carriers expect the B/L without the SCAC prefix.
      const refs = [...new Set([bl, bl.replace(new RegExp(`^${scac}`), '')])];
      for (const ref of refs) {
        const url = `${c.baseUrl.replace(/\/$/, '')}${c.path || '/v2/events'}?transportDocumentReference=${encodeURIComponent(ref)}&limit=100`;
        const res = await fetchImpl(url, { headers: { Accept: 'application/json', 'API-Version-Major': '2', ...(c.headers || {}) } });
        if (res.status === 404) continue;
        const data = await res.json().catch(() => []);
        if (!res.ok) throw new Error(`${scac} API: ${data.message || data.errorMessage || `HTTP ${res.status}`}`);
        events.push(...(Array.isArray(data) ? data : data.events || []));
        if (events.length) break;
      }
      if (!events.length) return { status: 'pending', error: 'Carrier returned no events yet', ref: s.tracking_ref };
      return { ...mapEvents(events), ref: s.tracking_ref };
    },
  };
}

function mapEvents(events) {
  const transport = events.filter((e) => e.eventType === 'TRANSPORT' && e.transportCall);
  const byTime = (a, b) => String(a.eventDateTime).localeCompare(String(b.eventDateTime));
  const deps = transport.filter((e) => e.transportEventTypeCode === 'DEPA').sort(byTime);
  const arrs = transport.filter((e) => e.transportEventTypeCode === 'ARRI').sort(byTime);
  // POL = first departure location; POD = last arrival location (transshipments in between).
  const polLoc = deps[0]?.transportCall.UNLocationCode || deps[0]?.transportCall.location?.UNLocationCode;
  const podLoc = arrs[arrs.length - 1]?.transportCall.UNLocationCode || arrs[arrs.length - 1]?.transportCall.location?.UNLocationCode;
  const at = (list, loc, cls) => list.filter((e) => (e.transportCall.UNLocationCode || e.transportCall.location?.UNLocationCode) === loc
    && cls.includes(e.eventClassifierCode)).sort(byTime).pop();
  const lastLeg = arrs[arrs.length - 1] || deps[deps.length - 1];
  const equip = events.filter((e) => e.eventType === 'EQUIPMENT' && e.equipmentReference);
  const ctns = [...new Set(equip.map((e) => e.equipmentReference))].map((no) => {
    const ev = equip.filter((e) => e.equipmentReference === no && e.eventClassifierCode === 'ACT');
    const find = (code, empty) => ev.filter((e) => e.equipmentEventTypeCode === code && (empty == null || (e.emptyIndicatorCode === 'EMPTY') === empty)).sort(byTime).pop();
    return {
      container_no: no,
      discharged_at: day(find('DISC')?.eventDateTime),
      full_out_at: day(find('GTOT', false)?.eventDateTime),
      empty_returned_at: day(find('GTIN', true)?.eventDateTime),
    };
  });
  return {
    status: 'tracking',
    pol: polLoc || null, pod: podLoc || null,
    atd: day(at(deps, polLoc, ['ACT'])?.eventDateTime), etd: day(at(deps, polLoc, ['EST', 'PLN'])?.eventDateTime),
    ata: day(at(arrs, podLoc, ['ACT'])?.eventDateTime), eta: day(at(arrs, podLoc, ['EST', 'PLN'])?.eventDateTime),
    vessel: lastLeg?.transportCall.vessel?.vesselName || null,
    vessel_imo: lastLeg?.transportCall.vessel?.vesselIMONumber || null,
    voyage: lastLeg?.transportCall.carrierVoyageNumber || lastLeg?.transportCall.exportVoyageNumber || null,
    containers: ctns,
    events: events.map((e) => ({
      container_no: e.equipmentReference || null,
      event: e.transportEventTypeCode || e.equipmentEventTypeCode || e.shipmentEventTypeCode || e.eventType,
      classifier: e.eventClassifierCode || null, event_time: e.eventDateTime,
      location: e.transportCall?.UNLocationCode || e.transportCall?.location?.UNLocationCode || null,
      vessel: e.transportCall?.vessel?.vesselName || null, voyage: e.transportCall?.carrierVoyageNumber || null,
    })),
  };
}

module.exports = { create, mapEvents };
