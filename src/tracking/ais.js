/**
 * Live vessel position (GPS / AIS).
 *  - Datalastic (paid, REST):  GET https://api.datalastic.com/api/v0/vessel_pro?api-key=KEY&imo=IMO — works mid-ocean.
 *  - aisstream.io (free, WebSocket): coastal receivers only (vessel near Busan / Shanghai / San Pedro Bay).
 *    Filtered by MMSI, so the MMSI must be known (Datalastic returns it, or enter it on the shipment).
 */
const store = require('../db');

async function datalasticPosition({ apiKey, imo, mmsi, fetchImpl = fetch }) {
  const q = imo ? `imo=${encodeURIComponent(imo)}` : `mmsi=${encodeURIComponent(mmsi)}`;
  const res = await fetchImpl(`https://api.datalastic.com/api/v0/vessel_pro?api-key=${encodeURIComponent(apiKey)}&${q}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Datalastic: ${body.meta?.message || body.message || `HTTP ${res.status}`}`);
  const d = body.data || {};
  if (d.lat == null || d.lon == null) return null;
  return {
    lat: Number(d.lat), lon: Number(d.lon), speed: d.speed ?? null, course: d.course ?? null,
    destination: d.destination || null, at: d.last_position_UTC || null, mmsi: d.mmsi ? String(d.mmsi) : null,
    eta: d.eta_UTC || null,
  };
}

/** Keeps one aisstream.io WebSocket open for the MMSIs of active shipments and saves each PositionReport. */
function startAisStream({ apiKey, db = store.db, WebSocketImpl = globalThis.WebSocket }) {
  let ws = null; let subscribed = ''; let stopped = false; let retry = null;
  const mmsis = () => db.all(`SELECT DISTINCT vessel_mmsi FROM shipments WHERE vessel_mmsi IS NOT NULL AND vessel_mmsi <> ''
    AND status IN ('DEPARTED','IN_TRANSIT','CARGO_READY') AND tracking_enabled = 1`).map((r) => r.vessel_mmsi).slice(0, 50);

  function connect() {
    const list = mmsis();
    subscribed = list.join(',');
    if (!list.length || stopped) return;
    ws = new WebSocketImpl('wss://stream.aisstream.io/v0/stream');
    ws.onopen = () => ws.send(JSON.stringify({
      APIKey: apiKey, BoundingBoxes: [[[-90, -180], [90, 180]]], FiltersShipMMSI: list, FilterMessageTypes: ['PositionReport'],
    }));
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString());
        const p = msg.Message?.PositionReport;
        if (!p) return;
        db.run(`UPDATE shipments SET vessel_lat = ?, vessel_lon = ?, vessel_speed = ?, vessel_course = ?, vessel_pos_at = ?
          WHERE vessel_mmsi = ? AND status <> 'DELIVERED'`, p.Latitude, p.Longitude, p.Sog, p.Cog,
        msg.MetaData?.time_utc ? String(msg.MetaData.time_utc).slice(0, 19).replace(' ', 'T') : new Date().toISOString().slice(0, 19),
        String(p.UserID));
      } catch { /* ignore malformed frames */ }
    };
    ws.onclose = () => { if (!stopped) retry = setTimeout(connect, 60000); };
    ws.onerror = () => {};
  }
  connect();
  // Re-subscribe when the set of vessels changes.
  const timer = setInterval(() => {
    if (mmsis().join(',') !== subscribed) { try { ws?.close(); } catch { /* reconnects via onclose */ } if (!ws) connect(); }
  }, 15 * 60000);
  return { stop() { stopped = true; clearInterval(timer); clearTimeout(retry); try { ws?.close(); } catch { /* noop */ } } };
}

module.exports = { datalasticPosition, startAisStream };
