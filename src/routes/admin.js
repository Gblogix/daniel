const express = require('express');
const store = require('../db');
const auth = require('../auth');
const notify = require('../notify');

const router = express.Router();
const COMPANY_TYPES = {
  customer: 'Customer (CNEE / bill-to)', agent: 'Overseas agent', broker: 'Customs broker', trucker: 'Trucker', importer: 'Importer of record (consignee)',
  delivery: 'Delivery location / warehouse', shipper: 'Shipper / factory',
};
const flash = (req, type, msg) => { req.session.flash = { type, msg }; };

// ---------- companies (parties) — staff can manage ----------
router.get('/companies', auth.requireInternal, (req, res) => {
  const rows = store.db.all(`SELECT c.*, (SELECT COUNT(*) FROM users u WHERE u.company_id = c.id) AS users FROM companies c ORDER BY c.type, c.name`);
  res.render('admin/companies', { title: 'Parties', rows, COMPANY_TYPES, edit: null });
});
router.get('/companies/:id', auth.requireInternal, (req, res) => {
  const edit = store.db.get('SELECT * FROM companies WHERE id = ?', Number(req.params.id));
  const rows = store.db.all(`SELECT c.*, (SELECT COUNT(*) FROM users u WHERE u.company_id = c.id) AS users FROM companies c ORDER BY c.type, c.name`);
  res.render('admin/companies', { title: 'Parties', rows, COMPANY_TYPES, edit });
});
router.post('/companies', auth.requireInternal, (req, res) => {
  const { id, name, type, country, emails, phone, address, billing_emails, short_name } = req.body;
  const terms = req.body.terms_days === '' || req.body.terms_days == null ? null : Number(req.body.terms_days);
  if (!name || !COMPANY_TYPES[type]) { flash(req, 'err', 'Name and type are required'); return res.redirect('/companies'); }
  if (id) store.db.run('UPDATE companies SET name = ?, type = ?, country = ?, emails = ?, phone = ?, address = ?, billing_emails = ?, terms_days = ?, short_name = ? WHERE id = ?', name, type, country, emails, phone, address, billing_emails, terms, short_name, Number(id));
  else store.db.run('INSERT INTO companies (name, type, country, emails, phone, address, billing_emails, terms_days, short_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', name, type, country, emails, phone, address, billing_emails, terms, short_name);
  flash(req, 'ok', 'Saved');
  res.redirect('/companies');
});

// ---------- users — admin only ----------
router.get('/admin/users', auth.requireRole('admin'), (req, res) => {
  const users = store.db.all('SELECT u.*, c.name AS company_name FROM users u LEFT JOIN companies c ON c.id = u.company_id ORDER BY u.role, u.name');
  const companies = store.db.all('SELECT id, name, type FROM companies ORDER BY name');
  res.render('admin/users', { title: 'Users & access', users, companies });
});
router.post('/admin/users', auth.requireRole('admin'), (req, res) => {
  const { id, email, name, role, company_id, password, active } = req.body;
  const acct = role === 'staff' && req.body.can_accounting ? 1 : 0;
  if (!auth.ROLES[role]) { flash(req, 'err', 'Invalid role'); return res.redirect('/admin/users'); }
  const external = !auth.INTERNAL.includes(role);
  const companyId = Number(company_id) || null;
  if (external && !companyId) { flash(req, 'err', 'Customer / agent / broker / trucker users must belong to a company'); return res.redirect('/admin/users'); }
  try {
    if (id) {
      if (Number(id) === req.user.id && (role !== 'admin' || !active)) { flash(req, 'err', 'You cannot remove your own admin access'); return res.redirect('/admin/users'); }
      store.db.run('UPDATE users SET email = ?, name = ?, role = ?, company_id = ?, active = ?, can_accounting = ? WHERE id = ?', email, name, role, companyId, active ? 1 : 0, acct, Number(id));
      if (password) store.db.run('UPDATE users SET password_hash = ? WHERE id = ?', auth.hashPassword(password), Number(id));
    } else {
      if (!password || password.length < 8) { flash(req, 'err', 'Password must be at least 8 characters'); return res.redirect('/admin/users'); }
      store.db.run('INSERT INTO users (email, name, role, company_id, password_hash, can_accounting) VALUES (?, ?, ?, ?, ?, ?)', email, name, role, companyId, auth.hashPassword(password), acct);
    }
    flash(req, 'ok', 'User saved');
  } catch (e) {
    flash(req, 'err', /UNIQUE/.test(e.message) ? 'That email is already in use' : e.message);
  }
  res.redirect('/admin/users');
});

// ---------- settings — admin only ----------
const SETTINGS = [
  ['auto_send_docs_received', 'When agent documents are applied: auto-send A/N + HBL/PL/CI to customs broker and shipment details to customer'],
  ['auto_send_do', 'When customs status becomes RELEASED: auto-send D/O to trucker'],
  ['auto_notify_status', 'When status / ETA / delivery schedule / customs changes: auto-email the customer'],
  ['auto_tracking', 'Carrier / GPS tracking: update ETD, ETA, vessel, LFD and terminal status automatically'],
  ['lfd_alerts', 'Daily 7am LFD / pickup digest email to staff'],
  ['smartsheet_sync', 'Smartsheet: import shipments, P/L and documents from the shared sheets every 30 min'],
  ['smartsheet_push', 'Smartsheet: write ETA / ETD back to the shared sheets ("old > new" style) — changes the customer\'s sheet'],
];
router.get('/admin/settings', auth.requireRole('admin'), (req, res) => {
  res.render('admin/settings', {
    title: 'Automation settings', settings: SETTINGS.map(([k, label]) => ({ k, label, on: store.db.setting(k) === '1' })),
    tracking: require('../tracking').status(),
    smartsheet: { token: Boolean(process.env.SMARTSHEET_TOKEN), last: (() => { try { return JSON.parse(store.db.setting('smartsheet_last_sync') || 'null'); } catch { return null; } })() },
  });
});
router.post('/admin/smartsheet/run', auth.requireRole('admin'), async (req, res) => {
  const r = await require('../smartsheet').syncAll();
  flash(req, r.some((x) => x.error) ? 'err' : 'ok', `Smartsheet: ${r.map((x) => (x.error ? `${x.sheet}: ${x.error}` : `${x.sheet} +${x.created} new, ${x.updated} updated, ${x.attachments} files`)).join(' | ') || 'no sheets'}`);
  res.redirect('/admin/settings');
});
router.post('/admin/tracking/run', auth.requireRole('admin'), async (req, res) => {
  const r = await require('../tracking').refreshAll();
  flash(req, 'ok', `Tracking: checked ${r.checked}, updated ${r.updated}, errors ${r.errors}`);
  res.redirect('/admin/settings');
});
router.post('/admin/settings', auth.requireRole('admin'), (req, res) => {
  for (const [k] of SETTINGS) store.db.setSetting(k, req.body[k] ? '1' : '0');
  flash(req, 'ok', 'Settings saved');
  res.redirect('/admin/settings');
});

// ---------- company profile & numbering — admin only ----------
const SEQS = [['OI', 'Ocean import filing no. (OI-#####)'], ['AI', 'Air import filing no. (AI-#####)'], ['OTH', 'Trucking / other filing no. (OTH#######)'],
  ['INV', 'AR invoice no. (INV-#####)'], ['DCN', 'Debit / credit note no. (DCN-#####)']];
router.get('/admin/company', auth.requireRole('admin'), (req, res) => {
  const company = require('../company');
  res.render('admin/company', { title: 'Company profile', co: company.get(), seqs: SEQS.map(([k, label]) => ({ k, label, v: store.db.setting(`seq_${k}`) })), terms: store.db.setting('ar_terms_days') });
});
router.post('/admin/company', auth.requireRole('admin'), (req, res) => {
  require('../company').set(req.body);
  for (const [k] of SEQS) {
    const v = Number(req.body[`seq_${k}`]);
    if (Number.isInteger(v) && v > 0) store.db.setSetting(`seq_${k}`, v);
  }
  if (Number.isInteger(Number(req.body.ar_terms_days))) store.db.setSetting('ar_terms_days', Number(req.body.ar_terms_days));
  flash(req, 'ok', 'Company profile saved');
  res.redirect('/admin/company');
});

// ---------- outbox — staff ----------
router.get('/outbox', auth.requireInternal, (req, res) => {
  const hide = auth.canAccounting(req.user) ? '' : `WHERE e.kind NOT IN (${auth.ACCOUNTING_EMAILS.map((k) => `'${k}'`).join(',')})`;
  const rows = store.db.all(`SELECT e.id, e.kind, e.to_addr, e.subject, e.status, e.error, e.created_at, e.sent_at, s.ref_no, e.shipment_id
    FROM emails e LEFT JOIN shipments s ON s.id = e.shipment_id ${hide} ORDER BY e.id DESC LIMIT 300`);
  res.render('admin/outbox', { title: 'Email outbox', rows });
});
router.get('/outbox/:id', auth.requireInternal, (req, res) => {
  const e = store.db.get('SELECT * FROM emails WHERE id = ?', Number(req.params.id));
  if (!e || (auth.ACCOUNTING_EMAILS.includes(e.kind) && !auth.canAccounting(req.user))) return res.status(404).render('error', { title: 'Not found', message: 'Email not found.' });
  e.attachments = JSON.parse(e.attachments_json || '[]');
  res.render('admin/email', { title: e.subject, e });
});
router.get('/outbox/:id/body', auth.requireInternal, (req, res) => {
  const e = store.db.get('SELECT kind, body_html FROM emails WHERE id = ?', Number(req.params.id));
  if (!e || (auth.ACCOUNTING_EMAILS.includes(e.kind) && !auth.canAccounting(req.user))) return res.status(404).end();
  res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:");
  res.type('html').send(e.body_html);
});
router.post('/outbox/:id/resend', auth.requireInternal, async (req, res) => {
  const k = store.db.get('SELECT kind FROM emails WHERE id = ?', Number(req.params.id));
  if (!k || (auth.ACCOUNTING_EMAILS.includes(k.kind) && !auth.canAccounting(req.user))) return res.status(404).end();
  await notify.deliver(Number(req.params.id));
  flash(req, 'ok', 'Delivery re-attempted');
  res.redirect(`/outbox/${req.params.id}`);
});

module.exports = router;
