const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gbl-ol-'));
Object.assign(process.env, { MS_TENANT_ID: 'tenant', MS_CLIENT_ID: 'client', MS_CLIENT_SECRET: 'secret', MS_MAILBOX: 'info@gblogix.com' });

const store = require('../src/db');
test.after(() => require('../src/docs/pdf').close());
store.db = store.open(':memory:');
const graph = require('../src/graph');
const mailin = require('../src/mailin');
const { seedDemo } = require('../src/seed');
const { shutdownOcr } = require('../src/extract/pdf');
seedDemo(store.db);
test.after(() => shutdownOcr());

function mockFetch(handler) {
  const calls = [];
  const fn = async (url, opts = {}) => { calls.push({ url, opts }); const { status = 200, body } = handler(url, opts) || {}; return { ok: status < 300, status, json: async () => body }; };
  fn.calls = calls;
  return fn;
}
const tokenRoute = (url) => (url.includes('login.microsoftonline.com/tenant/oauth2/v2.0/token') ? { body: { access_token: 'tok', expires_in: 3600 } } : null);

test('Outlook sendMail posts to Graph from the company mailbox with attachments', async () => {
  graph._reset();
  const f = mockFetch((url, o) => tokenRoute(url) || (url === 'https://graph.microsoft.com/v1.0/users/info%40gblogix.com/sendMail' ? { status: 202 } : { status: 404, body: {} }));
  await graph.sendMail({ to: ['a@x.com'], cc: ['b@x.com'], subject: 'S', html: '<p>hi</p>', attachments: [{ filename: 'AN.pdf', content: Buffer.from('pdf') }] }, { fetchImpl: f });
  const send = f.calls[1];
  assert.equal(send.opts.headers.Authorization, 'Bearer tok');
  const body = JSON.parse(send.opts.body);
  assert.equal(body.saveToSentItems, true);
  assert.deepEqual(body.message.toRecipients, [{ emailAddress: { address: 'a@x.com' } }]);
  assert.equal(body.message.attachments[0].name, 'AN.pdf');
  assert.equal(body.message.attachments[0].contentBytes, Buffer.from('pdf').toString('base64'));
  const token = new URLSearchParams(f.calls[0].opts.body);
  assert.equal(token.get('grant_type'), 'client_credentials');
  assert.equal(token.get('scope'), 'https://graph.microsoft.com/.default');
});

test('Outlook intake: agent email with PDF becomes an intake; unknown senders ignored; no duplicates', async () => {
  graph._reset();
  const pdf = fs.readFileSync(path.join(__dirname, 'fixtures', 'HBL_KMHB2410077.pdf'));
  const msgs = [
    { id: 'm1', subject: '[NSC/GLOBALBRIDGE] UB 3PL / BL#KMHB2410077', receivedDateTime: '2026-09-27T01:00:00Z', from: { emailAddress: { address: 'ops@twings.example' } },
      body: { contentType: 'text', content: 'MBL: HDMUPUSA7788990  HBL: KMHB2410077\nCNTR: CSQU3054383\nETD BUS: 02-OCT-2026  ETA: 16-OCT-2026\nISF NO: TWS26050088' },
      attachments: [{ '@odata.type': '#microsoft.graph.fileAttachment', name: 'HBL_KMHB2410077.pdf', contentType: 'application/pdf', contentBytes: pdf.toString('base64') }] },
    { id: 'm2', subject: 'Newsletter', receivedDateTime: '2026-09-27T02:00:00Z', from: { emailAddress: { address: 'news@random.example' } },
      attachments: [{ '@odata.type': '#microsoft.graph.fileAttachment', name: 'x.pdf', contentType: 'application/pdf', contentBytes: pdf.toString('base64') }] },
  ];
  const f = mockFetch((url) => tokenRoute(url) || (url.includes('/mailFolders/inbox/messages') ? { body: { value: msgs } } : { status: 404, body: {} }));
  const r1 = await mailin.pollOnce({ fetchImpl: f });
  assert.deepEqual(r1, { checked: 2, imported: 1 });
  const intake = store.db.get('SELECT * FROM intakes ORDER BY id DESC LIMIT 1');
  assert.match(intake.note, /ops@twings.example/);
  const draft = JSON.parse(intake.extracted_json).draft;
  assert.equal(draft.hbl_no, 'KMHB2410077');
  assert.equal(draft.isf_no, 'TWS26050088'); // only in the email body
  assert.ok(store.db.get("SELECT 1 FROM documents WHERE intake_id = ? AND filename = 'email-body.txt'", intake.id));
  assert.equal(store.db.setting('mail_intake_since'), '2026-09-27T02:00:00Z');
  const r2 = await mailin.pollOnce({ fetchImpl: f });
  assert.equal(r2.imported, 0);
  const list = f.calls.find((c) => c.url.includes('messages'));
  assert.match(decodeURIComponent(list.url), /hasAttachments eq true/);
  assert.equal(list.opts.headers.Prefer, 'outlook.body-content-type="text"');
});
