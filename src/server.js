const path = require('node:path');
const express = require('express');
const session = require('express-session');
const config = require('./config');
const auth = require('./auth');
const S = require('./shipments');
const { bootstrap } = require('./seed');

function createApp() {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(config.root, 'views'));
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(express.static(path.join(config.root, 'public'), { maxAge: '1h' }));
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
      S, config, path: req.path, flash: req.session.flash || null,
      fmtNum: (v, d = 0) => (v == null || v === '' ? '' : Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })),
      fmtDate: (v) => (v ? String(v).slice(0, 10) : ''),
      fmtDateTime: (v) => (v ? String(v).replace('T', ' ').slice(0, 16) : ''),
    });
    delete req.session.flash;
    next();
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

  app.use((req, res) => res.status(404).render('error', { title: 'Not found', message: 'The page you are looking for does not exist.' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    res.status(err.status || 500).render('error', { title: 'Error', message: err.expose ? err.message : 'Something went wrong. Please try again.' });
  });
  return app;
}

if (require.main === module) {
  if (config.sessionSecret === 'dev-only-change-me') console.warn('WARNING: set SESSION_SECRET before using this in production');
  bootstrap();
  createApp().listen(config.port, () => console.log(`GlobalBridge Logistics running at ${config.baseUrl}`));
}

module.exports = { createApp };
