// Email not connected: actions say "not sent" (not "sent"); the setup page sends a test and re-sends held mail.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gbl-mail-'));
const store = require('../src/db');
store.db = store.open(':memory:');
require('../src/seed').seedDemo(store.db);
const db = store.db;
const { createApp } = require('../src/server');
const graph = require('../src/graph');

test('Microsoft errors come with what to do', () => {
  assert.match(graph.explain('AADSTS7000215: Invalid client secret provided.'), /new one/);
  assert.match(graph.explain('ErrorAccessDenied Access is denied.'), /Mail\.Send/);
  assert.match(graph.explain('MailboxNotEnabledForRESTAPI'), /MS_MAILBOX/);
});

test('not connected: the test email is held and the page says why', async () => {
  const server = createApp().listen(0); await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    let cookie = '';
    const keep = (res) => { const c = res.headers.getSetCookie?.() || []; if (c.length) cookie = c.map((x) => x.split(';')[0]).join('; '); return res; };
    const tok = async (p) => /name="_csrf" value="([^"]+)"/.exec(await keep(await fetch(base + p, { headers: { cookie } })).text())[1];
    let t = await tok('/login');
    keep(await fetch(`${base}/login`, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: t, email: 'admin@gblogix.com', password: 'changeme123' }) }));
    const page = await (await fetch(`${base}/admin/email-setup`, { headers: { cookie } })).text();
    assert.match(page, /Not connected/);
    assert.match(page, /Mail\.Send/);
    t = /name="_csrf" value="([^"]+)"/.exec(page)[1];
    const r = await fetch(`${base}/admin/email-setup/test`, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: t, to: 'me@example.com' }) });
    assert.equal(r.status, 302);
    assert.equal(db.get("SELECT status FROM emails WHERE kind = 'TEST' ORDER BY id DESC").status, 'LOGGED');
    const after = await (await fetch(base + r.headers.get('location'), { headers: { cookie } })).text();
    assert.match(after, /Not sent — email sending is not set up yet/);
    assert.match(after, /1<\/b> email\(s\) from the last 3 days were not sent/);
  } finally { server.close(); }
});
