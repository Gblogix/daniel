// Clearance & release checklist: air → one "Import Service Fee paid" step right before airline release;
// FCL → PierPass / CTF before release (not LCL — the CFS handles it).
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../src/shipments');

const keys = (s) => S.checklist(s).map((x) => x.key);

test('air: a single Import Service Fee step, right above airline / terminal released', () => {
  const steps = S.checklist({ mode: 'AIR', freight_paid: 1 });
  const k = steps.map((x) => x.key);
  assert.equal(k.filter((x) => x === 'freight').length, 1);
  assert.equal(k[k.indexOf('release') - 1], 'freight');
  assert.equal(steps.find((x) => x.key === 'freight').label, 'Import Service Fee paid');
  assert.equal(steps.find((x) => x.key === 'freight').done, true);
  assert.ok(!steps.some((x) => /ISC|airline charges/i.test(x.label)));
  assert.ok(!k.includes('pierpass'));
});

test('PierPass / CTF only on FCL, right above carrier & terminal released', () => {
  const k = keys({ mode: 'FCL' });
  assert.equal(k[k.indexOf('release') - 1], 'pierpass');
  assert.ok(k.indexOf('freight') < k.indexOf('customs'), 'ocean freight step stays where it was');
  assert.ok(!keys({ mode: 'LCL' }).includes('pierpass'));
  assert.equal(S.checklist({ mode: 'FCL', pierpass_paid: 1 }).find((x) => x.key === 'pierpass').done, true);
});
