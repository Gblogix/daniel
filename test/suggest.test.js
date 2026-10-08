// Type-ahead suggestions from values used on earlier files (made-up values).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gbl-sg-'));
const store = require('../src/db');
store.db = store.open(':memory:');
const db = store.db;
const S = require('../src/shipments');
const { suggest, FIELDS } = require('../src/suggest');

test('suggests earlier values: starts-with first, then most used; whitelisted fields only', () => {
  S.create({ mode: 'FCL', hbl_no: 'SG-1', pol: 'SHANGHAI, CHINA', pod: 'LONG BEACH, CA', carrier: 'SAMPLE LINES' });
  S.create({ mode: 'FCL', hbl_no: 'SG-2', pol: 'SHANGHAI, CHINA', pod: 'LOS ANGELES, CA' });
  S.create({ mode: 'FCL', hbl_no: 'SG-3', pol: 'NINGBO, CHINA (VIA SHANGHAI)', pod: 'LONG BEACH, CA' });
  assert.deepEqual(suggest('pol', 'shang'), ['SHANGHAI, CHINA', 'NINGBO, CHINA (VIA SHANGHAI)']);
  assert.deepEqual(suggest('pod', 'lo'), ['LONG BEACH, CA', 'LOS ANGELES, CA']);
  assert.deepEqual(suggest('carrier', 'sam'), ['SAMPLE LINES']);
  assert.deepEqual(suggest('password_hash', 'a'), []);
  assert.deepEqual(suggest('pol', ''), []);
  assert.ok(suggest('l_desc', 'freight').length > 0, 'charge names are suggested even before any invoice');
  assert.deepEqual(suggest('pol', '%'), [], 'LIKE wildcards are literal');
  for (const f of Object.keys(FIELDS)) assert.doesNotThrow(() => suggest(f, 'x'), f);
});
