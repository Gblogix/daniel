// Clearance & release checklist: air → Import Service Fee before airline release; ocean → PierPass / CTF before release.
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../src/shipments');

const keys = (s) => S.checklist(s).map((x) => x.key);

test('air: Import Service Fee paid sits right above airline / terminal released', () => {
  const k = keys({ mode: 'AIR' });
  assert.equal(k[k.indexOf('release') - 1], 'isc');
  assert.ok(!k.includes('pierpass'));
  assert.equal(S.checklist({ mode: 'AIR', isc_paid: 1 }).find((x) => x.key === 'isc').done, true);
});

test('ocean: PierPass / CTF paid sits right above carrier & terminal released', () => {
  for (const mode of ['FCL', 'LCL']) {
    const k = keys({ mode });
    assert.equal(k[k.indexOf('release') - 1], 'pierpass', mode);
    assert.ok(!k.includes('isc'));
  }
  assert.equal(S.checklist({ mode: 'FCL', pierpass_paid: 1 }).find((x) => x.key === 'pierpass').label, 'PierPass / CTF paid');
});
