/**
 * Microsoft 365 / Outlook via Microsoft Graph (app-only, client-credentials).
 * Azure app registration needs APPLICATION permissions:
 *   Mail.Send (sending notices)   Mail.ReadWrite (optional: pulling agent emails into intake)
 * Restrict it to the shared mailbox with an Exchange application access policy.
 */
const config = require('./config');

let token = null;

async function getToken(fetchImpl = fetch) {
  if (token && token.expires > Date.now() + 60000) return token.value;
  const { tenantId, clientId, clientSecret } = config.graph;
  const res = await fetchImpl(`https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId, client_secret: clientSecret, grant_type: 'client_credentials', scope: 'https://graph.microsoft.com/.default',
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Microsoft login failed: ${explain(body.error_description || body.error || String(res.status))}`);
  token = { value: body.access_token, expires: Date.now() + (body.expires_in || 3600) * 1000 };
  return token.value;
}

async function graph(path, { method = 'GET', body, fetchImpl = fetch, headers = {} } = {}) {
  const t = await getToken(fetchImpl);
  const res = await fetchImpl(`https://graph.microsoft.com/v1.0${path}`, {
    method,
    headers: { Authorization: `Bearer ${t}`, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 202 || res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Graph ${method} ${path.split('?')[0]}: ${explain(`${data.error?.code || ''} ${data.error?.message || res.status}`)}`);
  return data;
}

/** Microsoft's error text plus what to do about it. */
function explain(msg) {
  const m = String(msg);
  const tip = /AADSTS7000215|invalid_client|secret/i.test(m) ? 'the client secret is wrong or expired — make a new one (Certificates & secrets) and put it in MS_CLIENT_SECRET'
    : /AADSTS700016|AADSTS90002|not found in the directory|tenant/i.test(m) ? 'check MS_TENANT_ID and MS_CLIENT_ID (app registration › Overview)'
      : /ErrorAccessDenied|Access is denied|Authorization_RequestDenied|403/i.test(m) ? 'give the app the Microsoft Graph APPLICATION permissions Mail.Send and Mail.ReadWrite (needed for large attachments) and press "Grant admin consent"'
        : /MailboxNotEnabledForRESTAPI|ResourceNotFound|ErrorInvalidUser|MailboxNotFound/i.test(m) ? 'MS_MAILBOX must be a real Microsoft 365 mailbox (e.g. info@gblogix.com)'
          : '';
  return tip ? `${m.trim()} → ${tip}` : m.trim();
}

const recipients = (list) => list.filter(Boolean).map((address) => ({ emailAddress: { address } }));

const SMALL = 3 * 1024 * 1024;        // Graph takes attachments inline up to ~3 MB per request
const CHUNK = 320 * 1024 * 10;         // upload-session chunks must be multiples of 320 KiB

/**
 * Send an email from the configured mailbox (saved to its Sent Items). attachments: [{filename, content: Buffer}]
 * Small mails go in one call; with bigger attachments (B/L + P/L + C/I scans add up) the mail is built as a draft,
 * large files are uploaded in pieces, then it is sent.
 */
async function sendMail({ to, cc = [], bcc = [], replyTo = [], subject, html, attachments = [] }, { fetchImpl } = {}) {
  const head = {
    subject,
    body: { contentType: 'HTML', content: html },
    toRecipients: recipients(to),
    ccRecipients: recipients(cc),
    ...(bcc.length ? { bccRecipients: recipients(bcc) } : {}),
    ...(replyTo.length ? { replyTo: recipients(replyTo) } : {}),
  };
  const inline = (a) => ({ '@odata.type': '#microsoft.graph.fileAttachment', name: a.filename, contentBytes: a.content.toString('base64') });
  const mb = `/users/${encodeURIComponent(config.graph.mailbox)}`;
  const size = attachments.reduce((n, a) => n + a.content.length, 0);
  if (size <= SMALL) {
    await graph(`${mb}/sendMail`, { method: 'POST', body: { message: { ...head, attachments: attachments.map(inline) }, saveToSentItems: true }, fetchImpl });
    return;
  }
  const draft = await graph(`${mb}/messages`, { method: 'POST', body: head, fetchImpl });
  for (const a of attachments) {
    if (a.content.length < SMALL) { await graph(`${mb}/messages/${draft.id}/attachments`, { method: 'POST', body: inline(a), fetchImpl }); continue; }
    const s = await graph(`${mb}/messages/${draft.id}/attachments/createUploadSession`, {
      method: 'POST', body: { AttachmentItem: { attachmentType: 'file', name: a.filename, size: a.content.length } }, fetchImpl,
    });
    for (let from = 0; from < a.content.length; from += CHUNK) {
      const part = a.content.subarray(from, Math.min(from + CHUNK, a.content.length));
      const res = await (fetchImpl || fetch)(s.uploadUrl, {
        method: 'PUT', body: part,
        headers: { 'Content-Length': String(part.length), 'Content-Range': `bytes ${from}-${from + part.length - 1}/${a.content.length}` },
      });
      if (!res.ok) throw new Error(`Uploading ${a.filename} failed (${res.status}) — the file may be too large for email; send a portal link instead`);
    }
  }
  await graph(`${mb}/messages/${draft.id}/send`, { method: 'POST', fetchImpl });
}

/** Messages with attachments received after `since` (ISO), newest last, with file attachments expanded. */
async function listInboxWithAttachments(since, { fetchImpl, folder = config.graph.intakeFolder } = {}) {
  const filter = `hasAttachments eq true and receivedDateTime ge ${since}`;
  const path = `/users/${encodeURIComponent(config.graph.mailbox)}/mailFolders/${encodeURIComponent(folder)}/messages`
    + `?$filter=${encodeURIComponent(filter)}&$orderby=receivedDateTime asc&$top=25`
    + '&$select=id,subject,from,receivedDateTime,bodyPreview,body&$expand=attachments';
  // Plain-text body: pre-alerts carry the MBL / HBL / CNTR / ETD / ETA table in the email itself.
  const data = await graph(path, { fetchImpl, headers: { Prefer: 'outlook.body-content-type="text"' } });
  return (data?.value || []).map((m) => ({
    id: m.id, subject: m.subject, receivedAt: m.receivedDateTime, preview: m.bodyPreview, body: m.body?.content || '',
    from: m.from?.emailAddress?.address?.toLowerCase() || '',
    attachments: (m.attachments || [])
      .filter((a) => a['@odata.type'] === '#microsoft.graph.fileAttachment' && a.contentBytes)
      .map((a) => ({ filename: a.name, mime: a.contentType, content: Buffer.from(a.contentBytes, 'base64') })),
  }));
}

module.exports = { explain, sendMail, listInboxWithAttachments, getToken, _reset: () => { token = null; } };
