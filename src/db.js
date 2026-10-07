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
  mode TEXT NOT NULL DEFAULT 'FCL',          -- AIR | FCL | LCL | TRUCK | OTHER (non-shipment invoices)
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

-- Master B/L (ocean MB/L or air MAWB): the carrier leg shared by its house files (OPUS OIM / AIM entry).
CREATE TABLE IF NOT EXISTS masters (
  id INTEGER PRIMARY KEY,
  ref_no TEXT UNIQUE,
  mode TEXT NOT NULL DEFAULT 'FCL',
  mbl_no TEXT,
  agent_id INTEGER REFERENCES companies(id),
  carrier TEXT, scac TEXT, vessel TEXT, voyage TEXT, flight_no TEXT,
  etd TEXT, eta TEXT, atd TEXT, ata TEXT,
  pol TEXT, pod TEXT, place_of_delivery TEXT, service_term TEXT, notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
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

CREATE TABLE IF NOT EXISTS charges (
  id INTEGER PRIMARY KEY,
  shipment_id INTEGER NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  amount REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Milestones received from tracking providers (carrier APIs, aggregators).
CREATE TABLE IF NOT EXISTS tracking_events (
  id INTEGER PRIMARY KEY,
  shipment_id INTEGER NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  container_no TEXT,
  event TEXT NOT NULL,          -- e.g. vessel_departed, vessel_arrived, discharged, full_out, empty_in
  classifier TEXT,             -- ACT (actual) | EST (estimated) | PLN (planned)
  event_time TEXT,
  location TEXT,
  vessel TEXT,
  voyage TEXT,
  source TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (shipment_id, container_no, event, classifier, event_time)
);

-- Outlook messages already imported into Document intake.
CREATE TABLE IF NOT EXISTS mail_imports (
  message_id TEXT PRIMARY KEY,
  intake_id INTEGER REFERENCES intakes(id),
  sender TEXT,
  subject TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Accounting: AR invoices to customers, D/N (debit note) / C/N to overseas agents, AP costs from vendors.
CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY,
  shipment_id INTEGER REFERENCES shipments(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,                  -- AR | DN | AP
  number TEXT NOT NULL UNIQUE,         -- INV-12214 | DCN-11664 | vendor invoice no.
  company_id INTEGER REFERENCES companies(id),
  bill_to TEXT,                        -- printed name + address
  attn TEXT,
  ship_to TEXT,
  invoice_date TEXT NOT NULL,
  terms_days INTEGER NOT NULL DEFAULT 0,
  due_date TEXT,
  currency TEXT NOT NULL DEFAULT 'USD',
  profit_share REAL,                   -- D/N: % of shipment profit credited to the agent
  agent_ref TEXT,                      -- D/N: agent's filing no.
  customer_ref TEXT,
  memo TEXT,
  total REAL NOT NULL DEFAULT 0,       -- AR/AP: amount; D/N: debit - credit (positive = due to us)
  paid_amount REAL NOT NULL DEFAULT 0,
  paid_at TEXT,
  status TEXT NOT NULL DEFAULT 'OPEN', -- DRAFT | OPEN | PAID | VOID
  sent_at TEXT,
  prepared_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_invoices_shipment ON invoices(shipment_id);

CREATE TABLE IF NOT EXISTS invoice_lines (
  id INTEGER PRIMARY KEY,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  mh TEXT,                             -- D/N: M (master) / H (house)
  bl_no TEXT,
  description TEXT NOT NULL,
  unit TEXT,
  rate REAL,
  qty REAL,
  amount REAL NOT NULL DEFAULT 0,      -- rate x qty (REV/COST on D/N)
  pc TEXT,                             -- D/N: P (prepaid) / C (collect)
  side TEXT NOT NULL DEFAULT 'DEBIT'   -- D/N: DEBIT (+, due to us) | CREDIT (-, due to agent)
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY,
  company_id INTEGER REFERENCES companies(id),
  direction TEXT NOT NULL,            -- IN (received) | OUT (paid)
  amount REAL NOT NULL,
  paid_on TEXT NOT NULL,
  method TEXT,                        -- ACH | WIRE | CHECK | NETTING
  reference TEXT,
  memo TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS payment_allocations (
  id INTEGER PRIMARY KEY,
  payment_id INTEGER NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  amount REAL NOT NULL
);

-- Smartsheet sync bookkeeping: which sheet row feeds which shipment, which attachments were downloaded.
CREATE TABLE IF NOT EXISTS smartsheet_rows (
  sheet_id TEXT NOT NULL,
  row_id TEXT NOT NULL,
  shipment_id INTEGER REFERENCES shipments(id) ON DELETE CASCADE,
  synced_at TEXT,
  PRIMARY KEY (sheet_id, row_id)
);
CREATE TABLE IF NOT EXISTS smartsheet_files (
  attachment_id TEXT PRIMARY KEY,
  document_id INTEGER REFERENCES documents(id) ON DELETE SET NULL,
  shipment_id INTEGER REFERENCES shipments(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Follow-up items a user snoozed or marked done (items themselves are computed from the data).
CREATE TABLE IF NOT EXISTS followup_state (
  key TEXT PRIMARY KEY,
  snoozed_until TEXT,
  done_at TEXT,
  user_id INTEGER REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- Action Center: tasks people give themselves or a colleague (from an email, a call…), shown with the follow-ups.
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  shipment_id INTEGER REFERENCES shipments(id) ON DELETE CASCADE,
  assignee_id INTEGER REFERENCES users(id),
  due_date TEXT,
  remind_at TEXT,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'OPEN', -- OPEN | DONE
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  done_at TEXT
);

-- Memo log on a file (who wrote what, when) — replaces notes lost in email threads.
CREATE TABLE IF NOT EXISTS shipment_memos (
  id INTEGER PRIMARY KEY,
  shipment_id INTEGER NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  subject TEXT,
  body TEXT,
  user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  expires INTEGER NOT NULL
);
`;

// Columns added after the first release; applied to existing databases on startup.
const MIGRATIONS = {
  shipments: {
    title: 'TEXT', // name of an "Other" (non-shipment) file
    credit_released_at: 'TEXT', credit_released_by: 'INTEGER', // admin let this file go despite a credit hold
    internal_note: 'TEXT', color_label: 'TEXT', flagged: 'INTEGER NOT NULL DEFAULT 0', // list work screen
    bill_to_id: 'INTEGER', sales_id: 'INTEGER', // invoice party when not the customer; sales rep
    blocked_at: 'TEXT', blocked_by: 'INTEGER', block_reason: 'TEXT', // file locked (Tools › Block)
    locked_at: 'TEXT', locked_by: 'INTEGER', lock_released_at: 'TEXT', lock_released_by: 'INTEGER', lock_release_reason: 'TEXT', // accounting lock (src/locks.js)
    profit_remark: 'TEXT', profit_ignore: 'INTEGER NOT NULL DEFAULT 0', // dashboard: negative-profit review
    pierpass_paid: 'INTEGER NOT NULL DEFAULT 0', // ocean: PierPass TMF / Clean Truck Fee paid
    master_id: 'INTEGER', // house file → its master B/L (masters)
    bl_invoices: 'TEXT', // commercial invoice nos. the B/L names (UB005, EZVC_TGT_26-09…) — P/L expected for each
    scac: 'TEXT', direct_shipment: 'INTEGER NOT NULL DEFAULT 0', isf_no: 'TEXT', telex_release: 'INTEGER NOT NULL DEFAULT 0',
    firms_code: 'TEXT', entry_no: 'TEXT', css_no: 'TEXT', holds: 'TEXT', cargo_value: 'REAL', ci_invoice_no: 'TEXT',
    freight_paid: 'INTEGER NOT NULL DEFAULT 0', carrier_released: 'INTEGER NOT NULL DEFAULT 0', storage_start: 'TEXT',
    available_for_pickup: 'INTEGER', pickup_appt: 'TEXT', picked_up_at: 'TEXT', pallets: 'INTEGER',
    pod_received: 'INTEGER NOT NULL DEFAULT 0', empty_returned_at: 'TEXT', original_eta: 'TEXT',
    tracking_provider: 'TEXT', tracking_ref: 'TEXT', tracking_status: 'TEXT', tracking_error: 'TEXT', tracking_checked_at: 'TEXT',
    tracking_enabled: 'INTEGER NOT NULL DEFAULT 1',
    vessel_imo: 'TEXT', vessel_mmsi: 'TEXT', vessel_lat: 'REAL', vessel_lon: 'REAL', vessel_speed: 'REAL',
    vessel_course: 'REAL', vessel_pos_at: 'TEXT', vessel_destination: 'TEXT',
    ams_bl_no: 'TEXT', customer_ref: 'TEXT', sub_bl_no: 'TEXT', it_no: 'TEXT', it_place: 'TEXT', it_date: 'TEXT',
    devan_location: 'TEXT', freight_location_tel: 'TEXT', available_date: 'TEXT', go_date: 'TEXT', final_destination: 'TEXT',
    service_term: 'TEXT', release_type: 'TEXT', consignee_address: 'TEXT', notify_address: 'TEXT', marks: 'TEXT',
    agent_ref: 'TEXT', closed_at: 'TEXT', closed_by: 'INTEGER',
    owner_id: 'INTEGER', // person in charge (PIC)
    delivery_request_date: 'TEXT', delivery_request_time: 'TEXT', delivery_request_note: 'TEXT',
    delivery_request_at: 'TEXT', delivery_request_by: 'INTEGER', delivery_request_done: 'INTEGER NOT NULL DEFAULT 0',
  },
  containers: {
    pickup_lfd: 'TEXT', available: 'INTEGER', holds: 'TEXT', discharged_at: 'TEXT', full_out_at: 'TEXT',
    empty_returned_at: 'TEXT', current_status: 'TEXT', location: 'TEXT', pickup_no: 'TEXT',
    remark: 'TEXT', internal_note: 'TEXT', color_label: 'TEXT', // My Containers: notes and colour label
  },
  cargo_items: { unit_price: 'REAL', amount: 'REAL', source: 'TEXT', invoice_no: 'TEXT', buyer: 'TEXT' }, // buyer = final buyer (Target, Nordstrom…)
  companies: { code: 'TEXT', contact: 'TEXT', fax: 'TEXT', tax_id: 'TEXT', portal_hide: 'TEXT', credit_limit: 'REAL', credit_hold: 'INTEGER NOT NULL DEFAULT 0', credit_note: 'TEXT', lost_ignored: 'INTEGER NOT NULL DEFAULT 0', types: 'TEXT', qbo_customer_id: 'TEXT', qbo_vendor_id: 'TEXT', billing_emails: 'TEXT', terms_days: 'INTEGER', short_name: 'TEXT', default_pic_id: 'INTEGER', report_frequency: 'TEXT', report_emails: 'TEXT', report_last: 'TEXT' },
  invoices: { document_id: 'INTEGER', reviewed_at: 'TEXT', reviewed_by: 'INTEGER',
    qbo_id: 'TEXT', qbo_type: 'TEXT', qbo_hash: 'TEXT', qbo_synced_at: 'TEXT', qbo_error: 'TEXT' }, // QuickBooks Online sync
  emails: { bcc_addr: 'TEXT', reply_to: 'TEXT' },
  payments: { qbo_id: 'TEXT', qbo_synced_at: 'TEXT', qbo_error: 'TEXT' },
  documents: { invoice_id: 'INTEGER', company_id: 'INTEGER', master_id: 'INTEGER' },
  masters: { containers: 'TEXT' }, // container nos. on the MB/L (comma list) — finds the master of a house B/L without MB/L no.
  intakes: { master_id: 'INTEGER', feedback: 'INTEGER', feedback_note: 'TEXT' }, // feedback: reading quality 1 good / 0 bad
  users: { can_accounting: 'INTEGER NOT NULL DEFAULT 0', favorites: 'TEXT', perms: 'TEXT', must_change_pw: 'INTEGER NOT NULL DEFAULT 0', pw_changed_at: 'TEXT' },
};

function migrate(db) {
  for (const [table, cols] of Object.entries(MIGRATIONS)) {
    const have = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
    for (const [col, type] of Object.entries(cols)) if (!have.has(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
  }
}

const DEFAULT_SETTINGS = {
  auto_send_docs_received: '1', // docs applied -> customer update + broker packet (A/N, HBL, PL, CI)
  auto_send_do: '1',            // customs released -> D/O to trucker
  auto_notify_status: '1',      // status / ETA / delivery changes -> customer
  auto_tracking: '1',           // poll carrier / GPS tracking and update ETD/ETA automatically
  lfd_alerts: '1',              // daily LFD / pickup digest to staff
  smartsheet_sync: '1',         // pull shared Smartsheet sheets (needs SMARTSHEET_TOKEN)
  smartsheet_push: '0',         // write ETA back into the customer-shared sheets (opt-in)
  auto_send_reviewed: '0',      // email an invoice / D/N to its party as soon as it is marked reviewed
  auto_status: '1',             // advance the status from dates (ATD, ATA, customs release, pick-up, POD)
  daily_digest: '1',            // 7am email to each staff member with their follow-ups
  customer_reports: '1',        // scheduled shipment reports to customers (per party: daily / weekly)
  // Next document numbers (continue from the current system; admin can change them)
  seq_OI: '11828', seq_AI: '10009', seq_OTH: '10582', seq_INV: '12215', seq_DCN: '11665',
  // GBL numbering (new files / invoices from Sep 2026): GBL-OI10001, GBL-INV10001, GBL-DN10001 …
  num_prefix: 'GBL-', seq_G_OM: '10001', seq_G_AM: '10001', seq_G_OI: '10001', seq_G_AI: '10001', seq_G_OT: '10001', seq_G_INV: '10001', seq_G_DN: '10001', seq_G_CN: '10001',
  ar_terms_days: '25',
};

function open(file = config.dbPath) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  migrate(db);
  const insert = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insert.run(k, v);
  return wrap(db);
}

function wrap(db) {
  const cache = new Map();
  let depth = 0;
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
    // Nestable: the outermost call opens a transaction, inner calls use savepoints.
    tx(fn) {
      const sp = `sp${depth}`;
      db.exec(depth === 0 ? 'BEGIN' : `SAVEPOINT ${sp}`);
      depth++;
      try {
        const out = fn();
        depth--;
        db.exec(depth === 0 ? 'COMMIT' : `RELEASE ${sp}`);
        return out;
      } catch (e) {
        depth--;
        db.exec(depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
        throw e;
      }
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
