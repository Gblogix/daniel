/**
 * bootstrap(): ensures an admin account exists (ADMIN_EMAIL / ADMIN_PASSWORD).
 * `npm run seed -- --demo`: loads the parties from the process map and sample shipments.
 */
const store = require('./db');
const auth = require('./auth');
const S = require('./shipments');

function bootstrap(db = store.db) {
  const n = db.get('SELECT COUNT(*) AS n FROM users').n;
  if (n > 0) return;
  const email = process.env.ADMIN_EMAIL || 'admin@gblogix.com';
  const password = process.env.ADMIN_PASSWORD || 'changeme123';
  db.run("INSERT INTO users (email, name, role, password_hash) VALUES (?, 'Administrator', 'admin', ?)", email, auth.hashPassword(password));
  console.log(`Created admin user ${email}${process.env.ADMIN_PASSWORD ? '' : ' with default password "changeme123" — change it after first login'}`);
}

// Parties as they appear in the real email flow (demo notice emails use .example addresses).
const DEMO_PARTIES = [
  { key: 'kukmin', name: '국민해운 (Kukmin Shipping)', type: 'agent', country: 'KR', emails: 'docs@kukmin.example' },
  { key: 'zhejiang', name: 'Zhejiang Twings Supply Chain', type: 'agent', country: 'CN', emails: 'ops@twings.example' },
  { key: 'reko', name: 'Reko Logistics (US partner)', type: 'agent', country: 'US', emails: 'lax_op1@reko.example' },
  { key: 'ian', name: 'IAN Customs Service (8TV)', type: 'broker', country: 'US', emails: 'import@ianchb.example' },
  { key: 'omc', name: 'Oh! My Customs', type: 'broker', country: 'US', emails: 'entry@ohmycustoms.example' },
  { key: 'solvenza', name: 'Solvenza Trading', type: 'broker', country: 'US', emails: 'customs@solvenza.example' },
  { key: 'opulen', name: 'Opulen Global', type: 'broker', country: 'US', emails: 'customs@opulen.example' },
  { key: 'ctc', name: 'CTC Logistics', type: 'trucker', country: 'US', emails: 'dispatch@ctc.example' },
  { key: 'qtrans', name: 'Q-Trans Logistics (Gardena)', type: 'trucker', country: 'US', emails: 'ops@qtrans.example', address: '540 E. Alondra Blvd, Gardena, CA' },
  { key: 'shm', name: 'SHM Transport', type: 'trucker', country: 'US', emails: 'dispatch@shm.example' },
  { key: 'unlockt', name: 'Unlockt Brands', type: 'customer', country: 'US', emails: 'logistics@unlockt.example' },
  { key: 'leepop', name: 'LEEPOP Company LLC', type: 'customer', country: 'US', emails: 'ops@leepop.example', address: '417 S Associated Rd #1026, Brea, CA' },
  { key: 'pgp', name: 'Pacific Global Partners', type: 'customer', country: 'US', emails: 'import@pgp.example' },
  { key: 'heyhae', name: 'Heyhae', type: 'customer', country: 'US', emails: 'ops@heyhae.example' },
  { key: 'nextrade', name: 'Nextrade', type: 'delivery', country: 'US', emails: 'receiving@nextrade.example', address: 'Nextrade Warehouse, South Gate, CA' },
  { key: 'ubwh', name: 'Unlockt Brands Warehouse', type: 'delivery', country: 'US', emails: 'receiving@unlockt.example', address: 'Unlockt Brands DC, Ontario, CA' },
  { key: 'msi', name: 'MSI West Sacramento', type: 'delivery', country: 'US', emails: 'receiving@msi.example', address: 'West Sacramento, CA' },
];

const DEMO_USERS = [
  { email: 'staff@gblogix.com', name: 'GB Staff', role: 'staff' },
  { email: 'customer@unlockt.example', name: 'Unlockt Brands (demo)', role: 'customer', company: 'unlockt' },
  { email: 'agent@kukmin.example', name: '국민해운 (demo)', role: 'agent', company: 'kukmin' },
  { email: 'agent@zhejiang.example', name: 'Zhejiang (demo)', role: 'agent', company: 'zhejiang' },
  { email: 'broker@ohmycustoms.example', name: 'OMC (demo)', role: 'broker', company: 'omc' },
  { email: 'dispatch@ctc.example', name: 'CTC (demo)', role: 'trucker', company: 'ctc' },
  { email: 'customer@leepop.example', name: 'LEEPOP (demo)', role: 'customer', company: 'leepop' },
];

function day(offset) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
}

function seedDemo(db = store.db) {
  bootstrap(db);
  const ids = {};
  for (const p of DEMO_PARTIES) {
    const existing = db.get('SELECT id FROM companies WHERE name = ?', p.name);
    ids[p.key] = existing ? existing.id
      : Number(db.run('INSERT INTO companies (name, type, country, emails, address) VALUES (?, ?, ?, ?, ?)', p.name, p.type, p.country, p.emails, p.address || null).lastInsertRowid);
  }
  for (const u of DEMO_USERS) {
    if (db.get('SELECT 1 FROM users WHERE email = ?', u.email)) continue;
    db.run('INSERT INTO users (email, name, role, company_id, password_hash) VALUES (?, ?, ?, ?, ?)',
      u.email, u.name, u.role, u.company ? ids[u.company] : null, auth.hashPassword('demo1234'));
  }
  if (db.get('SELECT COUNT(*) AS n FROM shipments').n > 0) return ids;

  const shipments = [
    {
      mode: 'FCL', origin_country: 'KR', status: 'IN_TRANSIT', customer_id: ids.unlockt, agent_id: ids.kukmin, broker_id: ids.omc,
      trucker_id: ids.ctc, delivery_company_id: ids.ubwh, shipper_name: 'Hanil Cosmetics Co., Ltd.', consignee_name: 'Unlockt Brands',
      mbl_no: 'HDMUPUSA1234567', hbl_no: 'KMHB2409001', carrier: 'HMM', vessel: 'HMM ALGECIRAS', voyage: '045E',
      pol: 'BUSAN, KOREA', pod: 'LOS ANGELES, CA', place_of_delivery: 'ONTARIO, CA', etd: day(-9), eta: day(5),
      packages: 1240, package_unit: 'CTNS', weight_kg: 11840, cbm: 58.2, commodity: 'COSMETICS (SKIN CARE)',
      delivery_address: 'Unlockt Brands DC, 1200 E Francis St, Ontario, CA 91761', customs_status: 'FILED', isf_filed: 1,
      service_price: 450, invoice_amount: 3850, invoice_no: 'GBL-INV-1001',
      containers: [{ container_no: 'TCLU1234567', seal_no: 'HD778812', size_type: '40HC', packages: 1240, weight_kg: 11840, cbm: 58.2 }],
      items: [
        { po_no: 'PO-5521', description: 'Hydrating Toner 200ml', quantity: 14400, unit: 'PCS', packages: 600 },
        { po_no: 'PO-5521', description: 'Vitamin C Serum 30ml', quantity: 19200, unit: 'PCS', packages: 400 },
        { po_no: 'PO-5522', description: 'Sheet Mask (10pk)', quantity: 4800, unit: 'BOX', packages: 240 },
      ],
    },
    {
      mode: 'LCL', origin_country: 'KR', status: 'ARRIVED', customer_id: ids.unlockt, agent_id: ids.kukmin, broker_id: ids.solvenza,
      trucker_id: ids.ctc, delivery_company_id: ids.nextrade, shipper_name: 'Daehan Living Co.', consignee_name: 'Unlockt Brands',
      mbl_no: 'ONEYSELA0098812', hbl_no: 'KMHB2409014', carrier: 'ONE', vessel: 'ONE HARMONY', voyage: '112E',
      pol: 'BUSAN, KOREA', pod: 'LONG BEACH, CA', cfs_location: 'Pacific CFS, Carson CA', etd: day(-17), eta: day(-2), ata: day(-2),
      packages: 36, package_unit: 'PLTS', weight_kg: 5210, cbm: 21.4, commodity: 'HOUSEHOLD GOODS',
      delivery_address: 'Nextrade Warehouse, Los Angeles, CA', delivery_date: day(2), delivery_time: '10:00',
      customs_status: 'EXAM', isf_filed: 1, service_price: 380,
      containers: [{ container_no: 'MSKU7654321', seal_no: 'ML2231', size_type: '40GP' }],
      items: [{ po_no: 'PO-7710', description: 'Stainless Tumbler 500ml', quantity: 9000, unit: 'PCS', packages: 20 },
        { po_no: 'PO-7711', description: 'Kitchen Organizer Set', quantity: 3200, unit: 'SET', packages: 16 }],
    },
    {
      mode: 'AIR', origin_country: 'CN', status: 'BOOKED', customer_id: ids.pgp, agent_id: ids.zhejiang, broker_id: ids.opulen,
      trucker_id: ids.ctc, shipper_name: 'Ningbo Smart Electronics', consignee_name: 'Pacific Global Partners',
      mbl_no: '180-12345675', hbl_no: 'ZJHA0917', flight_no: 'KE 208', pol: 'PVG', pod: 'LAX', etd: day(3), eta: day(4),
      packages: 42, package_unit: 'CTNS', weight_kg: 612, chargeable_weight: 780, cbm: 4.68, commodity: 'BLUETOOTH SPEAKERS',
      delivery_address: 'Pacific Global Partners, 2100 E Grand Ave, El Segundo, CA', customs_status: 'PENDING', service_price: 275,
      items: [{ po_no: 'PGP-331', description: 'Bluetooth Speaker Model S2', quantity: 840, unit: 'PCS', packages: 42 }],
    },
    {
      mode: 'FCL', origin_country: 'CN', status: 'ARRIVED', customer_id: ids.leepop, agent_id: ids.zhejiang, broker_id: ids.ian,
      trucker_id: ids.ctc, delivery_company_id: ids.nextrade, shipper_name: 'MTWO IMPORT AND EXPORT CO', consignee_name: 'LEEPOP COMPANY LLC',
      notify_party: 'REKO FREIGHT LLC', mbl_no: 'CMDUSHZ8105615', hbl_no: 'TWS26050088', scac: 'CMDU', carrier: 'CMA CGM',
      vessel: 'CMA CGM SYRACUSE', voyage: '0P511W1MA', pol: 'YANTIAN, CN', pod: 'LOS ANGELES, CA', cfs_location: 'Fenix Marine Terminal',
      etd: day(-17), eta: day(-1), ata: day(-1), last_free_day: day(2), packages: 714, package_unit: 'CTNS', weight_kg: 9800, cbm: 66,
      commodity: 'FABRIC COASTERS, PORTABLE FANS', delivery_address: 'Nextrade, South Gate, CA', customs_status: 'FILED', isf_filed: 1,
      telex_release: 1, entry_no: '8TV-2703851-3', holds: 'Freight/BL hold', service_price: 650,
      containers: [{ container_no: 'EWLU7068201', size_type: '40HC' }],
      items: [{ po_no: '', description: 'Fabric Coaster', quantity: 49500, unit: 'PCS', packages: 219 },
        { po_no: '', description: 'Portable Mini Fan', quantity: 9900, unit: 'PCS', packages: 495 }],
    },
    {
      mode: 'AIR', origin_country: 'CN', status: 'ARRIVED', customer_id: ids.leepop, agent_id: ids.zhejiang, broker_id: ids.ian,
      trucker_id: ids.qtrans, delivery_company_id: ids.msi, shipper_name: 'SHENZHEN YOUYUE TECHNOLOGY', consignee_name: 'LEEPOP COMPANY LLC',
      notify_party: 'REKO FREIGHT LLC', mbl_no: '921-63150570', direct_shipment: 1, carrier: 'SF Airlines', flight_no: 'O3 221',
      pol: 'SZX', pod: 'LAX', cfs_location: 'CES — Custom Goods, 5220 W. 102nd St, Los Angeles', firms_code: 'Z955', css_no: '77286',
      etd: day(-3), eta: day(-2), ata: day(-2), last_free_day: day(0), packages: 46, package_unit: 'CTNS', weight_kg: 612, chargeable_weight: 780,
      commodity: 'BEANIES', customs_status: 'EXAM', holds: '1H (exam), Lien', entry_no: '8TV-2704866-0', freight_paid: 1, pallets: 4,
      delivery_address: 'MSI, West Sacramento, CA', service_price: 300,
      items: [{ po_no: '', description: 'Knit Beanie', quantity: 4600, unit: 'PCS', packages: 46 }],
    },
  ];
  for (const { containers, items, ...s } of shipments) {
    const id = S.create(s, { db });
    const body = {
      ctn_no: containers?.map((c) => c.container_no) || [], ctn_seal: containers?.map((c) => c.seal_no) || [],
      ctn_size: containers?.map((c) => c.size_type) || [], ctn_pkgs: containers?.map((c) => c.packages) || [],
      ctn_kg: containers?.map((c) => c.weight_kg) || [], ctn_cbm: containers?.map((c) => c.cbm) || [],
      item_po: items.map((i) => i.po_no || ''), item_desc: items.map((i) => i.description), item_hs: items.map(() => ''),
      item_qty: items.map((i) => i.quantity), item_unit: items.map((i) => i.unit), item_pkgs: items.map((i) => i.packages),
      item_kg: items.map(() => ''), item_cbm: items.map(() => ''),
    };
    S.saveLines(id, body, { db });
    S.addEvent(id, 'STATUS', `Status: ${S.statusLabel(s.status)}`, { db });
  }
  return ids;
}

if (require.main === module) {
  if (process.argv.includes('--demo')) {
    seedDemo();
    console.log('Demo data loaded. Demo users (password "demo1234"):');
    for (const u of DEMO_USERS) console.log(`  ${u.role.padEnd(9)} ${u.email}`);
  } else {
    bootstrap();
    console.log('Bootstrap complete. Use `npm run seed -- --demo` to load demo data.');
  }
}

module.exports = { bootstrap, seedDemo };
