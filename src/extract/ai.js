/**
 * Optional AI extraction using the Claude API. Enabled when ANTHROPIC_API_KEY is set.
 * Handles scanned PDFs and unusual layouts that the regex rules miss (incl. packing-list line items).
 */
const { z } = require('zod');
const config = require('../config');

const str = z.string().nullable();
const numN = z.number().nullable();

const Extraction = z.object({
  doc_type: z.enum(['MBL', 'HBL', 'PL', 'CI', 'ISF', 'AWB', 'NOA', 'DO', 'OTHER']),
  mbl_no: str, hbl_no: str, mawb_no: str, hawb_no: str,
  carrier: str, vessel: str, voyage: str, flight_no: str,
  pol: str, pod: str, place_of_delivery: str,
  etd: str.describe('YYYY-MM-DD'), eta: str.describe('YYYY-MM-DD'),
  shipper_name: str, consignee_name: str, notify_party: str,
  packages: numN, package_unit: str, weight_kg: numN, cbm: numN, chargeable_weight: numN, commodity: str,
  firms_code: str.describe('4-character CBP FIRMS code of the freight location, e.g. Z955'),
  freight_location: str.describe('terminal / CFS / warehouse where cargo is available'),
  last_free_day: str.describe('YYYY-MM-DD'),
  ci_invoice_no: str.describe('commercial invoice number'), cargo_value: numN.describe('commercial invoice total value'),
  isf_no: str, telex_release: z.boolean().nullable(),
  containers: z.array(z.object({
    container_no: z.string(), seal_no: str, size_type: str.describe('e.g. 20GP, 40GP, 40HC'),
    packages: numN, weight_kg: numN, cbm: numN,
  })),
  items: z.array(z.object({
    po_no: str, description: z.string(), hs_code: str, quantity: numN, unit: str,
    packages: numN, weight_kg: numN, cbm: numN, unit_price: numN, amount: numN,
  })).describe('Packing list / invoice line items; empty for B/L'),
});

const PROMPT = `You are reading an international shipping document for a US freight forwarder (import side).
Extract the fields defined by the output schema. Rules:
- Use null for anything not present; never guess numbers.
- Dates as YYYY-MM-DD. "Shipped on board" / sailing date is the ETD.
- weight_kg is GROSS weight in kilograms (convert LBS if needed). cbm is total measurement in cubic meters.
- Container numbers are 4 letters + 7 digits with no spaces (e.g. TCLU1234567).
- On a house B/L the "B/L No." is the hbl_no; the carrier's master B/L number (if shown) is mbl_no.
- items: one entry per packing-list / invoice line (skip subtotal and total rows).
- For scanned documents read numbers character by character; B/L, container and seal numbers must be exact.`;

let client;
function getClient() {
  if (!client) {
    const Anthropic = require('@anthropic-ai/sdk');
    client = new Anthropic();
  }
  return client;
}

async function extractAI({ buffer, filename, mime, text, pages = null, docType = null }) {
  const { zodOutputFormat } = require('@anthropic-ai/sdk/helpers/zod');
  const isPdf = mime === 'application/pdf' || /\.pdf$/i.test(filename);
  const content = [];
  if (isPdf) {
    content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') } });
  } else if (/^image\/(jpeg|png)$/.test(mime) || /\.(jpe?g|png)$/i.test(filename)) {
    const media = /png$/i.test(mime) || /\.png$/i.test(filename) ? 'image/png' : 'image/jpeg';
    content.push({ type: 'image', source: { type: 'base64', media_type: media, data: buffer.toString('base64') } });
  } else if (text && text.trim()) {
    content.push({ type: 'text', text: `<document filename="${filename}">\n${text}\n</document>` });
  } else {
    return null;
  }
  const focus = pages ? `\nThis file contains several documents. Extract ONLY from page(s) ${pages.join(', ')}${docType ? ` (the ${docType})` : ''}.` : '';
  content.push({ type: 'text', text: `${PROMPT}\nFilename: ${filename}${focus}` });

  const response = await getClient().messages.parse({
    model: config.ai.model,
    max_tokens: 16000,
    messages: [{ role: 'user', content }],
    output_config: { format: zodOutputFormat(Extraction) },
  });
  if (response.stop_reason === 'refusal') throw new Error('AI extraction declined the document');
  if (!response.parsed_output) throw new Error(`AI extraction returned no data (stop_reason: ${response.stop_reason})`);
  return response.parsed_output;
}

module.exports = { extractAI, Extraction };
