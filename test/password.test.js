// Temporary password from an admin → the user must choose their own at the first sign-in; anyone can change theirs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gbl-pw-'));
const store = require('../src/db');
store.db = store.open(':memory:');
require('../src/seed').seedDemo(store.db);
const db = store.db;
const { createApp } = require('../src/server');

let server; let base;
test.before(async () => { server = createApp().listen(0); await new Promise((r) => server.once('listening', r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());

async function session() {
  let cookie = '';
  const keep = (res) => { const c = res.headers.getSetCookie?.() || []; if (c.length) cookie = c.map((x) => x.split(';')[0]).join('; '); return res; };
  const token = async (p = '/login') => /name="_csrf" value="([^"]+)"/.exec(await keep(await fetch(base + p, { headers: { cookie } })).text())?.[1];
  const s = {
    get: async (p) => keep(await fetch(base + p, { headers: { cookie }, redirect: 'manual' })),
    post: async (p, body, from = p) => {
      const _csrf = await token(from);
      return keep(await fetch(base + p, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf, ...body }) }));
    },
    login: (email, password) => s.post('/login', { email, password }, '/login'),
  };
  return s;
}

test('invite with a temporary password → forced to pick a new one, then works normally', async () => {
  const admin = await session();
  await admin.login('admin@gblogix.com', 'changeme123');
  const r = await admin.post('/admin/users', { name: 'New Staff', email: 'new.staff@example.com', role: 'staff', password: 'Temp-12345' }, '/admin/users');
  assert.equal(r.status, 302);
  assert.equal(db.get("SELECT must_change_pw FROM users WHERE email = 'new.staff@example.com'").must_change_pw, 1);

  const u = await session();
  await u.login('new.staff@example.com', 'Temp-12345');
  const home = await u.get('/app');
  assert.equal(home.headers.get('location'), '/account/password', 'every page sends them to change the password');
  const page = await (await u.get('/account/password')).text();
  assert.match(page, /temporary password/);
  assert.doesNotMatch(page, /data-shell/);

  assert.equal((await u.post('/account/password', { current: 'wrong', password: 'Mine-98765', confirm: 'Mine-98765' }, '/account/password')).status, 400);
  assert.equal((await u.post('/account/password', { current: 'Temp-12345', password: 'short', confirm: 'short' }, '/account/password')).status, 400);
  assert.equal((await u.post('/account/password', { current: 'Temp-12345', password: 'Mine-98765', confirm: 'Mine-00000' }, '/account/password')).status, 400);
  assert.equal((await u.post('/account/password', { current: 'Temp-12345', password: 'Mine-98765', confirm: 'Mine-98765' }, '/account/password')).status, 302);
  assert.equal(db.get("SELECT must_change_pw FROM users WHERE email = 'new.staff@example.com'").must_change_pw, 0);
  assert.equal((await u.get('/app')).status, 200);

  const again = await session();
  assert.equal((await again.login('new.staff@example.com', 'Temp-12345')).status, 401, 'temporary password no longer works');
  assert.equal((await again.login('new.staff@example.com', 'Mine-98765')).status, 302);
});

test('an admin reset is temporary too; customers can change their own password', async () => {
  const admin = await session();
  await admin.login('admin@gblogix.com', 'changeme123');
  const cust = db.get("SELECT id, email, role, company_id FROM users WHERE role = 'customer' LIMIT 1");
  await admin.post('/admin/users', { id: String(cust.id), name: 'Customer', email: cust.email, role: 'customer', company_id: String(cust.company_id), active: '1', password: 'Reset-4321' }, '/admin/users');
  assert.equal(db.get('SELECT must_change_pw FROM users WHERE id = ?', cust.id).must_change_pw, 1);
  const c = await session();
  await c.login(cust.email, 'Reset-4321');
  assert.equal((await c.get('/track')).headers.get('location'), '/account/password');
  assert.equal((await c.post('/account/password', { current: 'Reset-4321', password: 'Cust-55555', confirm: 'Cust-55555' }, '/account/password')).status, 302);
  assert.equal((await c.get('/track')).status, 200);
  assert.match(await (await c.get('/track')).text(), /\/account\/password/, 'password link in the header');
});
