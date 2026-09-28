const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const store = require('./db');

const ROLES = {
  admin: { label: 'Admin', home: '/dashboard' },
  staff: { label: 'Staff', home: '/dashboard' },
  customer: { label: 'Customer (CNEE)', home: '/track' },
  agent: { label: 'Overseas Agent', home: '/portal' },
  broker: { label: 'Customs Broker', home: '/shipments' },
  trucker: { label: 'Trucker', home: '/shipments' },
};
const INTERNAL = ['admin', 'staff'];

/** SQLite-backed express-session store. */
class SqliteStore extends session.Store {
  get(sid, cb) {
    try {
      const row = store.db.get('SELECT data, expires FROM sessions WHERE sid = ?', sid);
      if (!row || row.expires < Date.now()) return cb(null, null);
      cb(null, JSON.parse(row.data));
    } catch (e) { cb(e); }
  }
  set(sid, sess, cb) {
    try {
      const expires = sess.cookie?.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + 86400000;
      store.db.run('INSERT INTO sessions (sid, data, expires) VALUES (?, ?, ?) ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expires = excluded.expires',
        sid, JSON.stringify(sess), expires);
      cb?.(null);
    } catch (e) { cb?.(e); }
  }
  destroy(sid, cb) {
    try { store.db.run('DELETE FROM sessions WHERE sid = ?', sid); cb?.(null); } catch (e) { cb?.(e); }
  }
  touch(sid, sess, cb) { this.set(sid, sess, cb); }
}

function hashPassword(pw) { return bcrypt.hashSync(pw, 10); }

function authenticate(email, password) {
  const u = store.db.get('SELECT * FROM users WHERE email = ? AND active = 1', String(email || '').trim());
  if (!u || !bcrypt.compareSync(String(password || ''), u.password_hash)) return null;
  store.db.run("UPDATE users SET last_login_at = datetime('now') WHERE id = ?", u.id);
  return u;
}

/** Loads req.user / res.locals.user from the session. */
function loadUser(req, res, next) {
  const id = req.session?.userId;
  if (id) {
    const u = store.db.get(`SELECT u.id, u.email, u.name, u.role, u.company_id, u.can_accounting, u.favorites, u.perms, c.name AS company_name
      FROM users u LEFT JOIN companies c ON c.id = u.company_id WHERE u.id = ? AND u.active = 1`, id);
    if (u) { req.user = u; res.locals.user = u; }
  }
  res.locals.user = req.user || null;
  res.locals.ROLES = ROLES;
  res.locals.isInternal = Boolean(req.user && INTERNAL.includes(req.user.role));
  res.locals.canAccounting = canAccounting(req.user);
  res.locals.can = (key) => can(req.user, key);
  next();
}

/**
 * Staff permissions, switched on / off per user in Admin › Permissions. Admins always have everything.
 * `accounting` is stored in users.can_accounting (as before); the rest in users.perms (JSON). Defaults apply until set.
 */
const PERMISSIONS = [
  { key: 'shipments_edit', label: 'Create / edit shipments', help: 'shipment form, containers, cargo, file uploads, tracking refresh', def: true },
  { key: 'send_notices', label: 'Send notices & issue documents', help: 'A/N, D/O, ATME, status updates, resend from Outbox', def: true },
  { key: 'intake', label: 'Document intake', help: 'apply / reject agent uploads', def: true },
  { key: 'parties', label: 'Edit parties', help: 'customers, agents, brokers, truckers, warehouses', def: true },
  { key: 'accounting', label: 'Accounting', help: 'invoices, D/N, vendor bills, payments, SOA, P&L, prices', def: false },
  { key: 'delete', label: 'Delete shipments', help: 'permanently delete a file and its documents', def: false },
  { key: 'settings', label: 'Automation & company settings', help: 'automation, Smartsheet, tracking, company profile, numbering, delete test data', def: false },
  { key: 'users', label: 'Users & permissions', help: 'invite users, reset passwords, change permissions', def: false },
];
const PERM_KEYS = PERMISSIONS.map((p) => p.key);

function permsOf(user) {
  let saved = null;
  try { saved = JSON.parse(user?.perms || 'null'); } catch { saved = null; }
  const out = {};
  for (const p of PERMISSIONS) out[p.key] = saved && p.key in saved ? Boolean(saved[p.key]) : p.def;
  out.accounting = Boolean(user?.can_accounting);
  return out;
}

/** Can this user do `key`? Admins: always. Staff: per their permissions. External users: never. */
function can(user, key) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (user.role !== 'staff') return false;
  return permsOf(user)[key] === true;
}

function requirePerm(key) {
  return (req, res, next) => {
    if (!req.user) return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
    if (!can(req.user, key)) {
      const p = PERMISSIONS.find((x) => x.key === key);
      return res.status(403).render('error', { title: 'Forbidden', message: `You do not have the "${p ? p.label : key}" permission. Ask an admin to turn it on in Admin › Permissions.` });
    }
    next();
  };
}

/** Accounting (invoices, D/N, payments, SOA, prices, profit) is limited to admins and staff granted access. */
function canAccounting(user) {
  return Boolean(user && (user.role === 'admin' || (user.role === 'staff' && user.can_accounting)));
}
function requireAccounting(req, res, next) {
  if (!req.user) return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
  if (!canAccounting(req.user)) return res.status(403).render('error', { title: 'Forbidden', message: 'Accounting is limited to authorized staff.' });
  next();
}
// Document types and email kinds that carry accounting information.
const ACCOUNTING_DOCS = ['AR', 'DN', 'SOA', 'INVOICE', 'VINV'];
const ACCOUNTING_EMAILS = ['AR_INVOICE', 'DEBIT_NOTE', 'SOA'];
// Shipment fields only accounting users may see or change.
const ACCOUNTING_FIELDS = ['service_price', 'invoice_no', 'invoice_amount', 'paid'];

function requireLogin(req, res, next) {
  if (!req.user) return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
    if (!roles.includes(req.user.role)) return res.status(403).render('error', { title: 'Forbidden', message: 'You do not have access to this page.' });
    next();
  };
}
const requireInternal = requireRole(...INTERNAL);

/** Session-bound CSRF token; forms send it as _csrf (body or query for multipart). */
function csrf(req, res, next) {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
  res.locals.csrf = req.session.csrf;
  next();
}
function checkCsrf(req, res, next) {
  const token = req.body?._csrf || req.query._csrf || req.get('x-csrf-token');
  if (!token || token !== req.session.csrf) return res.status(403).render('error', { title: 'Session expired', message: 'Please reload the page and try again.' });
  next();
}

module.exports = { PERMISSIONS, PERM_KEYS, permsOf, can, requirePerm, canAccounting, requireAccounting, ACCOUNTING_DOCS, ACCOUNTING_EMAILS, ACCOUNTING_FIELDS, ROLES, INTERNAL, SqliteStore, hashPassword, authenticate, loadUser, requireLogin, requireRole, requireInternal, csrf, checkCsrf };
