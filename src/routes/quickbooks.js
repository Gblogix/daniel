/** QuickBooks Online: connect, choose where things post, sync (accounting users only). */
const express = require('express');
const auth = require('../auth');
const Q = require('../quickbooks');

const router = express.Router();
const flash = (req, type, msg) => { req.session.flash = { type, msg }; };

router.get('/billing/quickbooks', auth.requireAccounting, async (req, res) => {
  const connected = Q.connected();
  let lists = null; let listError = null;
  if (connected) {
    try { lists = await Q.lists(); } catch (e) { listError = e.message; }
  }
  const pending = Q.pending().filter((d) => !d.qbo_id || d.status === 'VOID' || d.qbo_error);
  res.render('billing/quickbooks', {
    title: 'QuickBooks Online', configured: Q.configured(), connected, env: Q.env(), redirectUri: Q.redirectUri(),
    companyName: Q.opt('company_name'), lists, listError, pending, last: Q.lastSync(),
    opts: Object.fromEntries(['item_id', 'income_account', 'expense_account', 'deposit_account', 'bank_account', 'reviewed_only', 'auto', 'payments'].map((k) => [k, Q.opt(k)])),
  });
});

router.get('/billing/quickbooks/connect', auth.requireAccounting, (req, res) => {
  if (!Q.configured()) { flash(req, 'err', 'Set QBO_CLIENT_ID and QBO_CLIENT_SECRET in .env first (see the steps on this page)'); return res.redirect('/billing/quickbooks'); }
  res.redirect(Q.authorizeUrl());
});

router.get('/billing/quickbooks/callback', auth.requireAccounting, async (req, res) => {
  try {
    if (req.query.error) throw new Error(`QuickBooks: ${req.query.error}`);
    await Q.handleCallback({ code: String(req.query.code || ''), realmId: String(req.query.realmId || ''), state: String(req.query.state || '') });
    flash(req, 'ok', `Connected to QuickBooks${Q.opt('company_name') ? ` — ${Q.opt('company_name')}` : ''}. Check the accounts below, then Sync now.`);
  } catch (e) { flash(req, 'err', e.message); }
  res.redirect('/billing/quickbooks');
});

router.post('/billing/quickbooks/manual', auth.requireAccounting, async (req, res) => {
  try {
    await Q.connectManual({ realmId: req.body.realm_id, refreshToken: req.body.refresh_token });
    flash(req, 'ok', `Connected to QuickBooks — ${Q.opt('company_name')}`);
  } catch (e) { flash(req, 'err', e.message); }
  res.redirect('/billing/quickbooks');
});

router.post('/billing/quickbooks/disconnect', auth.requireAccounting, async (req, res) => {
  await Q.disconnect();
  flash(req, 'ok', 'Disconnected from QuickBooks (documents already sent stay in QuickBooks)');
  res.redirect('/billing/quickbooks');
});

router.post('/billing/quickbooks/settings', auth.requireAccounting, (req, res) => {
  for (const k of ['item_id', 'income_account', 'expense_account', 'deposit_account', 'bank_account']) {
    if (k in req.body) Q.setOpt(k, String(req.body[k] || '').replace(/[^\w-]/g, ''));
  }
  for (const k of ['reviewed_only', 'auto', 'payments']) Q.setOpt(k, req.body[k] ? '1' : '0');
  flash(req, 'ok', 'QuickBooks settings saved');
  res.redirect('/billing/quickbooks');
});

const summary = (r) => [`${r.created} new`, `${r.updated} updated`, r.voided && `${r.voided} voided`, `${r.payments} payment(s)`].filter(Boolean).join(', ');

router.post('/billing/quickbooks/sync', auth.requireAccounting, async (req, res) => {
  const r = await Q.syncAll();
  flash(req, r.errors.length ? 'err' : 'ok', `QuickBooks: ${summary(r)}${r.errors.length ? ` — ${r.errors.length} problem(s): ${r.errors.slice(0, 3).join(' | ')}` : ''}`);
  res.redirect('/billing/quickbooks');
});

router.post('/invoices/:id/quickbooks', auth.requireAccounting, async (req, res) => {
  const id = Number(req.params.id);
  try {
    const r = await Q.pushInvoice(id);
    flash(req, 'ok', r.action === 'skipped' ? 'Nothing to send (draft / empty)' : `QuickBooks: ${r.action}${r.qbo_id ? ` (#${r.qbo_id})` : ''}`);
  } catch (e) { flash(req, 'err', e.message); }
  res.redirect(`/invoices/${id}`);
});

module.exports = router;
