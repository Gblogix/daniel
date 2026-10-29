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

test('Outlook: a mail with big attachments is built as a draft, large files uploaded in pieces, then sent', async () => {
  graph._reset();
  const big = Buffer.alloc(4 * 1024 * 1024, 1); const small = Buffer.from('small pdf');
  const f = mockFetch((url, o) => tokenRoute(url)
    || (url.endsWith('/users/info%40gblogix.com/messages') && o.method === 'POST' ? { status: 201, body: { id: 'M1' } } : null)
    || (url.endsWith('/messages/M1/attachments') ? { status: 201, body: {} } : null)
    || (url.endsWith('/messages/M1/attachments/createUploadSession') ? { status: 201, body: { uploadUrl: 'https://upload.example/session' } } : null)
    || (url === 'https://upload.example/session' ? { status: 200, body: {} } : null)
    || (url.endsWith('/messages/M1/send') ? { status: 202 } : { status: 404, body: {} }));
  await graph.sendMail({ to: ['a@x.com'], subject: 'Big', html: '<p>x</p>', attachments: [{ filename: 'HBL.pdf', content: big }, { filename: 'PL.pdf', content: small }] }, { fetchImpl: f });
  const urls = f.calls.map((c) => c.url);
  const puts = f.calls.filter((c) => c.url === 'https://upload.example/session');
  assert.equal(puts.length, 2, '4 MB in two pieces');
  assert.equal(puts[0].opts.headers['Content-Range'], `bytes 0-${3276800 - 1}/${big.length}`);
  assert.ok(urls.some((u) => u.endsWith('/messages/M1/attachments')), 'small file attached directly');
  assert.ok(urls[urls.length - 1].endsWith('/messages/M1/send'), 'sent last');
  assert.ok(!urls.some((u) => u.endsWith('/sendMail')));
});

test('emails go out from the signed-in staff member\'s mailbox; the company mailbox when that one cannot be used', async () => {
  const notify = require('../src/notify');
  const ctx = require('../src/requestContext');
  const db = store.db;
  const uid = Number(db.run("INSERT INTO users (email, name, role, password_hash) VALUES ('james.test@gblogix.com', 'James Test', 'staff', 'x')").lastInsertRowid);
  const james = db.get('SELECT * FROM users WHERE id = ?', uid);
  const real = global.fetch;
  let mode = 'ok'; const sentVia = [];
  global.fetch = async (url, opts = {}) => {
    const t = tokenRoute(url); if (t) return { ok: true, status: 200, json: async () => t.body };
    const m = /\/users\/([^/]+)\/sendMail$/.exec(url);
    if (m) {
      const box = decodeURIComponent(m[1]); sentVia.push({ box, body: JSON.parse(opts.body) });
      if (mode === 'nobox' && box !== 'info@gblogix.com') return { ok: false, status: 404, json: async () => ({ error: { code: 'ErrorInvalidUser', message: 'The requested user is invalid.' } }) };
      return { ok: true, status: 202, json: async () => ({}) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  graph._reset();
  try {
    const send = () => ctx.run({ user: james }, () => notify.queueEmail({ kind: 'TEST', to: ['cust@example.com'], subject: 'A/N', html: '<p>x</p>' }));
    let id = await send();
    let e = db.get('SELECT * FROM emails WHERE id = ?', id);
    assert.deepEqual([e.status, e.from_addr, e.sent_from, sentVia.at(-1).box], ['SENT', 'james.test@gblogix.com', 'james.test@gblogix.com', 'james.test@gblogix.com']);

    mode = 'nobox';
    id = await send();
    e = db.get('SELECT * FROM emails WHERE id = ?', id);
    assert.equal(e.status, 'SENT');
    assert.equal(sentVia.at(-1).box, 'info@gblogix.com', 'fell back to the company mailbox');
    assert.deepEqual(sentVia.at(-1).body.message.replyTo, [{ emailAddress: { address: 'james.test@gblogix.com' } }], 'replies still reach James');
    assert.match(e.sent_from, /^info@gblogix\.com \(james\.test@gblogix\.com could not be used/);
    mode = 'ok';

    // Automatic email (no one signed in): the file's OP.
    const S = require('../src/shipments');
    const sid = S.create({ mode: 'FCL', hbl_no: 'FROM-OP', owner_id: uid });
    assert.equal(notify.senderFor(sid), 'james.test@gblogix.com');
    assert.equal(notify.senderFor(null), null, 'no file, no one signed in: company mailbox');
    // Not our domain, or switched off: company mailbox.
    assert.equal(ctx.run({ user: { ...james, email: 'james@gmail.com' } }, () => notify.senderFor(null)), null);
    db.setSetting('send_as_user', '0');
    assert.equal(ctx.run({ user: james }, () => notify.senderFor(null)), null);
    db.setSetting('send_as_user', '1');
  } finally { global.fetch = real; graph._reset(); }
});

test('staff send-from mailboxes: James and Jay matched once by name; a set mailbox is used for sending', () => {
  const { assignMailboxes } = require('../src/staffMail');
  const notify = require('../src/notify');
  const ctx = require('../src/requestContext');
  const db = store.db;
  db.run("DELETE FROM users WHERE email LIKE 'james%' OR email LIKE 'jay%' OR name LIKE 'James%' OR name LIKE 'Jae%'");
  const add = (email, name) => Number(db.run("INSERT INTO users (email, name, role, password_hash) VALUES (?, ?, 'staff', 'x')", email, name).lastInsertRowid);
  const james = add('james@gblogix.com', 'James Park');
  const jay = add('jaeho@gblogix.com', 'Jaeho Lee');
  const r = assignMailboxes();
  assert.deepEqual(r.map((x) => x.how), ['set', 'set']);
  assert.equal(db.get('SELECT mail_from FROM users WHERE id = ?', james).mail_from, 'jamesp@gblogix.com');
  assert.equal(db.get('SELECT mail_from FROM users WHERE id = ?', jay).mail_from, 'JayL@gblogix.com');
  const u = db.get('SELECT * FROM users WHERE id = ?', james);
  assert.equal(ctx.run({ user: u }, () => notify.senderFor(null)), 'jamesp@gblogix.com');
  add('james.k@gblogix.com', 'James Kim');
  db.run('UPDATE users SET mail_from = NULL');
  assert.match(assignMailboxes()[0].how, /2 possible users/, 'two Jameses: left to the admin');
});

test('A/N recipients are remembered per shipper: the next file of the same shipper gets them filled in', async () => {
  const notify = require('../src/notify');
  const S = require('../src/shipments');
  const db = store.db;
  const a = S.create({ mode: 'FCL', hbl_no: 'MEM-1', shipper_name: 'Seorin Company Co., Ltd.' });
  const b = S.create({ mode: 'FCL', hbl_no: 'MEM-2', shipper_name: 'SEORIN COMPANY' });
  const c = S.create({ mode: 'FCL', hbl_no: 'MEM-3', shipper_name: 'Other Maker Inc.' });
  assert.equal(notify.composeDefaults('AN', b).remembered, null, 'nothing sent yet');
  db.run("INSERT INTO emails (shipment_id, kind, to_addr, cc_addr, bcc_addr, subject, body_html, status) VALUES (?, 'BROKER_PACKET', 'ops@broker.example, cs@seorin.example', 'jamesp@gblogix.com', 'audit@gblogix.com', 'A/N', 'x', 'SENT')", a);
  const d = notify.composeDefaults('AN', b);
  assert.deepEqual([d.to, d.cc, d.bcc], [['ops@broker.example', 'cs@seorin.example'], ['jamesp@gblogix.com'], ['audit@gblogix.com']]);
  assert.equal(d.remembered.ref_no, S.find(a, null).ref_no);
  assert.equal(notify.composeDefaults('AN', c).remembered, null, 'another shipper: not used');
  assert.equal(notify.composeDefaults('DO', b).remembered, null, 'no D/O sent yet');
  assert.equal(d.remembered.who, 'SEORIN COMPANY CO., LTD.');
});

test('D/O recipients are remembered per trucker', () => {
  const notify = require('../src/notify');
  const S = require('../src/shipments');
  const db = store.db;
  const t1 = Number(db.run("INSERT INTO companies (name, type, emails) VALUES ('Sample Trucking', 'trucker', 'dispatch@sampletruck.example')").lastInsertRowid);
  const t2 = Number(db.run("INSERT INTO companies (name, type) VALUES ('Other Trucking', 'trucker')").lastInsertRowid);
  const a = S.create({ mode: 'FCL', hbl_no: 'DOM-1', trucker_id: t1 });
  const b = S.create({ mode: 'LCL', hbl_no: 'DOM-2', trucker_id: t1 });
  const c = S.create({ mode: 'FCL', hbl_no: 'DOM-3', trucker_id: t2 });
  assert.deepEqual(notify.composeDefaults('DO', b).to, ['dispatch@sampletruck.example'], 'nothing sent yet: the party email');
  db.run("INSERT INTO emails (shipment_id, kind, to_addr, cc_addr, subject, body_html, status) VALUES (?, 'DELIVERY_ORDER', 'dispatch@sampletruck.example, mike@sampletruck.example', 'jayl@gblogix.com', 'D/O', 'x', 'SENT')", a);
  const d = notify.composeDefaults('DO', b);
  assert.deepEqual([d.to, d.cc], [['dispatch@sampletruck.example', 'mike@sampletruck.example'], ['jayl@gblogix.com']]);
  assert.equal(d.remembered.who, 'Sample Trucking');
  assert.equal(notify.composeDefaults('DO', c).remembered, null, 'another trucker');
  assert.equal(notify.composeDefaults('AN', b).remembered, null, 'D/O addresses are not used for the A/N');
});
