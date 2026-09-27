const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gbl-trk-'));
process.env.TERMINAL49_API_KEY = 't49key';
process.env.TERMINAL49_WEBHOOK_SECRET = 'whsecret';
process.env.SHIPSGO_API_KEY = 'sgkey';
process.env.DATALASTIC_API_KEY = 'dlkey';
process.env.DCSA_CARRIERS = JSON.stringify({ HLCU: { baseUrl: 'https://api.hlag.test/hlag/external', headers: { 'X-IBM-Client-Id': 'id' } } });

const store = require('../src/db');
store.db = store.open(':memory:');
const S = require('../src/shipments');
const tracking = require('../src/tracking');
const codes = require('../src/tracking/codes');
const { seedDemo } = require('../src/seed');
const ids = seedDemo(store.db);

/** Minimal fetch mock: route table of [method, urlRegex] -> json body. Records calls. */
function mockFetch(routes) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    calls.push({ method, url, opts });
    const r = routes.find(([m, re]) => m === method && re.test(url));
    if (!r) return { ok: false, status: 404, json: async () => ({ message: `no route ${method} ${url}` }) };
    const body = typeof r[2] === 'function' ? r[2](url, opts) : r[2];
    return { ok: true, status: 200, json: async () => body };
  };
  fn.calls = calls;
  return fn;
}

test('carrier / airline detection', () => {
  assert.equal(codes.scacFromBl('HDMUPUSA7788990'), 'HDMU');
  assert.equal(codes.scacFromBl('MEDUXY123456'), 'MSCU');
  assert.equal(codes.detectScac({ mbl_no: 'SHZ8105615', containers: [{ container_no: 'CMAU1234567' }] }), 'CMDU');
  assert.deepEqual(codes.parseAwb('921-63150570'), { prefix: '921', serial: '63150570', awb: '921-63150570', airline: 'SF Airlines' });
  assert.equal(codes.parseAwb('12345'), null);
});

test('provider choice: air -> ShipsGo, carrier with API -> DCSA, else Terminal49', () => {
  const p = tracking.providers();
  assert.equal(tracking.chooseProvider({ mode: 'AIR', mbl_no: '921-63150570' }, p).name, 'shipsgo');
  assert.equal(tracking.chooseProvider({ mode: 'FCL', mbl_no: 'HLCUHAM123456', containers: [] }, p).name, 'dcsa');
  assert.equal(tracking.chooseProvider({ mode: 'FCL', mbl_no: 'HDMUPUSA7788990', containers: [] }, p).name, 'terminal49');
});

test('Terminal49: register B/L, resolve, map ETA/ATA + container LFD/holds, notify customer of ETA change', async () => {
  const s = S.list({ role: 'staff' }).find((x) => x.mbl_no === 'HDMUPUSA1234567');
  const oldEta = s.eta;
  const f = mockFetch([
    ['POST', /\/v2\/tracking_requests$/, (url, o) => {
      const body = JSON.parse(o.body);
      assert.equal(o.headers.Authorization, 'Token t49key');
      assert.deepEqual(body.data.attributes, { request_type: 'bill_of_lading', request_number: 'HDMUPUSA1234567', ref_numbers: [s.ref_no], scac: 'HDMU' });
      return { data: { id: 'tr-1', type: 'tracking_request', attributes: { status: 'pending' } } };
    }],
    ['GET', /\/v2\/tracking_requests\/tr-1$/, { data: { id: 'tr-1', attributes: { status: 'created' }, relationships: { tracked_object: { data: { id: 'sh-9', type: 'shipment' } } } } }],
    ['GET', /\/v2\/shipments\/sh-9\?include=containers$/, {
      data: { id: 'sh-9', type: 'shipment', attributes: {
        bill_of_lading_number: 'HDMUPUSA1234567', shipping_line_scac: 'HDMU', shipping_line_name: 'HMM',
        port_of_lading_name: 'Busan', port_of_discharge_name: 'Los Angeles',
        pol_etd_at: '2026-09-17T10:00:00Z', pol_atd_at: '2026-09-18T02:00:00Z',
        pod_eta_at: '2026-10-04T08:00:00Z', pod_original_eta_at: '2026-10-01T08:00:00Z', pod_ata_at: null,
        pod_vessel_name: 'HMM ALGECIRAS', pod_vessel_imo: '9863297', pod_voyage_number: '045E',
      } },
      included: [{ type: 'container', id: 'c1', attributes: {
        number: 'TCLU1234567', pickup_lfd: '2026-10-08T00:00:00Z', available_for_pickup: false,
        holds_at_pod_terminal: [{ name: 'customs', status: 'hold' }, { name: 'freight', status: 'released' }],
        pod_discharged_at: null, pod_full_out_at: null, empty_terminated_at: null, current_status: 'on_ship',
      } }],
    }],
    ['GET', /api\.datalastic\.com\/api\/v0\/vessel_pro\?api-key=dlkey&imo=9863297/, { data: { lat: 33.1, lon: -150.2, speed: 18.4, course: 85, destination: 'USLAX', last_position_UTC: '2026-09-27T01:00:00Z', mmsi: 440123000 } }],
  ]);
  tracking.setFetch(f);
  const r = await tracking.refreshShipment(s.id);
  assert.equal(r.ok, true, r.error);
  const after = S.find(s.id);
  assert.equal(after.tracking_provider, 'terminal49');
  assert.equal(after.tracking_ref, 'sh:sh-9');
  assert.equal(after.eta, '2026-10-04');
  assert.equal(after.atd, '2026-09-18');
  assert.equal(after.etd, '2026-09-17');
  assert.equal(after.vessel_imo, '9863297');
  assert.equal(after.last_free_day, '2026-10-08');
  assert.equal(after.available_for_pickup, 0);
  assert.equal(after.containers[0].holds, 'customs');
  assert.equal(after.vessel_lat, 33.1);
  assert.equal(after.vessel_mmsi, '440123000');
  assert.ok(r.changes.some((c) => c.field === 'eta' && c.from === oldEta));
  const ev = store.db.all("SELECT message FROM events WHERE shipment_id = ? AND type = 'ETA_CHANGED'", s.id);
  assert.equal(ev.length, 1);
  const mail = store.db.get("SELECT subject FROM emails WHERE shipment_id = ? AND kind = 'CUSTOMER_UPDATE' ORDER BY id DESC", s.id);
  assert.match(mail.subject, /ETA update/);

  // second poll: arrival -> status ARRIVED, no re-registration
  f.calls.length = 0;
  const arrived = mockFetch([['GET', /\/v2\/shipments\/sh-9/, (u) => ({ data: { id: 'sh-9', attributes: { pod_eta_at: '2026-10-04T08:00:00Z', pod_ata_at: '2026-10-04T06:00:00Z', pol_atd_at: '2026-09-18T02:00:00Z' } }, included: [] })]]);
  tracking.setFetch(arrived);
  await tracking.refreshShipment(s.id);
  assert.equal(arrived.calls.filter((c) => c.method === 'POST').length, 0);
  assert.equal(S.find(s.id).status, 'ARRIVED');
  assert.equal(S.find(s.id).ata, '2026-10-04');
});

test('Terminal49 failed lookup is surfaced, not thrown', async () => {
  const s = S.list({ role: 'staff' }).find((x) => x.mbl_no === 'ONEYSELA0098812');
  tracking.setFetch(mockFetch([
    ['POST', /tracking_requests$/, { data: { id: 'tr-2' } }],
    ['GET', /tracking_requests\/tr-2/, { data: { id: 'tr-2', attributes: { status: 'failed', failed_reason: 'not_found' }, relationships: {} } }],
  ]));
  const r = await tracking.refreshShipment(s.id);
  assert.equal(r.ok, false);
  assert.match(S.find(s.id).tracking_error, /not_found/);
});

test('ShipsGo air: MAWB tracked, ATA sets arrival', async () => {
  const s = S.list({ role: 'staff' }).find((x) => x.mbl_no === '180-12345675');
  tracking.setFetch(mockFetch([
    ['POST', /api\.shipsgo\.com\/v2\/air\/shipments$/, (u, o) => {
      assert.equal(o.headers['X-Shipsgo-User-Token'], 'sgkey');
      assert.equal(JSON.parse(o.body).awb_number, '18012345675');
      return { shipment: { id: 77 } };
    }],
    ['GET', /air\/shipments\/77$/, { shipment: { id: 77, status: 'IN_PROGRESS', route: { origin: { date_of_dep: '2026-09-30T01:00:00Z' }, destination: { date_of_rcf: '2026-10-01T05:00:00Z' } },
      movements: [{ event: 'DEP', status: 'ACT', timestamp: '2026-09-30T02:10:00Z', location: { code: 'ICN' }, flight: 'KE208' },
        { event: 'ARR', status: 'ACT', timestamp: '2026-09-30T20:00:00Z', location: { code: 'LAX' }, flight: 'KE208' }] } }],
  ]));
  const r = await tracking.refreshShipment(s.id);
  assert.equal(r.ok, true, r.error);
  const after = S.find(s.id);
  assert.equal(after.atd, '2026-09-30');
  assert.equal(after.ata, '2026-09-30');
  assert.equal(after.status, 'ARRIVED');
  assert.equal(store.db.all('SELECT * FROM tracking_events WHERE shipment_id = ?', s.id).length, 2);
});

test('DCSA carrier API: events mapped to ETD/ATD/ETA and container out-gate', async () => {
  const id = S.create({ mode: 'FCL', status: 'BOOKED', mbl_no: 'HLCUHAM2609001', customer_id: ids.unlockt });
  S.saveLines(id, { ctn_no: ['HLXU1234567'] });
  const tc = (loc, cls, type, when) => ({ eventType: 'TRANSPORT', eventClassifierCode: cls, transportEventTypeCode: type, eventDateTime: when,
    transportCall: { UNLocationCode: loc, carrierVoyageNumber: '012E', vessel: { vesselName: 'BERLIN EXPRESS', vesselIMONumber: '9501332' } } });
  tracking.setFetch(mockFetch([['GET', /api\.hlag\.test\/hlag\/external\/v2\/events\?transportDocumentReference=HLCUHAM2609001/, (u, o) => {
    assert.equal(o.headers['X-IBM-Client-Id'], 'id');
    return [
      tc('KRPUS', 'EST', 'DEPA', '2026-09-20T00:00:00Z'), tc('KRPUS', 'ACT', 'DEPA', '2026-09-21T03:00:00Z'),
      tc('USLAX', 'EST', 'ARRI', '2026-10-06T00:00:00Z'),
      { eventType: 'EQUIPMENT', eventClassifierCode: 'ACT', equipmentEventTypeCode: 'LOAD', equipmentReference: 'HLXU1234567', eventDateTime: '2026-09-20T10:00:00Z' },
    ];
  }]]));
  const r = await tracking.refreshShipment(id);
  assert.equal(r.ok, true, r.error);
  const s = S.find(id);
  assert.equal(s.tracking_provider, 'dcsa');
  assert.deepEqual([s.etd, s.atd, s.eta, s.ata], ['2026-09-20', '2026-09-21', '2026-10-06', null]);
  assert.equal(s.vessel, 'BERLIN EXPRESS');
  assert.equal(s.status, 'IN_TRANSIT');
});

test('Terminal49 webhook: rejects bad signature, refreshes matching shipment', async () => {
  const body = Buffer.from(JSON.stringify({ data: { type: 'webhook_notification' }, included: [{ attributes: { bill_of_lading_number: 'HDMUPUSA1234567' } }] }));
  assert.equal((await tracking.handleTerminal49Webhook(body, 'deadbeef')).status, 401);
  const sig = crypto.createHmac('sha256', 'whsecret').update(body).digest('hex');
  tracking.setFetch(mockFetch([['GET', /shipments\/sh-9/, { data: { id: 'sh-9', attributes: {} }, included: [] }]]));
  const r = await tracking.handleTerminal49Webhook(body, sig);
  assert.equal(r.status, 200);
  assert.equal(r.shipments, 1);
});
