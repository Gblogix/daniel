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
  if (!res.ok) throw new Error(`Microsoft login failed: ${body.error_description || body.error || res.status}`);
  token = { value: body.access_token, expires: Date.now() + (body.expires_in || 3600) * 1000 };
  return token.value;
}

async function graph(path, { method = 'GET', body, fetchImpl = fetch } = {}) {
  const t = await getToken(fetchImpl);
  const res = await fetchImpl(`https://graph.microsoft.com/v1.0${path}`, {
    method,
    headers: { Authorization: `Bearer ${t}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 202 || res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Graph ${method} ${path.split('?')[0]}: ${data.error?.message || res.status}`);
  return data;
}

const recipients = (list) => list.filter(Boolean).map((address) => ({ emailAddress: { address } }));

/** Send an email from the configured mailbox (saved to its Sent Items). attachments: [{filename, content: Buffer}] */
async function sendMail({ to, cc = [], subject, html, attachments = [] }, { fetchImpl } = {}) {
  const message = {
    subject,
    body: { contentType: 'HTML', content: html },
    toRecipients: recipients(to),
    ccRecipients: recipients(cc),
    attachments: attachments.map((a) => ({
      '@odata.type': '#microsoft.graph.fileAttachment', name: a.filename, contentBytes: a.content.toString('base64'),
    })),
  };
  const size = attachments.reduce((n, a) => n + a.content.length, 0);
  if (size > 3 * 1024 * 1024) throw new Error('Attachments over 3 MB total — send a portal link instead');
  await graph(`/users/${encodeURIComponent(config.graph.mailbox)}/sendMail`, { method: 'POST', body: { message, saveToSentItems: true }, fetchImpl });
}

/** Messages with attachments received after `since` (ISO), newest last, with file attachments expanded. */
async function listInboxWithAttachments(since, { fetchImpl, folder = config.graph.intakeFolder } = {}) {
  const filter = `hasAttachments eq true and receivedDateTime ge ${since}`;
  const path = `/users/${encodeURIComponent(config.graph.mailbox)}/mailFolders/${encodeURIComponent(folder)}/messages`
    + `?$filter=${encodeURIComponent(filter)}&$orderby=receivedDateTime asc&$top=25`
    + '&$select=id,subject,from,receivedDateTime,bodyPreview&$expand=attachments';
  const data = await graph(path, { fetchImpl });
  return (data?.value || []).map((m) => ({
    id: m.id, subject: m.subject, receivedAt: m.receivedDateTime, preview: m.bodyPreview,
    from: m.from?.emailAddress?.address?.toLowerCase() || '',
    attachments: (m.attachments || [])
      .filter((a) => a['@odata.type'] === '#microsoft.graph.fileAttachment' && a.contentBytes)
      .map((a) => ({ filename: a.name, mime: a.contentType, content: Buffer.from(a.contentBytes, 'base64') })),
  }));
}

module.exports = { sendMail, listInboxWithAttachments, getToken, _reset: () => { token = null; } };
