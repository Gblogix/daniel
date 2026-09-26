const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS companies (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  -- customer (CNEE) | agent (overseas agent) | broker (customs) | trucker | shipper | delivery (warehouse / 3PL)
  type TEXT NOT NULL,
  country TEXT,
  emails TEXT,              -- comma separated notice recipients
  phone TEXT,
  address TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  -- admin | staff | customer | agent | broker | trucker
  role TEXT NOT NULL,
  company_id INTEGER REFERENCES companies(id),
  active INTEGER NOT NULL DEFAULT 1,
  last_login_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS shipments (
  id INTEGER PRIMARY KEY,
  ref_no TEXT NOT NULL UNIQUE,
  mode TEXT NOT NULL DEFAULT 'FCL',          -- AIR | FCL | LCL | TRUCK
  origin_country TEXT,                        -- KR | CN | ...
  status TEXT NOT NULL DEFAULT 'BOOKED',
  customer_id INTEGER REFERENCES companies(id),
  agent_id INTEGER REFERENCES companies(id),
  broker_id INTEGER REFERENCES companies(id),
  trucker_id INTEGER REFERENCES companies(id),
  delivery_company_id INTEGER REFERENCES companies(id),
  shipper_name TEXT,
  shipper_address TEXT,
  consignee_name TEXT,
  notify_party TEXT,
  mbl_no TEXT,
  hbl_no TEXT,
  carrier TEXT,
  vessel TEXT,
  voyage TEXT,
  flight_no TEXT,
  pol TEXT,
  pod TEXT,
  place_of_delivery TEXT,
  cfs_location TEXT,
  etd TEXT,
  eta TEXT,
  atd TEXT,
  ata TEXT,
  packages INTEGER,
  package_unit TEXT,
  weight_kg REAL,
  cbm REAL,
  chargeable_weight REAL,
  commodity TEXT,
  delivery_address TEXT,
  delivery_date TEXT,
  delivery_time TEXT,
  last_free_day TEXT,
  customs_status TEXT NOT NULL DEFAULT 'PENDING', -- PENDING | FILED | EXAM | RELEASED | HOLD
  isf_filed INTEGER NOT NULL DEFAULT 0,
  service_price REAL,
  invoice_no TEXT,
  invoice_amount REAL,
  paid INTEGER NOT NULL DEFAULT 0,
  an_sent_at TEXT,
  do_sent_at TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_shipments_customer ON shipments(customer_id);
CREATE INDEX IF NOT EXISTS idx_shipments_mbl ON shipments(mbl_no);
CREATE INDEX IF NOT EXISTS idx_shipments_hbl ON shipments(hbl_no);

CREATE TABLE IF NOT EXISTS containers (
  id INTEGER PRIMARY KEY,
  shipment_id INTEGER NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  container_no TEXT NOT NULL,
  seal_no TEXT,
  size_type TEXT,
  packages INTEGER,
  weight_kg REAL,
  cbm REAL
);

CREATE TABLE IF NOT EXISTS cargo_items (
  id INTEGER PRIMARY KEY,
  shipment_id INTEGER NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  po_no TEXT,
  description TEXT NOT NULL,
  hs_code TEXT,
  quantity REAL,
  unit TEXT,
  packages INTEGER,
  weight_kg REAL,
  cbm REAL
);

-- A batch of documents uploaded through the agent portal, waiting for staff review.
CREATE TABLE IF NOT EXISTS intakes (
  id INTEGER PRIMARY KEY,
  uploaded_by INTEGER REFERENCES users(id),
  agent_id INTEGER REFERENCES companies(id),
  status TEXT NOT NULL DEFAULT 'PENDING',     -- PENDING | APPLIED | REJECTED
  extracted_json TEXT,
  extraction_method TEXT,
  note TEXT,
  shipment_id INTEGER REFERENCES shipments(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_at TEXT,
  reviewed_by INTEGER REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY,
  shipment_id INTEGER REFERENCES shipments(id) ON DELETE CASCADE,
  intake_id INTEGER REFERENCES intakes(id),
  doc_type TEXT NOT NULL,                     -- MBL HBL PL CI ISF AN DO ATME INVOICE OTHER
  filename TEXT NOT NULL,
  stored_path TEXT,
  mime TEXT,
  size INTEGER,
  source TEXT NOT NULL DEFAULT 'upload',      -- upload | generated
  customer_visible INTEGER NOT NULL DEFAULT 0,
  extracted_json TEXT,
  uploaded_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  shipment_id INTEGER NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  customer_visible INTEGER NOT NULL DEFAULT 1,
  user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS emails (
  id INTEGER PRIMARY KEY,
  shipment_id INTEGER REFERENCES shipments(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  to_addr TEXT NOT NULL,
  cc_addr TEXT,
  subject TEXT NOT NULL,
  body_html TEXT NOT NULL,
  attachments_json TEXT,
  status TEXT NOT NULL DEFAULT 'QUEUED',      -- QUEUED | SENT | LOGGED | FAILED
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  expires INTEGER NOT NULL
);
`;

const DEFAULT_SETTINGS = {
  auto_send_docs_received: '1', // docs applied -> customer update + broker packet (A/N, HBL, PL, CI)
  auto_send_do: '1',            // customs released -> D/O to trucker
  auto_notify_status: '1',      // status / ETA / delivery changes -> customer
};

function open(file = config.dbPath) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  const insert = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insert.run(k, v);
  return wrap(db);
}

function wrap(db) {
  const cache = new Map();
  const stmt = (sql) => {
    let s = cache.get(sql);
    if (!s) { s = db.prepare(sql); cache.set(sql, s); }
    return s;
  };
  // node:sqlite rejects undefined; normalise to null and booleans to 0/1.
  const norm = (params) => params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? Number(p) : p));
  const api = {
    raw: db,
    all: (sql, ...p) => stmt(sql).all(...norm(p)).map((r) => ({ ...r })),
    get: (sql, ...p) => { const r = stmt(sql).get(...norm(p)); return r ? { ...r } : undefined; },
    run: (sql, ...p) => stmt(sql).run(...norm(p)),
    exec: (sql) => db.exec(sql),
    tx(fn) {
      db.exec('BEGIN');
      try { const out = fn(); db.exec('COMMIT'); return out; } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
    setting: (key) => api.get('SELECT value FROM settings WHERE key = ?', key)?.value,
    setSetting: (key, value) => api.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, String(value)),
    close: () => db.close(),
  };
  return api;
}

let instance;
module.exports = {
  open,
  get db() {
    if (!instance) instance = open();
    return instance;
  },
  set db(v) { instance = v; },
};
