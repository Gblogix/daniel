/**
 * Terminal49 — ocean container tracking by master B/L (docs: github.com/Terminal49/API, JSON:API).
 * Auth: "Authorization: Token <key>". Tracking is asynchronous: create a tracking request, then the
 * request resolves to a shipment we read on later polls (or when their webhook calls us).
 */
const crypto = require('node:crypto');

const BASE = 'https://api.terminal49.com/v2';
const day = (iso) => (iso ? String(iso).slice(0, 10) : null);

function create({ apiKey, fetchImpl = fetch }) {
  async function call(path, { method = 'GET', body } = {}) {
    const res = await fetchImpl(BASE + path, {
      method,
      headers: { Authorization: `Token ${apiKey}`, 'Content-Type': 'application/vnd.api+json', Accept: 'application/vnd.api+json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = data.errors?.map((e) => e.detail || e.title).join('; ') || `HTTP ${res.status}`;
      const err = new Error(`Terminal49: ${msg}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  return {
    name: 'terminal49',
    modes: ['FCL', 'LCL'],

    /** Register the B/L. Returns a provider reference to store on the shipment. */
    async register(s, { scac }) {
      const body = {
        data: {
          type: 'tracking_request',
          attributes: {
            request_type: 'bill_of_lading',
            request_number: s.mbl_no.replace(/\s/g, ''),
            ref_numbers: [s.ref_no],
            ...(scac ? { scac } : { auto_detect_vocc_scac: true }),
          },
        },
      };
      const data = await call('/tracking_requests', { method: 'POST', body });
      return { ref: `tr:${data.data.id}`, status: 'pending' };
    },

    async fetch(s) {
      let ref = s.tracking_ref || '';
      if (ref.startsWith('tr:')) {
        const tr = await call(`/tracking_requests/${ref.slice(3)}`);
        const a = tr.data.attributes;
        const shipmentId = tr.data.relationships?.tracked_object?.data?.id;
        if (a.status === 'failed') return { status: 'failed', error: `Carrier lookup failed: ${a.failed_reason || 'unknown'}`, ref };
        if (!shipmentId) return { status: 'pending', ref, error: a.status === 'awaiting_manifest' ? 'Waiting for carrier manifest' : null };
        ref = `sh:${shipmentId}`;
      }
      if (!ref.startsWith('sh:')) return { status: 'failed', error: 'No Terminal49 reference', ref };
      const data = await call(`/shipments/${ref.slice(3)}?include=containers`);
      return { ...mapShipment(data), ref };
    },

    /** Verify X-T49-Webhook-Signature (hex HMAC-SHA256 of the raw body). */
    verifyWebhook(rawBody, signature, secret) {
      if (!secret || !signature) return false;
      const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
      const a = Buffer.from(expected); const b = Buffer.from(String(signature));
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    },
  };
}

function mapShipment(doc) {
  const a = doc.data.attributes;
  const containers = (doc.included || []).filter((x) => x.type === 'container').map((c) => {
    const k = c.attributes;
    const holds = (k.holds_at_pod_terminal || []).filter((h) => h.status !== 'released' && h.status !== 'RELEASED')
      .map((h) => h.name || h.description || String(h)).join(', ');
    return {
      container_no: k.number,
      pickup_lfd: day(k.pickup_lfd),
      available: k.available_for_pickup == null ? null : k.available_for_pickup ? 1 : 0,
      holds: holds || null,
      discharged_at: day(k.pod_discharged_at),
      full_out_at: day(k.pod_full_out_at),
      empty_returned_at: day(k.empty_terminated_at),
      current_status: k.current_status || null,
      location: k.location_at_pod_terminal || null,
    };
  });
  return {
    status: a.line_tracking_stopped_at ? 'stopped' : 'tracking',
    error: a.line_tracking_stopped_reason || null,
    carrier: a.shipping_line_name || null,
    scac: a.shipping_line_scac || null,
    pol: a.port_of_lading_name || null,
    pod: a.port_of_discharge_name || null,
    etd: day(a.pol_etd_at), atd: day(a.pol_atd_at),
    eta: day(a.pod_eta_at), ata: day(a.pod_ata_at), original_eta: day(a.pod_original_eta_at),
    vessel: a.pod_vessel_name || null, vessel_imo: a.pod_vessel_imo ? String(a.pod_vessel_imo) : null, voyage: a.pod_voyage_number || null,
    containers,
    events: [],
  };
}

module.exports = { create, mapShipment };
