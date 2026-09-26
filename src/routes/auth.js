const express = require('express');
const auth = require('../auth');

const router = express.Router();

router.get('/', (req, res) => {
  if (!req.user) return res.redirect('/login');
  res.redirect(auth.ROLES[req.user.role]?.home || '/shipments');
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

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

module.exports = router;
