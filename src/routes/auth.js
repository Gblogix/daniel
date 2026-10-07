const express = require('express');
const auth = require('../auth');

const router = express.Router();

router.get('/', (req, res) => {
  if (!req.user) return res.redirect('/login');
  if (auth.INTERNAL.includes(req.user.role)) return res.redirect('/app');
  res.redirect(auth.ROLES[req.user.role]?.home || '/shipments');
});

// Staff workspace: left menu, favorites bar, and every page in its own tab (like OPUS).
router.get('/app', auth.requireInternal, (req, res) => {
  const menu = require('../menu');
  const open = typeof req.query.open === 'string' && /^\/(?!\/)/.test(req.query.open) && !req.query.open.startsWith('/app') ? req.query.open : '';
  res.render('app', { title: 'GB Logix', menu: menu.menuFor(req.user), rail: menu.railFor(req.user), favItems: menu.favItems(req.user), favorites: menu.favoritesFor(req.user), open });
});
router.post('/me/favorites', auth.requireInternal, (req, res) => {
  const menu = require('../menu');
  const allowed = new Set(menu.favItems(req.user).map((i) => i.id));
  const ids = (Array.isArray(req.body.ids) ? req.body.ids : []).filter((id) => allowed.has(id)).slice(0, 40);
  require('../db').db.run('UPDATE users SET favorites = ? WHERE id = ?', JSON.stringify([...new Set(ids)]), req.user.id);
  res.json({ ok: true, ids });
});

router.get('/login', (req, res) => {
  if (req.user) return res.redirect('/');
  res.render('login', { title: 'Sign in', error: null, email: '', next: req.query.next || '' });
});

router.post('/login', (req, res, next) => {
  const u = auth.authenticate(req.body.email, req.body.password);
  if (!u) return res.status(401).render('login', { title: 'Sign in', error: 'Invalid email or password', email: req.body.email || '', next: req.body.next || '' });
  const target = typeof req.body.next === 'string' && /^\/(?!\/)/.test(req.body.next) ? req.body.next : '/';
  req.session.regenerate((err) => {
    if (err) return next(err);
    req.session.userId = u.id;
    res.redirect(target);
  });
});

// ---------- my password (everyone: staff, customers, agents, brokers, truckers) ----------
router.get('/account/password', auth.requireLogin, (req, res) => {
  res.render('account-password', { title: 'Change password', noShell: true, forced: Boolean(req.user.must_change_pw), error: null });
});
router.post('/account/password', auth.requireLogin, (req, res) => {
  const forced = Boolean(req.user.must_change_pw);
  const fail = (error) => res.status(400).render('account-password', { title: 'Change password', noShell: true, forced, error });
  const { current, password, confirm } = req.body;
  const row = require('../db').db.get('SELECT password_hash FROM users WHERE id = ?', req.user.id);
  if (!auth.checkPassword(current, row.password_hash)) return fail('Your current password is not correct');
  if (!password || String(password).length < 8) return fail('The new password needs at least 8 characters');
  if (password !== confirm) return fail('The two new passwords do not match');
  if (password === current) return fail('Choose a password different from the current one');
  require('../db').db.run("UPDATE users SET password_hash = ?, must_change_pw = 0, pw_changed_at = datetime('now') WHERE id = ?", auth.hashPassword(password), req.user.id);
  req.session.flash = { type: 'ok', msg: 'Password changed' };
  res.redirect('/');
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

module.exports = router;
