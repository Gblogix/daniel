/**
 * Automatic ETD / ETA / vessel tracking.
 * Provider choice per shipment:
 *   AIR               -> ShipsGo (by MAWB)
 *   Ocean             -> the carrier's own DCSA API when credentials exist, else Terminal49, else ShipsGo
 * Vessel position    -> Datalastic (by IMO) and/or aisstream.io (by MMSI, coastal)
 * Updates flow through the normal shipment update path, so ETA changes / arrival notify the customer.
 */
const store = require('../db');
const S = require('../shipments');
const codes = require('./codes');

function env() {
  let dcsa = {};
  try { dcsa = JSON.parse(process.env.DCSA_CARRIERS || '{}'); } catch { console.error('DCSA_CARRIERS is not valid JSON'); }
  return {
    terminal49: process.env.TERMINAL49_API_KEY || '',
    terminal49Secret: process.env.TERMINAL49_WEBHOOK_SECRET || '',
    shipsgo: process.env.SHIPSGO_API_KEY || '',
    datalastic: process.env.DATALASTIC_API_KEY || '',
    aisstream: process.env.AISSTREAM_API_KEY || '',
    dcsa,
    hours: Number(process.env.TRACKING_INTERVAL_HOURS || 4),
  };
}

let fetchImpl = (...a) => fetch(...a);
function setFetch(f) { fetchImpl = f; }

function providers(e = env()) {
  const p = {};
  if (e.terminal49) p.terminal49 = require('./providers/terminal49').create({ apiKey: e.terminal49, fetchImpl: (...a) => fetchImpl(...a) });
  if (e.shipsgo) p.shipsgo = require('./providers/shipsgo').create({ apiKey: e.shipsgo, fetchImpl: (...a) => fetchImpl(...a) });
  if (Object.keys(e.dcsa).length) p.dcsa = require('./providers/dcsa').create({ carriers: e.dcsa, fetchImpl: (...a) => fetchImpl(...a) });
  return p;
}

function status() {
  const e = env();
  return {
    terminal49: Boolean(e.terminal49), shipsgo: Boolean(e.shipsgo), dcsa: Object.keys(e.dcsa),
    datalastic: Boolean(e.datalastic), aisstream: Boolean(e.aisstream), any: Object.keys(providers(e)).length > 0,
  };
}

function chooseProvider(s, p = providers()) {
  if (s.mode === 'AIR') return p.shipsgo || null;
  const scac = codes.detectScac(s);
  if (p.dcsa && p.dcsa.supports(scac)) return p.dcsa;
  return p.terminal49 || p.shipsgo || null;
}

/** Refresh one shipment. Returns { ok, changes, error }. */
async function refreshShipment(id, { db = store.db, userId = null } = {}) {
  let s = S.find(id, null, { db });
  if (!s) return { ok: false, error: 'not found' };
  if (!s.mbl_no) return saveStatus(db, s, { status: 'skipped', error: s.mode === 'AIR' ? 'No MAWB number' : 'No MBL number' });
  const p = providers();
  const provider = s.tracking_provider && p[s.tracking_provider] ? p[s.tracking_provider] : chooseProvider(s, p);
  if (!provider) return saveStatus(db, s, { status: 'skipped', error: 'No tracking provider configured for this mode' });
  const scac = codes.detectScac(s);
  const awb = s.mode === 'AIR' ? codes.parseAwb(s.mbl_no) : null;
  if (s.mode === 'AIR' && !awb) return saveStatus(db, s, { status: 'failed', error: 'MAWB must be 11 digits (e.g. 921-63150570)' });

  try {
    if (!s.tracking_ref || s.tracking_provider !== provider.name) {
      const reg = await provider.register(s, { scac, awb });
      db.run('UPDATE shipments SET tracking_provider = ?, tracking_ref = ?, scac = COALESCE(scac, ?) WHERE id = ?', provider.name, reg.ref, scac, id);
      s = S.find(id, null, { db });
    }
    const r = await provider.fetch(s);
    if (r.ref && r.ref !== s.tracking_ref) db.run('UPDATE shipments SET tracking_ref = ? WHERE id = ?', r.ref, id);
    if (r.status === 'failed' || r.status === 'pending' || r.status === 'skipped') return saveStatus(db, s, r);
    const changes = applyResult(db, s, r);
    await positionUpdate(db, S.find(id, null, { db }));
    saveStatus(db, s, { status: r.status, error: r.error || null });
    if (changes.length) await require('../notify').onShipmentChanged(id, changes, { db, userId });
    return { ok: true, changes };
  } catch (err) {
    return saveStatus(db, s, { status: 'error', error: err.message });
  }
}

function saveStatus(db, s, { status: st, error }) {
  db.run("UPDATE shipments SET tracking_status = ?, tracking_error = ?, tracking_checked_at = datetime('now') WHERE id = ?", st, error || null, s.id);
  return { ok: st !== 'error' && st !== 'failed', error: error || null, status: st, changes: [] };
}

/** Write provider data onto the shipment; returns the change list (same shape as S.update). */
function applyResult(db, s, r) {
  const patch = {};
  const set = (k, v) => { if (v != null && v !== '' && String(s[k] ?? '') !== String(v)) patch[k] = v; };
  set('etd', r.etd); set('eta', r.eta);
  set('atd', r.atd); set('ata', r.ata);
  if (!s.original_eta && (r.original_eta || s.eta || r.eta)) db.run('UPDATE shipments SET original_eta = ? WHERE id = ?', r.original_eta || s.eta || r.eta, s.id);
  if (s.mode !== 'AIR') { set('vessel', r.vessel); set('voyage', r.voyage); set('vessel_imo', r.vessel_imo); }
  if (r.flight_no && !s.flight_no) set('flight_no', r.flight_no);
  if (!s.carrier) set('carrier', r.carrier || codes.CARRIERS[r.scac] || (s.mode === 'AIR' ? codes.parseAwb(s.mbl_no)?.airline : null));
  if (!s.pol) set('pol', r.pol);
  if (!s.pod) set('pod', r.pod);

  // Container-level terminal data (LFD, availability, holds, out-gate, empty return).
  const ctns = r.containers || [];
  for (const c of ctns) {
    const have = s.containers.find((k) => k.container_no === c.container_no);
    if (!have) {
      if (s.mode === 'FCL' && c.container_no) {
        db.run('INSERT INTO containers (shipment_id, container_no) VALUES (?, ?)', s.id, c.container_no);
      } else continue;
    }
    db.run(`UPDATE containers SET pickup_lfd = COALESCE(?, pickup_lfd), available = COALESCE(?, available), holds = ?,
      discharged_at = COALESCE(?, discharged_at), full_out_at = COALESCE(?, full_out_at), empty_returned_at = COALESCE(?, empty_returned_at),
      current_status = COALESCE(?, current_status), location = COALESCE(?, location) WHERE shipment_id = ? AND container_no = ?`,
    c.pickup_lfd ?? null, c.available ?? null, c.holds ?? have?.holds ?? null, c.discharged_at ?? null, c.full_out_at ?? null,
    c.empty_returned_at ?? null, c.current_status ?? null, c.location ?? null, s.id, c.container_no);
  }
  if (ctns.length) {
    const lfds = ctns.map((c) => c.pickup_lfd).filter(Boolean).sort();
    if (lfds[0]) set('last_free_day', lfds[0]);
    if (ctns.some((c) => c.available != null)) set('available_for_pickup', ctns.every((c) => c.available === 1) ? 1 : 0);
    const outs = ctns.map((c) => c.full_out_at).filter(Boolean).sort();
    if (outs.length === ctns.length && !s.picked_up_at) set('picked_up_at', outs[outs.length - 1]);
    const empties = ctns.map((c) => c.empty_returned_at).filter(Boolean).sort();
    if (empties.length === ctns.length && !s.empty_returned_at) set('empty_returned_at', empties[empties.length - 1]);
  }

  // Status only moves forward.
  const idx = S.STATUS_INDEX[s.status] ?? 0;
  const at = (code) => S.STATUS_INDEX[code];
  let next = null;
  if ((patch.picked_up_at || s.picked_up_at) && idx < at('OUT_FOR_DELIVERY') && s.customs_status === 'RELEASED') next = 'OUT_FOR_DELIVERY';
  else if ((patch.ata || s.ata) && idx < at('ARRIVED')) next = 'ARRIVED';
  else if ((patch.atd || s.atd) && idx < at('IN_TRANSIT')) next = 'IN_TRANSIT';
  if (next) patch.status = next;

  for (const e of r.events || []) {
    if (!e.event || !e.event_time) continue;
    db.run(`INSERT OR IGNORE INTO tracking_events (shipment_id, container_no, event, classifier, event_time, location, vessel, voyage, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, s.id, e.container_no || '', e.event, e.classifier || '', e.event_time, e.location, e.vessel, e.voyage, r.source || null);
  }
  return Object.keys(patch).length ? S.update(s.id, patch, { db }) : [];
}

async function positionUpdate(db, s) {
  const e = env();
  if (!e.datalastic || s.mode === 'AIR' || !(s.vessel_imo || s.vessel_mmsi)) return;
  if (!['DEPARTED', 'IN_TRANSIT', 'CARGO_READY', 'BOOKED'].includes(s.status)) return;
  const { datalasticPosition } = require('./ais');
  try {
    const pos = await datalasticPosition({ apiKey: e.datalastic, imo: s.vessel_imo, mmsi: s.vessel_mmsi, fetchImpl });
    if (!pos) return;
    db.run(`UPDATE shipments SET vessel_lat = ?, vessel_lon = ?, vessel_speed = ?, vessel_course = ?, vessel_pos_at = ?,
      vessel_destination = ?, vessel_mmsi = COALESCE(vessel_mmsi, ?) WHERE id = ?`,
    pos.lat, pos.lon, pos.speed, pos.course, pos.at, pos.destination, pos.mmsi, s.id);
  } catch (err) {
    console.error(`Vessel position ${s.ref_no}:`, err.message);
  }
}

async function refreshAll({ db = store.db } = {}) {
  const rows = db.all(`SELECT id FROM shipments WHERE tracking_enabled = 1 AND mode <> 'OTHER' AND mbl_no IS NOT NULL AND mbl_no <> ''
    AND status <> 'DELIVERED' AND (empty_returned_at IS NULL OR mode <> 'FCL') ORDER BY COALESCE(eta, created_at)`);
  const out = { checked: 0, updated: 0, errors: 0 };
  for (const { id } of rows) {
    const r = await refreshShipment(id, { db });
    out.checked++;
    if (r.changes?.length) out.updated++;
    if (!r.ok && r.status !== 'skipped' && r.status !== 'pending') out.errors++;
    await new Promise((res) => setTimeout(res, 700)); // stay well under provider rate limits
  }
  return out;
}

let timers = [];
function start() {
  const e = env();
  const st = status();
  if (st.any) {
    const run = () => {
      if (store.db.setting('auto_tracking') !== '1') return;
      refreshAll().then((r) => console.log(`Tracking: checked ${r.checked}, updated ${r.updated}, errors ${r.errors}`))
        .catch((err) => console.error('Tracking:', err.message));
    };
    setTimeout(run, 30000);
    timers.push(setInterval(run, e.hours * 3600000));
  }
  if (e.aisstream && globalThis.WebSocket) timers.push(require('./ais').startAisStream({ apiKey: e.aisstream }));
  return st;
}
/**
 * Right after a file is created / saved / filled from documents: fetch ETD / ETA from the connected tracking source
 * in the background (only when a source is connected, the file has a B/L and it is not delivered yet).
 */
function refreshSoon(id, { db = store.db, userId = null } = {}) {
  if (!status().any || db.setting('auto_tracking') === '0') return false;
  const s = db.get('SELECT id, mbl_no, status, tracking_enabled FROM shipments WHERE id = ?', id);
  if (!s || !s.mbl_no || s.status === 'DELIVERED' || s.tracking_enabled === 0) return false;
  setImmediate(() => refreshShipment(id, { db, userId }).catch((e) => console.error('Tracking:', e.message)));
  return true;
}

function stop() { for (const t of timers) { if (t.stop) t.stop(); else clearInterval(t); } timers = []; }

/** Terminal49 webhook: verify signature, find the shipment by B/L, refresh it. */
async function handleTerminal49Webhook(rawBody, signature, { db = store.db } = {}) {
  const e = env();
  const t49 = require('./providers/terminal49').create({ apiKey: e.terminal49 });
  if (!t49.verifyWebhook(rawBody, signature, e.terminal49Secret)) return { status: 401 };
  let body;
  try { body = JSON.parse(rawBody.toString()); } catch { return { status: 400 }; }
  const bls = new Set();
  for (const inc of body.included || []) {
    if (inc.attributes?.bill_of_lading_number) bls.add(inc.attributes.bill_of_lading_number);
    if (inc.attributes?.request_number) bls.add(inc.attributes.request_number);
  }
  const ids = [...bls].flatMap((bl) => db.all("SELECT id FROM shipments WHERE REPLACE(mbl_no, ' ', '') = ? AND tracking_provider = 'terminal49'", bl).map((r) => r.id));
  for (const id of new Set(ids)) refreshShipment(id, { db }).catch((err) => console.error('Webhook refresh:', err.message));
  return { status: 200, shipments: ids.length };
}

module.exports = { refreshShipment, refreshSoon, refreshAll, start, stop, status, chooseProvider, applyResult, handleTerminal49Webhook, setFetch, providers };
