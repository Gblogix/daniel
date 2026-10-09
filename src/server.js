const path = require('node:path');
const express = require('express');
const session = require('express-session');
const config = require('./config');
const auth = require('./auth');
const S = require('./shipments');

// Release id: a hash of the screens, scripts and styles. It busts the browser cache for /css and /js, and open
// browsers compare it (GET /version.json) to reload themselves after an update — no Ctrl+F5 needed.
const ASSET_VERSION = (() => {
  const fs = require('node:fs');
  const h = require('node:crypto').createHash('sha1');
  const walk = (dir) => {
    let names = [];
    try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of names.sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(js|css|ejs)$/.test(e.name)) { h.update(e.name); h.update(fs.readFileSync(p)); }
    }
  };
  try { for (const d of ['public', 'views', 'src']) walk(path.join(__dirname, '..', d)); return h.digest('hex').slice(0, 10); } catch { return Date.now().toString(36); }
})();
const { bootstrap } = require('./seed');

function createApp() {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(config.root, 'views'));
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(express.static(path.join(config.root, 'public'), { maxAge: '1h' }));
  app.get('/version.json', (req, res) => { res.set('Cache-Control', 'no-store'); res.json({ v: ASSET_VERSION }); });
  // Provider webhooks need the raw body for signature checks and sit outside session / CSRF.
  app.post('/webhooks/terminal49', express.raw({ type: '*/*', limit: '5mb' }), async (req, res) => {
    const r = await require('./tracking').handleTerminal49Webhook(req.body, req.get('X-T49-Webhook-Signature'));
    res.status(r.status).end();
  });
  app.use(express.urlencoded({ extended: true, limit: '2mb' }));
  app.use(express.json({ limit: '2mb' }));
  app.use(session({
    store: new auth.SqliteStore(),
    secret: config.sessionSecret,
    name: 'gbl.sid',
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', secure: config.baseUrl.startsWith('https://'), maxAge: 7 * 86400000 },
  }));
  app.use(auth.loadUser);
  app.use(auth.csrf);
  app.use((req, res, next) => {
    Object.assign(res.locals, {
      S, config, path: req.path, stagesFor: (s, c) => require('./stages').stages(s, c), PORTAL_HIDE: require('./portal').HIDE_OPTIONS, SUGGEST_FIELDS: Object.keys(require('./suggest').FIELDS).join(','), flash: req.session.flash || null, v: ASSET_VERSION,
      fmtNum: (v, d = 0) => (v == null || v === '' ? '' : Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })),
      fmtDate: (v) => (v ? String(v).slice(0, 10) : ''),
      fmtDateTime: (v) => (v ? String(v).replace('T', ' ').slice(0, 16) : ''),
    });
    delete req.session.flash;
    next();
  });
  // Anything that sends email (A/N, D/O, invoices, statements…): if a message did not go out, say so instead of "sent".
  app.use((req, res, next) => {
    if (req.method !== 'POST' || !req.user) return next();
    const notify = require('./notify');
    let since;
    try { since = notify.lastEmailId(); } catch { return next(); }
    const redirect = res.redirect.bind(res);
    res.redirect = (...args) => {
      try {
        const problem = notify.deliveryProblem(since);
        if (problem && req.session && req.session.flash?.type !== 'err') req.session.flash = { type: 'err', msg: problem };
      } catch { /* never block the redirect */ }
      return redirect(...args);
    };
    next();
  });
  // Signed in with a temporary password (new invite or a reset by an admin): choose a new one before anything else.
  app.use((req, res, next) => {
    if (!req.user?.must_change_pw || ['/account/password', '/logout'].includes(req.path)) return next();
    if (req.method === 'GET') return res.redirect('/account/password');
    return res.status(403).render('error', { title: 'Change your password', message: 'Please choose a new password first.' });
  });
  // Mutating requests need a CSRF token (multipart routes check after parsing).
  app.use((req, res, next) => {
    if (req.method === 'POST' && !req.is('multipart/form-data')) return auth.checkCsrf(req, res, next);
    next();
  });

  app.use(require('./routes/auth'));
  app.use(require('./routes/shipments'));
  app.use(require('./routes/intake'));
  app.use(require('./routes/customer'));
  app.use(require('./routes/admin'));
  app.use(require('./routes/billing'));
  app.use(require('./routes/quickbooks'));
  app.use(require('./routes/worklists'));
  app.use(require('./routes/vendorbills'));
  app.use(require('./routes/followups'));
  app.use(require('./routes/masters'));

  app.use((req, res) => res.status(404).render('error', { title: 'Not found', message: 'The page you are looking for does not exist.' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    // A change to a locked file: say so on the page the user came from.
    if (err.code === 'LOCKED' && req.method === 'POST' && req.session) {
      req.session.flash = { type: 'err', msg: err.message };
      if (req.get('accept')?.includes('application/json') || req.xhr) return res.status(423).json({ error: err.message });
      return res.redirect(req.get('referer') || '/');
    }
    console.error(err);
    res.status(err.status || 500).render('error', { title: 'Error', message: err.expose ? err.message : 'Something went wrong. Please try again.' });
  });
  return app;
}

if (require.main === module) {
  if (config.sessionSecret === 'dev-only-change-me') console.warn('WARNING: set SESSION_SECRET before using this in production');
  bootstrap();
  const fresh = require('./reset').freshStartOnce();
  // Box titles read as names by older versions ("'S NAME AND ADDRESS" from an air waybill): clear them.
  for (const k of ['shipper_name', 'consignee_name', 'notify_party']) {
    require('./db').db.run(`UPDATE shipments SET ${k} = NULL WHERE ${k} LIKE '%NAME AND ADDRESS%' OR ${k} LIKE '%ACCOUNT NUMBER%'`);
  }
  const linked = require('./masters').backfill();
  if (linked) console.log(`Masters: ${linked} file(s) grouped under their master B/L`);
  if (fresh) console.log(`Fresh start: removed ${fresh.shipments} test shipments, ${fresh.invoices} invoices, ${fresh.documents} files — new files come from email from now on`);
  createApp().listen(config.port, () => console.log(`GlobalBridge Logistics running at ${config.baseUrl}`));
  console.log(`Email: ${config.mailTransport}${config.graph.enabled && config.graph.intake ? ' · Outlook intake on' : ''}`);
  require('./mailin').start();
  require('./alerts').start();
  require('./locks').start();
  if (require('./smartsheet').start()) console.log('Smartsheet sync on');
  console.log(require('./backup').start() ? `Backup: nightly to ${require('./backup').dir()}` : 'Backup: OFF — set BACKUP_DIR in .env (e.g. a OneDrive folder)');
  if (require('./quickbooks').start()) console.log(`QuickBooks Online: ${require('./quickbooks').connected() ? 'connected' : 'app keys set — connect from Accounting › QuickBooks Online'}`);
  const t = require('./tracking').start();
  console.log(`Tracking: ${t.any ? [t.terminal49 && 'Terminal49', t.shipsgo && 'ShipsGo', t.dcsa.length && `carrier APIs (${t.dcsa.join(', ')})`].filter(Boolean).join(', ') : 'no provider configured'}${t.datalastic || t.aisstream ? ' · vessel GPS on' : ''}`);
}

module.exports = { createApp };
